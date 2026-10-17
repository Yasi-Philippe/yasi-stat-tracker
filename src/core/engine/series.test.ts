import { describe, expect, it } from 'vitest';
import {
  bucketize,
  bucketLabel,
  bucketStart,
  clip,
  combine,
  daily,
  dateFn,
  ema,
  emptySeries,
  fromArrays,
  fromPoints,
  interp,
  mapValue,
  nextBucket,
  reduce,
  rolling,
  scalar,
  valueAt,
} from './series';
import { asNumber, asSeries, d, pts } from './testkit';
import type { Value } from './types';

const add = (xs: number[]): number => xs[0] + xs[1];
const series = (points: Array<[string, number]>, step = false, before?: number) =>
  fromPoints(
    points.map(([iso, v]) => [d(iso), v]),
    step,
    before,
  );

describe('construction', () => {
  it('sorts, keeps the last value per day and drops non-finite values', () => {
    const s = fromArrays([d('2024-01-03'), d('2024-01-01'), d('2024-01-03'), d('2024-01-02')], [3, 1, 33, NaN]);
    expect(pts(s)).toEqual([
      ['2024-01-01', 1],
      ['2024-01-03', 33],
    ]);
  });

  it('only keeps `before` on step series, and only when finite', () => {
    expect(fromPoints([], true, 0).before).toBe(0);
    expect(fromPoints([], false, 0).before).toBeUndefined();
    expect(fromPoints([], true, Infinity).before).toBeUndefined();
  });

  it('turns non-finite scalars into NaN', () => {
    expect(scalar(Infinity).value).toBeNaN();
    expect(scalar(-Infinity).value).toBeNaN();
    expect(scalar(2).value).toBe(2);
  });
});

describe('valueAt and clip', () => {
  const step = series([['2024-01-10', 5], ['2024-01-20', 7]], true);

  it('reads the value in force for step series and exact days otherwise', () => {
    expect(valueAt(step, d('2024-01-09'))).toBeNaN();
    expect(valueAt(step, d('2024-01-10'))).toBe(5);
    expect(valueAt(step, d('2024-01-19'))).toBe(5);
    expect(valueAt(step, d('2030-01-01'))).toBe(7);
    expect(valueAt(series([['2024-01-10', 5]], true, 0), d('2020-01-01'))).toBe(0);
    const loose = series([['2024-01-10', 5]]);
    expect(valueAt(loose, d('2024-01-10'))).toBe(5);
    expect(valueAt(loose, d('2024-01-11'))).toBeNaN();
  });

  it('clips non-step series to the inclusive range', () => {
    const s = series([['2024-01-01', 1], ['2024-01-02', 2], ['2024-01-03', 3], ['2024-01-04', 4]]);
    expect(pts(clip(s, d('2024-01-02'), d('2024-01-03')))).toEqual([
      ['2024-01-02', 2],
      ['2024-01-03', 3],
    ]);
    expect(pts(clip(s, d('2025-01-01'), d('2025-12-31')))).toEqual([]);
    expect(pts(clip(s, d('2024-01-03'), d('2024-01-02')))).toEqual([]);
  });

  it('inserts the value in force on `from` for step series', () => {
    const c = clip(step, d('2024-01-15'), d('2024-01-31'));
    expect(c.step).toBe(true);
    expect(pts(c)).toEqual([
      ['2024-01-15', 5],
      ['2024-01-20', 7],
    ]);
    // No duplicate when a point falls exactly on `from`.
    expect(pts(clip(step, d('2024-01-20'), d('2024-01-31')))).toEqual([['2024-01-20', 7]]);
    // Nothing to insert before the first point.
    expect(pts(clip(step, d('2024-01-01'), d('2024-01-12')))).toEqual([['2024-01-10', 5]]);
    // A range after the last point still gets the value in force.
    expect(pts(clip(step, d('2025-01-01'), d('2025-01-31')))).toEqual([['2025-01-01', 7]]);
  });

  it('uses `before` as the value in force and drops it from the result', () => {
    const filled = series([['2024-01-10', 5]], true, 0);
    const c = clip(filled, d('2024-01-01'), d('2024-01-31'));
    expect(pts(c)).toEqual([
      ['2024-01-01', 0],
      ['2024-01-10', 5],
    ]);
    expect(c.before).toBeUndefined();
  });
});

describe('mapValue', () => {
  it('maps scalars, date functions and series, including `before`', () => {
    expect(asNumber(mapValue(scalar(3), (x) => x * 2))).toBe(6);
    const fn = mapValue(
      dateFn((day) => day),
      (x) => x + 1,
    );
    expect(fn.kind === 'fn' && fn.at(10)).toBe(11);
    const s = asSeries(mapValue(series([['2024-01-10', 4]], true, 2), (x) => x * 10));
    expect(pts(s)).toEqual([['2024-01-10', 40]]);
    expect(s.step).toBe(true);
    expect(s.before).toBe(20);
  });

  it('drops points whose result is not finite', () => {
    const s = series([['2024-01-01', 2], ['2024-01-02', 0], ['2024-01-03', 4]]);
    expect(pts(mapValue(s, (x) => 1 / x))).toEqual([
      ['2024-01-01', 0.5],
      ['2024-01-03', 0.25],
    ]);
    expect(asNumber(mapValue(scalar(0), (x) => 1 / x))).toBeNaN();
  });
});

describe('combine: alignment rules', () => {
  const a = series([['2024-01-01', 1], ['2024-01-02', 2], ['2024-01-04', 4]]);
  const b = series([['2024-01-02', 20], ['2024-01-03', 30], ['2024-01-04', 40]]);
  const stepA = series([['2024-01-02', 100], ['2024-01-05', 200]], true);
  const stepB = series([['2024-01-03', 1000], ['2024-01-04', 2000]], true);

  it('scalar with scalar gives a scalar, NaN propagates', () => {
    expect(asNumber(combine([scalar(2), scalar(3)], add))).toBe(5);
    expect(asNumber(combine([scalar(NaN), scalar(3)], add))).toBeNaN();
  });

  it('scalar with series maps over it, keeping step and `before`', () => {
    const r = asSeries(combine([scalar(1), series([['2024-01-01', 5]], true, 0)], add));
    expect(pts(r)).toEqual([['2024-01-01', 6]]);
    expect(r.step).toBe(true);
    expect(r.before).toBe(1);
    expect(pts(combine([a, scalar(10)], add))).toEqual([
      ['2024-01-01', 11],
      ['2024-01-02', 12],
      ['2024-01-04', 14],
    ]);
  });

  it('non-step with non-step is an inner join on equal days', () => {
    const r = asSeries(combine([a, b], add));
    expect(r.step).toBe(false);
    expect(pts(r)).toEqual([
      ['2024-01-02', 22],
      ['2024-01-04', 44],
    ]);
  });

  it('non-step with step reads the step value in force on each non-step day', () => {
    const r = asSeries(combine([a, stepA], add));
    expect(r.step).toBe(false);
    // 2024-01-01 is before the first step point, so it has no value.
    expect(pts(r)).toEqual([
      ['2024-01-02', 102],
      ['2024-01-04', 104],
    ]);
    // Operand order is kept.
    expect(pts(combine([stepA, a], (xs) => xs[0] - xs[1]))).toEqual([
      ['2024-01-02', 98],
      ['2024-01-04', 96],
    ]);
  });

  it('a step series with `before` is defined on every day', () => {
    const withBefore = series([['2024-01-02', 100]], true, 0);
    expect(pts(combine([a, withBefore], add))).toEqual([
      ['2024-01-01', 1],
      ['2024-01-02', 102],
      ['2024-01-04', 104],
    ]);
  });

  it('step with step is a step series over the union of change days where both exist', () => {
    const r = asSeries(combine([stepA, stepB], add));
    expect(r.step).toBe(true);
    expect(pts(r)).toEqual([
      ['2024-01-03', 1100],
      ['2024-01-04', 2100],
      ['2024-01-05', 2200],
    ]);
    expect(r.before).toBeUndefined();
  });

  it('step with step keeps `before` only when both have one', () => {
    const x = series([['2024-01-02', 100]], true, 1);
    const y = series([['2024-01-03', 1000]], true, 2);
    const both = asSeries(combine([x, y], add));
    expect(both.before).toBe(3);
    expect(pts(both)).toEqual([
      ['2024-01-02', 102],
      ['2024-01-03', 1100],
    ]);
    const one = asSeries(combine([x, stepB], add));
    expect(one.before).toBeUndefined();
    expect(pts(one)).toEqual([
      ['2024-01-03', 1100],
      ['2024-01-04', 2100],
    ]);
  });

  it('an empty step series with `before` acts as a constant', () => {
    const zero = emptySeries(true, 0);
    const r = asSeries(combine([stepA, zero], add));
    expect(pts(r)).toEqual([
      ['2024-01-02', 100],
      ['2024-01-05', 200],
    ]);
    expect(r.step).toBe(true);
    const alone = asSeries(combine([zero, scalar(5)], add));
    expect(pts(alone)).toEqual([]);
    expect(alone.before).toBe(5);
  });

  it('series with a date function is sampled on the series days and is non-step', () => {
    const days = dateFn((day) => day - d('2024-01-01'));
    expect(pts(combine([a, days], add))).toEqual([
      ['2024-01-01', 1],
      ['2024-01-02', 3],
      ['2024-01-04', 7],
    ]);
    const r = asSeries(combine([stepA, days], add));
    expect(r.step).toBe(false);
    // Only on the change days of the step series.
    expect(pts(r)).toEqual([
      ['2024-01-02', 101],
      ['2024-01-05', 204],
    ]);
  });

  it('date functions with date functions or scalars stay date functions', () => {
    const f = combine([dateFn((day) => day), dateFn((day) => day * 2)], add);
    expect(f.kind).toBe('fn');
    expect(f.kind === 'fn' && f.at(10)).toBe(30);
    const g = combine([dateFn((day) => day), scalar(1)], add);
    expect(g.kind === 'fn' && g.at(10)).toBe(11);
  });

  it('aligns any number of arguments with the same rules', () => {
    const three = (xs: number[]): number => xs[0] + xs[1] + xs[2];
    expect(pts(combine([a, stepA, scalar(1000)], three))).toEqual([
      ['2024-01-02', 1102],
      ['2024-01-04', 1104],
    ]);
    expect(pts(combine([a, b, stepA], three))).toEqual([
      ['2024-01-02', 122],
      ['2024-01-04', 144],
    ]);
    const steps = asSeries(combine([stepA, stepB, scalar(1)], three));
    expect(steps.step).toBe(true);
    expect(pts(steps)).toEqual([
      ['2024-01-03', 1101],
      ['2024-01-04', 2101],
      ['2024-01-05', 2201],
    ]);
  });

  it('drops points whose result is not finite', () => {
    const den = series([['2024-01-01', 2], ['2024-01-02', 0], ['2024-01-04', 4]]);
    expect(pts(combine([a, den], (xs) => xs[0] / xs[1]))).toEqual([
      ['2024-01-01', 0.5],
      ['2024-01-04', 1],
    ]);
  });
});

describe('resampling', () => {
  it('daily expands to every day until today, holding values', () => {
    const s = series([['2024-01-01', 1], ['2024-01-03', 3]]);
    const r = daily(s, d('2024-01-05'), null);
    expect(r.step).toBe(true);
    expect(pts(r)).toEqual([
      ['2024-01-01', 1],
      ['2024-01-02', 1],
      ['2024-01-03', 3],
      ['2024-01-04', 3],
      ['2024-01-05', 3],
    ]);
  });

  it('daily goes past today when the last point is later, and respects a range', () => {
    const s = series([['2024-01-01', 1], ['2024-01-04', 4]], true, 0);
    expect(pts(daily(s, d('2024-01-02'), null)).map((p) => p[0])).toEqual([
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
      '2024-01-04',
    ]);
    const r = daily(s, d('2024-12-31'), { from: d('2024-01-02'), to: d('2024-01-05') });
    expect(pts(r)).toEqual([
      ['2024-01-02', 1],
      ['2024-01-03', 1],
      ['2024-01-04', 4],
      ['2024-01-05', 4],
    ]);
    expect(r.before).toBe(0);
    expect(pts(daily(emptySeries(), d('2024-01-01'), null))).toEqual([]);
  });

  it('interp draws straight lines between points', () => {
    const s = series([['2024-01-01', 0], ['2024-01-05', 8], ['2024-01-06', 6]]);
    expect(pts(interp(s))).toEqual([
      ['2024-01-01', 0],
      ['2024-01-02', 2],
      ['2024-01-03', 4],
      ['2024-01-04', 6],
      ['2024-01-05', 8],
      ['2024-01-06', 6],
    ]);
    expect(interp(s).step).toBe(false);
    expect(pts(interp(emptySeries()))).toEqual([]);
  });
});

describe('reducers', () => {
  const v = Float64Array.of(4, 1, 3, 2);
  it.each([
    ['first', 4],
    ['last', 2],
    ['sum', 10],
    ['mean', 2.5],
    ['median', 2.5],
    ['min', 1],
    ['max', 4],
    ['delta', -2],
    ['count', 4],
  ] as const)('%s', (r, expected) => {
    expect(reduce(v, r)).toBe(expected);
  });

  it('handles odd medians, standard deviation and empty input', () => {
    expect(reduce(Float64Array.of(5, 1, 3), 'median')).toBe(3);
    expect(reduce(Float64Array.of(2, 4, 4, 4, 5, 5, 7, 9), 'stdev')).toBeCloseTo(2.13809, 4);
    expect(reduce(Float64Array.of(1), 'stdev')).toBeNaN();
    expect(reduce(new Float64Array(0), 'mean')).toBeNaN();
    expect(reduce(new Float64Array(0), 'count')).toBe(0);
  });

  it('does not reorder its input when computing a median', () => {
    const input = Float64Array.of(3, 1, 2);
    reduce(input, 'median');
    expect(Array.from(input)).toEqual([3, 1, 2]);
  });
});

describe('rolling windows', () => {
  // Gaps on purpose: the window is in calendar days, not in points.
  const s = series([
    ['2024-01-01', 1],
    ['2024-01-02', 5],
    ['2024-01-03', 3],
    ['2024-01-06', 10],
    ['2024-01-07', 2],
  ]);

  it.each([
    ['mean', [1, 3, 3, 10, 6]],
    ['sum', [1, 6, 9, 10, 12]],
    ['median', [1, 3, 3, 10, 6]],
    ['min', [1, 1, 1, 10, 2]],
    ['max', [1, 5, 5, 10, 10]],
    ['first', [1, 1, 1, 10, 10]],
    ['last', [1, 5, 3, 10, 2]],
    ['delta', [0, 4, 2, 0, -8]],
    ['count', [1, 2, 3, 1, 2]],
  ] as const)('3-day %s', (r, expected) => {
    const out = rolling(s, 3, r);
    expect(Array.from(out.t)).toEqual(Array.from(s.t));
    expect(Array.from(out.v)).toEqual(expected);
  });

  it('matches a brute-force window with repeated values and gaps', () => {
    const start = d('2024-02-01');
    const days = Array.from({ length: 60 }, (_, i) => start + i).filter((day) => day % 5 !== 0);
    const long = fromPoints(days.map((day, i): [number, number] => [day, (i * 7) % 4]));
    for (const r of ['median', 'min', 'max', 'mean', 'sum'] as const) {
      const out = rolling(long, 7, r);
      for (let i = 0; i < long.t.length; i++) {
        const window = Array.from(long.v.filter((_, j) => j <= i && long.t[j] > long.t[i] - 7));
        expect(out.v[i]).toBeCloseTo(reduce(Float64Array.from(window), r), 12);
      }
    }
  });

  it('keeps the step flag', () => {
    expect(rolling(series([['2024-01-01', 1]], true, 0), 3, 'mean').step).toBe(true);
  });

  it('ema weighs recent points more', () => {
    const e = ema(series([['2024-01-01', 10], ['2024-01-02', 20], ['2024-01-09', 20]]), 3);
    // alpha = 0.5
    expect(Array.from(e.v)).toEqual([10, 15, 17.5]);
  });
});

describe('calendar buckets', () => {
  it('finds bucket starts, the next bucket and labels', () => {
    const day = d('2026-10-11'); // a Sunday
    expect(bucketStart(day, 'week')).toBe(d('2026-10-05'));
    expect(bucketStart(day, 'month')).toBe(d('2026-10-01'));
    expect(bucketStart(day, 'quarter')).toBe(d('2026-10-01'));
    expect(bucketStart(d('2026-05-20'), 'quarter')).toBe(d('2026-04-01'));
    expect(bucketStart(day, 'year')).toBe(d('2026-01-01'));
    expect(nextBucket(d('2026-10-05'), 'week')).toBe(d('2026-10-12'));
    expect(nextBucket(d('2026-12-01'), 'month')).toBe(d('2027-01-01'));
    expect(nextBucket(d('2026-10-01'), 'quarter')).toBe(d('2027-01-01'));
    expect(nextBucket(d('2026-01-01'), 'year')).toBe(d('2027-01-01'));
    expect(bucketLabel(d('2026-10-05'), 'week')).toBe('2026-10-05');
    expect(bucketLabel(d('2026-10-01'), 'month')).toBe('2026-10');
    expect(bucketLabel(d('2026-04-01'), 'quarter')).toBe('2026-Q2');
    expect(bucketLabel(d('2026-01-01'), 'year')).toBe('2026');
  });

  it('reduces non-step points per bucket, skipping empty buckets', () => {
    const s = series([
      ['2024-01-05', 1],
      ['2024-01-20', 3],
      ['2024-03-02', 10],
    ]);
    expect(pts(bucketize(s, 'month', 'sum'))).toEqual([
      ['2024-01-01', 4],
      ['2024-03-01', 10],
    ]);
    expect(pts(bucketize(s, 'month', 'last'))).toEqual([
      ['2024-01-01', 3],
      ['2024-03-01', 10],
    ]);
  });

  it('counts the value in force at the start of each bucket for step series', () => {
    const s = series([['2024-01-05', 1], ['2024-01-20', 3], ['2024-03-02', 10]], true);
    const r = bucketize(s, 'month', 'first');
    expect(r.step).toBe(false);
    expect(pts(r)).toEqual([
      ['2024-01-01', 1],
      ['2024-02-01', 3],
      ['2024-03-01', 3],
    ]);
    expect(pts(bucketize(s, 'month', 'delta'))).toEqual([
      ['2024-01-01', 2],
      ['2024-02-01', 0],
      ['2024-03-01', 7],
    ]);
    const filled = series([['2024-01-05', 1]], true, 0);
    expect(pts(bucketize(filled, 'month', 'first'))).toEqual([['2024-01-01', 0]]);
  });

  it('dates weekly buckets on Mondays', () => {
    const s = series([
      ['2026-10-04', 1], // Sunday
      ['2026-10-05', 2], // Monday
      ['2026-10-11', 3], // Sunday
    ]);
    expect(pts(bucketize(s, 'week', 'mean'))).toEqual([
      ['2026-09-28', 1],
      ['2026-10-05', 2.5],
    ]);
  });
});

describe('values are never mutated', () => {
  it('leaves inputs untouched', () => {
    const s = series([['2024-01-01', 3], ['2024-01-02', 1], ['2024-01-03', 2]], true, 0);
    const copy = { t: Array.from(s.t), v: Array.from(s.v), before: s.before };
    const ops: Array<() => Value> = [
      () => clip(s, d('2024-01-02'), d('2024-01-03')),
      () => mapValue(s, (x) => -x),
      () => combine([s, s], add),
      () => rolling(s, 2, 'median'),
      () => bucketize(s, 'month', 'median'),
      () => daily(s, d('2024-01-10'), null),
    ];
    for (const op of ops) op();
    expect({ t: Array.from(s.t), v: Array.from(s.v), before: s.before }).toEqual(copy);
  });
});
