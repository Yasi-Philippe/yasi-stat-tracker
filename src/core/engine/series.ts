/**
 * Series primitives: construction, lookup, clipping to a day range, alignment
 * of several values for elementwise operations, resampling and reducers.
 *
 * Every function is pure and never mutates its inputs. Results may share
 * arrays with their inputs, so treat every series as read-only.
 */

import {
  fromDayNum,
  fromYMD,
  monthKey,
  monthStart,
  quarterStart,
  weekStart,
  yearStart,
  ymd,
  type DayNum,
} from '../model/dates';
import type { Bucket, Reducer } from '../model/types';
import type { DateFn, Scalar, Series, Value } from './types';

/** An inclusive range of days. */
export interface DayRange {
  from: DayNum;
  to: DayNum;
}

/** Reducers accepted by the bucket functions, rolling() and charts. */
export const REDUCERS: readonly Reducer[] = ['last', 'first', 'sum', 'mean', 'median', 'min', 'max', 'delta', 'count'];

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** A scalar; any non-finite number becomes NaN ("no data"). */
export function scalar(value: number): Scalar {
  return { kind: 'scalar', value: Number.isFinite(value) ? value : NaN };
}

export function dateFn(at: (day: DayNum) => number): DateFn {
  return { kind: 'fn', at };
}

/** Wraps arrays that already hold strictly ascending days and finite values. */
function wrap(t: Int32Array, v: Float64Array, step: boolean, before?: number): Series {
  const s: Series = { kind: 'series', t, v, step };
  if (step && before !== undefined && Number.isFinite(before)) s.before = before;
  return s;
}

export function emptySeries(step = false, before?: number): Series {
  return wrap(new Int32Array(0), new Float64Array(0), step, before);
}

/** The same points with another fill mode. `before` only applies to step series. */
export function withStep(s: Series, step: boolean, before?: number): Series {
  return wrap(s.t, s.v, step, before);
}

/**
 * Collects points in ascending day order, dropping non-finite values (a
 * series never stores NaN or ±Infinity). Not reusable after `build`.
 */
export class SeriesBuilder {
  private t: Int32Array;
  private v: Float64Array;
  private n = 0;

  constructor(capacity = 16) {
    this.t = new Int32Array(Math.max(4, capacity));
    this.v = new Float64Array(Math.max(4, capacity));
  }

  get length(): number {
    return this.n;
  }

  push(day: number, value: number): void {
    if (!Number.isFinite(value)) return;
    if (this.n === this.t.length) {
      const t = new Int32Array(this.n * 2);
      t.set(this.t);
      this.t = t;
      const v = new Float64Array(this.n * 2);
      v.set(this.v);
      this.v = v;
    }
    this.t[this.n] = day;
    this.v[this.n] = value;
    this.n++;
  }

  build(step: boolean, before?: number): Series {
    const full = this.n === this.t.length;
    return wrap(full ? this.t : this.t.slice(0, this.n), full ? this.v : this.v.slice(0, this.n), step, before);
  }
}

/**
 * Builds a series from parallel arrays of days and values: sorts by day,
 * keeps the last value given for a day and drops non-finite values. The
 * input arrays are copied.
 */
export function fromArrays(t: ArrayLike<number>, v: ArrayLike<number>, step = false, before?: number): Series {
  const n = Math.min(t.length, v.length);
  const out = new SeriesBuilder(n);
  let sorted = true;
  for (let i = 1; i < n && sorted; i++) sorted = t[i] > t[i - 1];
  if (sorted) {
    for (let i = 0; i < n; i++) out.push(t[i], v[i]);
    return out.build(step, before);
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => t[a] - t[b] || a - b);
  for (let k = 0; k < n; k++) {
    const i = order[k];
    if (k + 1 < n && t[order[k + 1]] === t[i]) continue; // a later value for the same day wins
    out.push(t[i], v[i]);
  }
  return out.build(step, before);
}

/** Builds a series from [day, value] pairs, with the same rules as `fromArrays`. */
export function fromPoints(points: ReadonlyArray<readonly [DayNum, number]>, step = false, before?: number): Series {
  return fromArrays(
    points.map((p) => p[0]),
    points.map((p) => p[1]),
    step,
    before,
  );
}

// ---------------------------------------------------------------------------
// Lookup and clipping
// ---------------------------------------------------------------------------

/** First index whose day is ≥ `day`. */
export function lowerBound(t: Int32Array, day: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid] < day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose day is > `day`. */
export function upperBound(t: Int32Array, day: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid] <= day) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Value of a series on a day, or NaN when it has none: for step series the
 * value in force (including `before`), otherwise only an exact point.
 */
export function valueAt(s: Series, day: DayNum): number {
  if (s.step) {
    const i = upperBound(s.t, day) - 1;
    return i >= 0 ? s.v[i] : (s.before ?? NaN);
  }
  const i = lowerBound(s.t, day);
  return i < s.t.length && s.t[i] === day ? s.v[i] : NaN;
}

/**
 * Keeps the points within [from, to]. For a step series the value in force
 * on `from` (including `before`) is inserted as a point on `from`, so the
 * result starts with the right value; the clipped series has no `before`.
 */
export function clip(s: Series, from: number, to: number): Series {
  if (from > to) return emptySeries(s.step);
  const i0 = lowerBound(s.t, from);
  const i1 = Math.max(i0, upperBound(s.t, to));
  const t = s.t.subarray(i0, i1);
  const v = s.v.subarray(i0, i1);
  if (!s.step) return wrap(t, v, false);
  const carry = i0 < s.t.length && s.t[i0] === from ? undefined : i0 > 0 ? s.v[i0 - 1] : s.before;
  if (carry === undefined || !Number.isFinite(from)) return wrap(t, v, true);
  const T = new Int32Array(t.length + 1);
  const V = new Float64Array(v.length + 1);
  T[0] = from;
  V[0] = carry;
  T.set(t, 1);
  V.set(v, 1);
  return wrap(T, V, true);
}

/** Moves every point `days` days later (earlier when negative). */
export function shiftSeries(s: Series, days: number): Series {
  const t = new Int32Array(s.t.length);
  for (let i = 0; i < t.length; i++) t[i] = s.t[i] + days;
  return wrap(t, s.v, s.step, s.before);
}

// ---------------------------------------------------------------------------
// Elementwise operations
// ---------------------------------------------------------------------------

/** Applies `f` to every value; keeps step and maps `before` too. */
export function mapValue(x: Value, f: (a: number) => number): Value {
  switch (x.kind) {
    case 'scalar':
      return scalar(f(x.value));
    case 'fn': {
      const at = x.at;
      return dateFn((day) => f(at(day)));
    }
    case 'series': {
      const out = new SeriesBuilder(x.t.length);
      for (let i = 0; i < x.t.length; i++) out.push(x.t[i], f(x.v[i]));
      return out.build(x.step, x.before === undefined ? undefined : f(x.before));
    }
  }
}

/**
 * Combines several values elementwise with `f`, aligning them by day:
 *
 * - only scalars → scalar; scalars and date functions → date function.
 * - Scalars are constants and date functions are read on each day used.
 * - If any series is non-step, the days are those present in every non-step
 *   series (inner join), kept where every step series has a value (on or
 *   after its first point, or anywhere when it has `before`). Non-step result.
 * - If all series are step, the days are the union of their change days where
 *   all have a value. The result is step (with `before` = f of the befores
 *   when all have one), unless a date function takes part: then it is a
 *   non-step series sampled on those change days.
 *
 * A non-finite result drops the point.
 */
export function combine(args: readonly Value[], f: (xs: number[]) => number): Value {
  const series: Series[] = [];
  let hasFn = false;
  for (const a of args) {
    if (a.kind === 'series') series.push(a);
    else if (a.kind === 'fn') hasFn = true;
  }

  const k = args.length;
  // Per-argument data in plain arrays, so the loops below stay monomorphic.
  const consts = args.map((a) => (a.kind === 'scalar' ? a.value : NaN));
  const fns = args.map((a) => (a.kind === 'fn' ? a.at : null));

  if (series.length === 0) {
    if (!hasFn) return scalar(f(consts));
    // A date function is never re-entered while running, so one buffer per function is safe.
    const buf = consts.slice();
    return dateFn((day) => {
      for (let i = 0; i < k; i++) {
        const at = fns[i];
        if (at !== null) buf[i] = at(day);
      }
      return f(buf);
    });
  }

  const loose = series.filter((s) => !s.step);
  const days = loose.length > 0 ? intersectDays(loose.map((s) => s.t)) : unionDays(series.map((s) => s.t));
  const step = loose.length === 0 && !hasFn;

  const empty = new Int32Array(0);
  const ts = args.map((a) => (a.kind === 'series' ? a.t : empty));
  const vs = args.map((a) => (a.kind === 'series' ? a.v : new Float64Array(0)));
  // 0: constant, 1: date function, 2: non-step series, 3: step series.
  const mode = args.map((a) => (a.kind === 'scalar' ? 0 : a.kind === 'fn' ? 1 : a.step ? 3 : 2));
  const befores = args.map((a) => (a.kind === 'series' && a.before !== undefined ? a.before : NaN));
  const xs = consts.slice();
  const cursor = new Int32Array(k).fill(-1);
  const out = new SeriesBuilder(days.length);
  outer: for (let d = 0; d < days.length; d++) {
    const day = days[d];
    for (let i = 0; i < k; i++) {
      const m = mode[i];
      if (m === 0) continue;
      if (m === 1) {
        xs[i] = (fns[i] as (day: DayNum) => number)(day);
        continue;
      }
      const t = ts[i];
      let j = cursor[i];
      while (j + 1 < t.length && t[j + 1] <= day) j++;
      cursor[i] = j;
      if (j >= 0 && (m === 3 || t[j] === day)) xs[i] = vs[i][j];
      else if (m === 3 && j < 0 && !Number.isNaN(befores[i])) xs[i] = befores[i];
      else continue outer;
    }
    out.push(day, f(xs));
  }

  let before: number | undefined;
  if (step && series.every((s) => s.before !== undefined)) {
    before = f(args.map((a, i) => (a.kind === 'series' ? befores[i] : consts[i])));
  }
  return out.build(step, before);
}

function intersectDays(lists: Int32Array[]): Int32Array {
  let acc = lists[0];
  for (let l = 1; l < lists.length; l++) {
    const b = lists[l];
    const out = new Int32Array(Math.min(acc.length, b.length));
    let n = 0;
    let i = 0;
    let j = 0;
    while (i < acc.length && j < b.length) {
      if (acc[i] === b[j]) {
        out[n++] = acc[i];
        i++;
        j++;
      } else if (acc[i] < b[j]) i++;
      else j++;
    }
    acc = out.subarray(0, n);
  }
  return acc;
}

function unionDays(lists: Int32Array[]): Int32Array {
  let acc = lists[0];
  for (let l = 1; l < lists.length; l++) {
    const b = lists[l];
    const out = new Int32Array(acc.length + b.length);
    let n = 0;
    let i = 0;
    let j = 0;
    while (i < acc.length || j < b.length) {
      if (j >= b.length || (i < acc.length && acc[i] < b[j])) out[n++] = acc[i++];
      else if (i >= acc.length || b[j] < acc[i]) out[n++] = b[j++];
      else {
        out[n++] = acc[i];
        i++;
        j++;
      }
    }
    acc = out.subarray(0, n);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

/**
 * One point per day holding the latest value, from the first point to the
 * later of the last point and `today`, limited to `range` when given. The
 * result is a step series; `before` is kept.
 */
export function daily(s: Series, today: DayNum, range: DayRange | null): Series {
  const n = s.t.length;
  if (n === 0) return wrap(s.t, s.v, true, s.before);
  let start = s.t[0];
  let end = Math.max(s.t[n - 1], today);
  if (range) {
    start = Math.max(start, range.from);
    end = Math.min(end, range.to);
  }
  if (end < start) return emptySeries(true, s.before);
  const len = end - start + 1;
  const T = new Int32Array(len);
  const V = new Float64Array(len);
  let j = upperBound(s.t, start) - 1;
  for (let k = 0; k < len; k++) {
    const day = start + k;
    while (j + 1 < n && s.t[j + 1] <= day) j++;
    T[k] = day;
    V[k] = s.v[j];
  }
  return wrap(T, V, true, s.before);
}

/** One point per day between the first and last points, linearly interpolated. Non-step. */
export function interp(s: Series): Series {
  const n = s.t.length;
  if (n === 0) return emptySeries();
  const t0 = s.t[0];
  const len = s.t[n - 1] - t0 + 1;
  const out = new SeriesBuilder(len);
  let j = 0;
  for (let k = 0; k < len; k++) {
    const day = t0 + k;
    while (j + 1 < n && s.t[j + 1] <= day) j++;
    if (s.t[j] === day || j + 1 >= n) {
      out.push(day, s.v[j]);
    } else {
      const a = s.t[j];
      const b = s.t[j + 1];
      out.push(day, s.v[j] + ((s.v[j + 1] - s.v[j]) * (day - a)) / (b - a));
    }
  }
  return out.build(false);
}

// ---------------------------------------------------------------------------
// Reducers and windows
// ---------------------------------------------------------------------------

/**
 * Collapses values into one number. Empty input gives NaN, except `count`
 * (0). `stdev` is the sample standard deviation (NaN for fewer than 2 values).
 */
export function reduce(v: Float64Array, r: Reducer | 'stdev'): number {
  const n = v.length;
  if (r === 'count') return n;
  if (n === 0) return NaN;
  switch (r) {
    case 'first':
      return v[0];
    case 'last':
      return v[n - 1];
    case 'delta':
      return v[n - 1] - v[0];
    case 'sum':
      return sum(v);
    case 'mean':
      return sum(v) / n;
    case 'min': {
      let m = v[0];
      for (let i = 1; i < n; i++) if (v[i] < m) m = v[i];
      return m;
    }
    case 'max': {
      let m = v[0];
      for (let i = 1; i < n; i++) if (v[i] > m) m = v[i];
      return m;
    }
    case 'median':
      return medianOfSorted(Array.from(v).sort((a, b) => a - b));
    case 'stdev': {
      if (n < 2) return NaN;
      const mean = sum(v) / n;
      let ss = 0;
      for (let i = 0; i < n; i++) ss += (v[i] - mean) ** 2;
      return Math.sqrt(ss / (n - 1));
    }
  }
}

function sum(v: Float64Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  return s;
}

function medianOfSorted(sorted: number[]): number {
  const k = sorted.length;
  const h = k >> 1;
  return k % 2 === 1 ? sorted[h] : (sorted[h - 1] + sorted[h]) / 2;
}

function insertSorted(a: number[], x: number): void {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  a.splice(lo, 0, x);
}

function removeSorted(a: number[], x: number): void {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  a.splice(lo, 1);
}

/**
 * For each point, reduces the points of the calendar window of `days` days
 * ending on it (inclusive). Keeps the step flag; drops `before`.
 */
export function rolling(s: Series, days: number, r: Reducer): Series {
  const n = s.t.length;
  const out = new SeriesBuilder(n);
  const sorted: number[] = [];
  const useSorted = r === 'median' || r === 'min' || r === 'max';
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const first = s.t[i] - days + 1;
    if (useSorted) insertSorted(sorted, s.v[i]);
    while (s.t[lo] < first) {
      if (useSorted) removeSorted(sorted, s.v[lo]);
      lo++;
    }
    let value: number;
    if (r === 'min') value = sorted[0];
    else if (r === 'max') value = sorted[sorted.length - 1];
    else if (r === 'median') value = medianOfSorted(sorted);
    else value = reduce(s.v.subarray(lo, i + 1), r);
    out.push(s.t[i], value);
  }
  return out.build(s.step);
}

/** Exponential moving average over the points, alpha = 2 / (span + 1). Keeps the step flag. */
export function ema(s: Series, span: number): Series {
  const alpha = 2 / (span + 1);
  const out = new SeriesBuilder(s.t.length);
  let e = s.v[0];
  for (let i = 0; i < s.t.length; i++) {
    e = i === 0 ? s.v[0] : alpha * s.v[i] + (1 - alpha) * e;
    out.push(s.t[i], e);
  }
  return out.build(s.step);
}

// ---------------------------------------------------------------------------
// Calendar buckets
// ---------------------------------------------------------------------------

/** First day of the bucket containing `day` (weeks start on Monday). */
export function bucketStart(day: DayNum, b: Bucket): DayNum {
  switch (b) {
    case 'week':
      return weekStart(day);
    case 'month':
      return monthStart(day);
    case 'quarter':
      return quarterStart(day);
    case 'year':
      return yearStart(day);
  }
}

/** First day of the bucket after the one starting on `start`. */
export function nextBucket(start: DayNum, b: Bucket): DayNum {
  if (b === 'week') return start + 7;
  const { y, m } = ymd(start);
  if (b === 'month') return fromYMD(y, m + 1, 1);
  if (b === 'quarter') return fromYMD(y, m + 3, 1);
  return fromYMD(y + 1, 1, 1);
}

/** 'YYYY-MM-DD' (the week's Monday), 'YYYY-MM', 'YYYY-Q1' or 'YYYY'. */
export function bucketLabel(start: DayNum, b: Bucket): string {
  switch (b) {
    case 'week':
      return fromDayNum(start);
    case 'month':
      return monthKey(start);
    case 'quarter': {
      const { y, m } = ymd(start);
      return `${String(y).padStart(4, '0')}-Q${Math.floor((m - 1) / 3) + 1}`;
    }
    case 'year':
      return String(ymd(start).y).padStart(4, '0');
  }
}

/**
 * One point per calendar bucket, on the bucket's first day, reducing the
 * points inside it. For a step series the value in force at the start of
 * each bucket counts as its first point, so every bucket from the first to
 * the last point gets a value. The result is non-step.
 */
export function bucketize(s: Series, b: Bucket, r: Reducer): Series {
  const n = s.t.length;
  const out = new SeriesBuilder();
  if (n === 0) return out.build(false);
  const buf = new Float64Array(n + 1);
  let i = 0;
  if (!s.step) {
    while (i < n) {
      const start = bucketStart(s.t[i], b);
      const next = nextBucket(start, b);
      let k = 0;
      while (i < n && s.t[i] < next) buf[k++] = s.v[i++];
      out.push(start, reduce(buf.subarray(0, k), r));
    }
    return out.build(false);
  }
  const last = s.t[n - 1];
  for (let start = bucketStart(s.t[0], b); start <= last; ) {
    const next = nextBucket(start, b);
    let k = 0;
    if (!(i < n && s.t[i] === start)) {
      const carry = i > 0 ? s.v[i - 1] : s.before;
      if (carry !== undefined) buf[k++] = carry;
    }
    while (i < n && s.t[i] < next) buf[k++] = s.v[i++];
    if (k > 0) out.push(start, reduce(buf.subarray(0, k), r));
    start = next;
  }
  return out.build(false);
}
