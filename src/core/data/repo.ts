/**
 * Typed access to the vault: the sandbox model on top of plain records.
 * All functions are synchronous against the in-memory vault.
 */

import { toBase64Url } from '../crypto/encoding';
import { randomBytes } from '../crypto/primitives';
import type { DataSource } from '../engine/types';
import { type DayNum, type ISODate, monthStart, toDayNum, fromDayNum } from '../model/dates';
import type {
  ChartSpec,
  Dashboard,
  Entry,
  FormulaDef,
  MetricDef,
  Period,
  PeriodSet,
  Settings,
  ThemeDef,
} from '../model/types';
import { entryKey, K } from '../vault/records';
import type { Vault } from '../vault/vault';

export function newId(): string {
  return toBase64Url(randomBytes(9));
}

const byOrder = <T extends { order: number }>(a: T, b: T) => a.order - b.order;
const values = <T>(vault: Vault, prefix: string): T[] => vault.list<T>(prefix).map(([, v]) => v);

// ---------------------------------------------------------------------------
// Metrics and entries
// ---------------------------------------------------------------------------

export function metrics(vault: Vault, opts: { includeArchived?: boolean } = {}): MetricDef[] {
  return values<MetricDef>(vault, K.metric)
    .filter((m) => opts.includeArchived || !m.archived)
    .sort(byOrder);
}

export function metric(vault: Vault, id: string): MetricDef | undefined {
  return vault.get<MetricDef>(K.metric + id);
}

export function saveMetric(vault: Vault, m: MetricDef): void {
  vault.put(K.metric + m.id, m);
}

/** Deletes a metric and all its entries. */
export function deleteMetric(vault: Vault, id: string): void {
  vault.batch(() => {
    for (const [k] of vault.list(`${K.entry}${id}/`)) vault.del(k);
    vault.del(K.metric + id);
  });
}

interface EntryValue {
  v: number;
  n?: string;
}

/** Normalises the date to the metric's cadence (monthly values live on the 1st). */
export function entryDate(m: Pick<MetricDef, 'cadence'>, date: ISODate): ISODate {
  return m.cadence === 'monthly' ? fromDayNum(monthStart(toDayNum(date))) : date;
}

export function setEntry(vault: Vault, m: MetricDef, date: ISODate, value: number, note?: string): void {
  if (!Number.isFinite(value)) throw new Error('Value must be a number');
  const factor = 10 ** Math.min(Math.max(m.decimals, 0), 10);
  const rounded = Math.round(value * factor) / factor;
  const v: EntryValue = note ? { v: rounded, n: note } : { v: rounded };
  vault.put(entryKey(m.id, entryDate(m, date)), v);
}

export function deleteEntry(vault: Vault, m: MetricDef, date: ISODate): void {
  vault.del(entryKey(m.id, entryDate(m, date)));
}

export function getEntry(vault: Vault, m: MetricDef, date: ISODate): Entry | undefined {
  const v = vault.get<EntryValue>(entryKey(m.id, entryDate(m, date)));
  return v ? { metricId: m.id, date: entryDate(m, date), value: v.v, note: v.n } : undefined;
}

export function entries(vault: Vault, metricId: string): Entry[] {
  const prefix = `${K.entry}${metricId}/`;
  return vault.list<EntryValue>(prefix).map(([k, v]) => ({
    metricId,
    date: k.slice(prefix.length),
    value: v.v,
    note: v.n,
  }));
}

/** The most recent entry on or before a date. */
export function latestEntry(vault: Vault, metricId: string, onOrBefore?: ISODate): Entry | undefined {
  const all = entries(vault, metricId);
  for (let i = all.length - 1; i >= 0; i--) if (!onOrBefore || all[i]!.date <= onOrBefore) return all[i];
  return undefined;
}

const seriesCache = new WeakMap<Vault, Map<string, { version: number; t: Int32Array; v: Float64Array }>>();

/** Entries as typed arrays for the engine, cached until the metric changes. */
export function entrySeries(vault: Vault, metricId: string): { t: Int32Array; v: Float64Array } {
  let cache = seriesCache.get(vault);
  if (!cache) seriesCache.set(vault, (cache = new Map()));
  const version = vault.metricVersion(metricId);
  const hit = cache.get(metricId);
  if (hit && hit.version === version) return hit;
  const list = entries(vault, metricId);
  const t = new Int32Array(list.length);
  const v = new Float64Array(list.length);
  list.forEach((e, i) => {
    t[i] = toDayNum(e.date);
    v[i] = e.value;
  });
  const out = { version, t, v };
  cache.set(metricId, out);
  return out;
}

// ---------------------------------------------------------------------------
// Everything else in the sandbox
// ---------------------------------------------------------------------------

export const formulas = (vault: Vault): FormulaDef[] => values<FormulaDef>(vault, K.formula).sort(byOrder);
export const saveFormula = (vault: Vault, f: FormulaDef) => vault.put(K.formula + f.id, f);
export const deleteFormula = (vault: Vault, id: string) => vault.del(K.formula + id);

export const periodSets = (vault: Vault): PeriodSet[] => values<PeriodSet>(vault, K.periodSet).sort(byOrder);
export const savePeriodSet = (vault: Vault, s: PeriodSet) => vault.put(K.periodSet + s.id, s);
export function deletePeriodSet(vault: Vault, id: string): void {
  vault.batch(() => {
    for (const p of periods(vault, id)) vault.del(K.period + p.id);
    vault.del(K.periodSet + id);
  });
}

export function periods(vault: Vault, setId?: string): Period[] {
  return values<Period>(vault, K.period)
    .filter((p) => !setId || p.setId === setId)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}
export const savePeriod = (vault: Vault, p: Period) => vault.put(K.period + p.id, p);
export const deletePeriod = (vault: Vault, id: string) => vault.del(K.period + id);

/** The running (open) period of a set, if any. */
export function openPeriod(vault: Vault, setId: string): Period | undefined {
  return periods(vault, setId).find((p) => p.end === null);
}

export const charts = (vault: Vault): ChartSpec[] => values<ChartSpec>(vault, K.chart);
export const chart = (vault: Vault, id: string) => vault.get<ChartSpec>(K.chart + id);
export const saveChart = (vault: Vault, c: ChartSpec) => vault.put(K.chart + c.id, c);
export function deleteChart(vault: Vault, id: string): void {
  vault.batch(() => {
    for (const d of dashboards(vault)) {
      if (d.items.some((i) => i.chartId === id)) saveDashboard(vault, { ...d, items: d.items.filter((i) => i.chartId !== id) });
    }
    vault.del(K.chart + id);
  });
}

export const dashboards = (vault: Vault): Dashboard[] => values<Dashboard>(vault, K.dashboard).sort(byOrder);
export const saveDashboard = (vault: Vault, d: Dashboard) => vault.put(K.dashboard + d.id, d);
export const deleteDashboard = (vault: Vault, id: string) => vault.del(K.dashboard + id);

export const customThemes = (vault: Vault): ThemeDef[] => values<ThemeDef>(vault, K.theme);
export const saveTheme = (vault: Vault, t: ThemeDef) => vault.put(K.theme + t.id, t);
export const deleteTheme = (vault: Vault, id: string) => vault.del(K.theme + id);

export const DEFAULT_SETTINGS: Settings = { themeId: 'nocturne', weekStart: 1 };

export function settings(vault: Vault): Settings {
  return { ...DEFAULT_SETTINGS, ...vault.get<Partial<Settings>>(`${K.settings}main`) };
}

export function saveSettings(vault: Vault, patch: Partial<Settings>): void {
  vault.put(`${K.settings}main`, { ...settings(vault), ...patch });
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

export const SLUG_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** "Body fat %" → "body_fat". */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(s) ? s : `m_${s}`.slice(0, 40);
}

/** Every slug in use by metrics, formulas and period sets. */
export function usedSlugs(vault: Vault, exceptId?: string): Set<string> {
  const out = new Set<string>();
  for (const m of metrics(vault, { includeArchived: true })) if (m.id !== exceptId) out.add(m.slug);
  for (const f of formulas(vault)) if (f.id !== exceptId) out.add(f.slug);
  for (const s of periodSets(vault)) if (s.id !== exceptId) out.add(s.slug);
  return out;
}

export function uniqueSlug(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const slug = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    if (!used.has(slug)) return slug;
  }
}

// ---------------------------------------------------------------------------
// Engine bridge
// ---------------------------------------------------------------------------

export function dataSource(vault: Vault, today: DayNum): DataSource {
  return {
    metrics: metrics(vault, { includeArchived: true }),
    formulas: formulas(vault),
    periodSets: periodSets(vault),
    periods: periods(vault),
    entries: (id) => entrySeries(vault, id),
    today,
  };
}

export function nextOrder(items: Array<{ order: number }>): number {
  return items.reduce((m, i) => Math.max(m, i.order), 0) + 1;
}
