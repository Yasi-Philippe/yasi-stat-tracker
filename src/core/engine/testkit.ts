/**
 * Helpers for the engine tests: an in-memory DataSource built from made-up
 * data, and a seeded random generator so synthetic data is reproducible.
 */

import { fromDayNum, toDayNum, type DayNum } from '../model/dates';
import type { Cadence, Fill, FormulaDef, MetricDef, Period, PeriodSet } from '../model/types';
import type { DataSource, Series, Value } from './types';

/** Day number of an ISO date. */
export const d = (iso: string): DayNum => toDayNum(iso);

export type Points = Array<[string | DayNum, number]>;

export interface MetricInput {
  slug: string;
  points?: Points;
  fill?: Fill;
  cadence?: Cadence;
  name?: string;
  unit?: string;
}

export interface SourceInput {
  metrics?: MetricInput[];
  /** Formulas as { slug: expr }. */
  formulas?: Record<string, string>;
  periodSets?: PeriodSet[];
  periods?: Period[];
  today?: string;
}

export interface TestSource extends DataSource {
  /** How many times entries() was called, per metric id. */
  calls: Map<string, number>;
}

export function makeSource(input: SourceInput): TestSource {
  const metrics: MetricDef[] = [];
  const data = new Map<string, { t: Int32Array; v: Float64Array }>();
  (input.metrics ?? []).forEach((m, i) => {
    const id = `m-${m.slug}`;
    metrics.push({
      id,
      slug: m.slug,
      name: m.name ?? m.slug,
      unit: m.unit ?? '',
      cadence: m.cadence ?? (m.fill === 'step' ? 'sparse' : 'daily'),
      fill: m.fill ?? 'none',
      decimals: 2,
      step: 1,
      order: i,
    });
    const pts = (m.points ?? []).map(([day, v]): [DayNum, number] => [typeof day === 'string' ? d(day) : day, v]);
    pts.sort((a, b) => a[0] - b[0]);
    data.set(id, { t: Int32Array.from(pts.map((p) => p[0])), v: Float64Array.from(pts.map((p) => p[1])) });
  });
  const formulas: FormulaDef[] = Object.entries(input.formulas ?? {}).map(([slug, expr], i) => ({
    id: `f-${slug}`,
    slug,
    name: slug,
    unit: '',
    expr,
    decimals: 2,
    order: i,
  }));
  const calls = new Map<string, number>();
  return {
    metrics,
    formulas,
    periodSets: input.periodSets ?? [],
    periods: input.periods ?? [],
    today: d(input.today ?? '2026-10-11'),
    calls,
    entries(metricId) {
      calls.set(metricId, (calls.get(metricId) ?? 0) + 1);
      return data.get(metricId) ?? { t: new Int32Array(0), v: new Float64Array(0) };
    },
  };
}

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random walk with one point per day from `from` to `to` (inclusive),
 * skipping each day with probability `skip`. Values are rounded to cents.
 */
export function walk(
  random: () => number,
  from: DayNum,
  to: DayNum,
  start: number,
  opts: { drift?: number; noise?: number; skip?: number } = {},
): Array<[DayNum, number]> {
  const { drift = 0, noise = 1, skip = 0 } = opts;
  const out: Array<[DayNum, number]> = [];
  let value = start;
  for (let day = from; day <= to; day++) {
    value += drift + (random() - 0.5) * 2 * noise;
    if (skip > 0 && random() < skip) continue;
    out.push([day, Math.round(value * 100) / 100]);
  }
  return out;
}

/** Points of a value as [ISO date, value] pairs, for readable assertions. */
export function pts(v: Value): Array<[string, number]> {
  const s = asSeries(v);
  return Array.from(s.t, (t, i) => [fromDayNum(t), s.v[i]]);
}

export function asSeries(v: Value): Series {
  if (v.kind !== 'series') throw new Error(`Expected a series, got ${v.kind}`);
  return v;
}

export function asNumber(v: Value): number {
  if (v.kind !== 'scalar') throw new Error(`Expected a scalar, got ${v.kind}`);
  return v.value;
}
