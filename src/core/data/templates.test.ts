import { describe, expect, it } from 'vitest';
import { deriveDataKeys, generateDek } from '../crypto/keys';
import { evaluateChart, Workspace } from '../engine';
import { toDayNum } from '../model/dates';
import { LocalStore } from '../vault/localStore';
import { Vault } from '../vault/vault';
import { seedDemo } from './demo';
import { renameIdentifier, references, slugProblem } from './refs';
import { charts, dataSource, formulas, metrics } from './repo';
import { applyTemplate, TEMPLATES } from './templates';

async function vault() {
  return Vault.open(new LocalStore(`tpl-${Math.random()}`), await deriveDataKeys(generateDek()), { persistDelayMs: 5 });
}

const TODAY = toDayNum('2026-10-13');

describe('starter packs', () => {
  it('every pack applies twice without slug clashes, and every chart evaluates without errors', async () => {
    const v = await vault();
    for (const t of TEMPLATES) applyTemplate(v, t.id);
    for (const t of TEMPLATES) applyTemplate(v, t.id);
    const slugs = [...metrics(v, { includeArchived: true }).map((m) => m.slug), ...formulas(v).map((f) => f.slug)];
    expect(new Set(slugs).size).toBe(slugs.length);
    const src = dataSource(v, TODAY);
    const ws = new Workspace(src);
    for (const c of charts(v)) {
      const data = evaluateChart(c, ws, src);
      expect(data.errors, `${c.title}: ${JSON.stringify(data.errors)}`).toEqual([]);
    }
  });

  it('the demo data feeds every Body and Money chart', async () => {
    const v = await vault();
    seedDemo(v, TODAY);
    const src = dataSource(v, TODAY);
    const ws = new Workspace(src);
    for (const c of charts(v)) {
      const data = evaluateChart(c, ws, src);
      expect(data.errors, c.title).toEqual([]);
      const json = JSON.stringify(data);
      expect(json.length, `${c.title} should have data`).toBeGreaterThan(200);
    }
    // The independence level moves every day, not only when a parameter changes.
    const level = ws.value('independence');
    expect(level.kind).toBe('series');
    if (level.kind === 'series') expect(level.t.length).toBeGreaterThan(900);
  });
});

describe('references', () => {
  it('finds and renames identifiers outside string literals only', () => {
    expect(references('weight / (height / 100) ^ 2', 'height')).toBe(true);
    expect(references('weight_trend + 1', 'weight')).toBe(false);
    expect(references('between(x, "weight")', 'weight')).toBe(false);
    expect(renameIdentifier('ma(weight, 7) + weight_x - "weight"', 'weight', 'kg')).toBe('ma(kg, 7) + weight_x - "weight"');
  });

  it('rejects bad or reserved slugs', () => {
    expect(slugProblem('weight', new Set())).toBeNull();
    expect(slugProblem('Weight', new Set())).not.toBeNull();
    expect(slugProblem('median', new Set())).not.toBeNull();
    expect(slugProblem('bank', new Set(['bank']))).not.toBeNull();
  });
});

describe('merging metrics', () => {
  it('moves entries, keeps the target on clashes, and repoints formulas', async () => {
    const { mergeMetricInto, duplicateSlugs } = await import('./refs');
    const { getEntry, setEntry, metric: getMetric } = await import('./repo');
    const v = await vault();
    const a = applyTemplate(v, 'body');
    const b = applyTemplate(v, 'body'); // second copy: weight_2, height_2, …
    const w1 = a.metrics.find((m) => m.slug === 'weight')!;
    const w2 = b.metrics.find((m) => m.slug === 'weight_2')!;
    setEntry(v, w1, '2026-01-01', 80);
    setEntry(v, w2, '2026-01-01', 99);
    setEntry(v, w2, '2026-01-02', 79.5);
    const r = mergeMetricInto(v, w2.id, w1.id);
    expect(r).toEqual({ moved: 1, kept: 1 });
    expect(getEntry(v, w1, '2026-01-01')!.value).toBe(80);
    expect(getEntry(v, w1, '2026-01-02')!.value).toBe(79.5);
    expect(getMetric(v, w2.id)).toBeUndefined();
    expect(formulas(v).filter((f) => f.expr.includes('weight_2'))).toEqual([]);
    expect(duplicateSlugs(v)).toEqual([]);
  });
});
