/** Finding and renaming identifiers inside formulas and chart series. */

import { FUNCTION_DOCS } from '../engine';
import type { Vault } from '../vault/vault';
import { charts, deleteMetric, entries, formulas, getEntry, metric, metrics, saveChart, saveFormula, setEntry } from './repo';

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Applies fn to the parts of an expression outside "string literals". */
function mapCode(expr: string, fn: (code: string) => string): string {
  return expr
    .split(/("(?:[^"\\]|\\.)*")/)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('');
}

export function references(expr: string, slug: string): boolean {
  let found = false;
  mapCode(expr, (code) => {
    for (const m of code.matchAll(IDENT)) if (m[0] === slug) found = true;
    return code;
  });
  return found;
}

export function renameIdentifier(expr: string, from: string, to: string): string {
  return mapCode(expr, (code) => code.replace(IDENT, (w) => (w === from ? to : w)));
}

export interface Usage {
  kind: 'formula' | 'chart';
  id: string;
  name: string;
}

export function slugUsages(vault: Vault, slug: string): Usage[] {
  const out: Usage[] = [];
  for (const f of formulas(vault)) if (references(f.expr, slug)) out.push({ kind: 'formula', id: f.id, name: f.name });
  for (const c of charts(vault)) if (c.series.some((s) => references(s.expr, slug))) out.push({ kind: 'chart', id: c.id, name: c.title });
  return out;
}

/** Rewrites every formula and chart that uses `from`. Returns how many changed. */
export function renameSlugEverywhere(vault: Vault, from: string, to: string): number {
  if (from === to) return 0;
  let n = 0;
  vault.batch(() => {
    for (const f of formulas(vault)) {
      const expr = renameIdentifier(f.expr, from, to);
      if (expr !== f.expr) {
        saveFormula(vault, { ...f, expr });
        n++;
      }
    }
    for (const c of charts(vault)) {
      let changed = false;
      const series = c.series.map((s) => {
        const expr = renameIdentifier(s.expr, from, to);
        if (expr !== s.expr) changed = true;
        return { ...s, expr };
      });
      if (changed) {
        saveChart(vault, { ...c, series });
        n++;
      }
    }
  });
  return n;
}

/**
 * Moves every entry of one metric into another and deletes the first. Days
 * the target already has keep the target's value. Formulas and charts that
 * used the old name follow the target.
 */
export function mergeMetricInto(vault: Vault, fromId: string, intoId: string): { moved: number; kept: number } {
  const from = metric(vault, fromId);
  const into = metric(vault, intoId);
  if (!from || !into || from.id === into.id) throw new Error('Pick two different metrics.');
  let moved = 0;
  let kept = 0;
  vault.batch(() => {
    for (const e of entries(vault, from.id)) {
      if (getEntry(vault, into, e.date)) {
        kept++;
        continue;
      }
      setEntry(vault, into, e.date, e.value, e.note);
      moved++;
    }
    if (from.slug !== into.slug) renameSlugEverywhere(vault, from.slug, into.slug);
    deleteMetric(vault, from.id);
  });
  return { moved, kept };
}

/** Slugs used by more than one metric or formula (possible after merging two key generations). */
export function duplicateSlugs(vault: Vault): string[] {
  const seen = new Map<string, number>();
  for (const m of metrics(vault, { includeArchived: true })) seen.set(m.slug, (seen.get(m.slug) ?? 0) + 1);
  for (const f of formulas(vault)) seen.set(f.slug, (seen.get(f.slug) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([s]) => s);
}

const RESERVED = new Set(FUNCTION_DOCS.map((d) => d.name));

/** Problem with a proposed slug, or null if it is fine. */
export function slugProblem(slug: string, used: Set<string>): string | null {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(slug)) return 'Lowercase letters, digits and _ only, starting with a letter.';
  if (RESERVED.has(slug)) return `“${slug}” is a function name.`;
  if (used.has(slug)) return 'Already used by another metric, formula or period set.';
  return null;
}
