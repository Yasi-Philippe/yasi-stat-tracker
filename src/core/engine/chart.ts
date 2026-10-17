/**
 * Turns a ChartSpec into renderer-agnostic ChartData. Never throws for user
 * errors: a broken series gets an entry in `errors` (with the span to
 * underline in its expression) and the other series are still evaluated.
 *
 * Every series of the spec appears in the output, in order; a series that
 * failed has no data. Errors not tied to a series use seriesId ''.
 */

import { isISODate, toDayNum, type DayNum } from '../model/dates';
import type { Bucket, ChartSeriesSpec, ChartSpec, Period, PeriodSet, Reducer } from '../model/types';
import { bucketLabel, bucketStart, nextBucket, reduce, type DayRange } from './series';
import {
  ExprError,
  type Band,
  type Category,
  type CategoryChartData,
  type ChartData,
  type DataSource,
  type ElapsedChartData,
  type ElapsedSeriesOut,
  type MultiplesChartData,
  type OhlcChartData,
  type SeriesError,
  type TimeChartData,
  type TimeSeriesOut,
  type Value,
  type WaterfallChartData,
} from './types';
import type { Workspace } from './workspace';

type PlainChartData = Exclude<ChartData, MultiplesChartData>;
type Ohlc = [number, number, number, number];

interface DatedPeriod {
  period: Period;
  range: DayRange;
}

/**
 * Evaluates a chart. `src` defaults to the workspace's data source.
 *
 * - filter: 'each' gives one panel per period of the set (MultiplesChartData),
 *   'latest' the period that started last, a period id that period; each is
 *   the chart evaluated with every formula restricted to the period.
 * - x 'date': TimeChartData. 'elapsed': ElapsedChartData. 'bucket' and
 *   'periods': one category per bucket or period, as CategoryChartData,
 *   OhlcChartData (kind 'candles') or WaterfallChartData (kind 'waterfall').
 */
export function evaluateChart(spec: ChartSpec, ws: Workspace, src: DataSource = ws.source): ChartData {
  const filter = spec.filter;
  if (!filter) return evaluatePlain(spec, ws, src, null);

  const set = src.periodSets.find((s) => s.id === filter.setId);
  if (!set) return emptyChart(spec, [chartError('This chart is filtered by a period set that no longer exists')]);
  const periods = datedPeriods(src, set.id);

  if (filter.period === 'each') {
    const panels = periods.map((p) => ({ period: p.period, data: evaluatePlain(spec, ws, src, p.range) }));
    const errors = uniqueErrors(panels.flatMap((p) => p.data.errors));
    const result: MultiplesChartData = { mode: 'multiples', panels, errors };
    return result;
  }

  const chosen =
    filter.period === 'latest' ? periods[periods.length - 1] : periods.find((p) => p.period.id === filter.period);
  if (!chosen) {
    return emptyChart(spec, [
      chartError(
        filter.period === 'latest'
          ? `"${set.name}" has no periods yet`
          : 'This chart is filtered by a period that no longer exists',
      ),
    ]);
  }
  return evaluatePlain(spec, ws, src, chosen.range);
}

function evaluatePlain(spec: ChartSpec, ws: Workspace, src: DataSource, range: DayRange | null): PlainChartData {
  switch (spec.x.mode) {
    case 'date':
      return timeChart(spec, ws, src, range);
    case 'elapsed':
      return elapsedChart(spec, ws, range);
    case 'bucket':
    case 'periods':
      return categoryChart(spec, ws, src, range);
  }
}

// ---------------------------------------------------------------------------
// Time axes
// ---------------------------------------------------------------------------

function timeChart(spec: ChartSpec, ws: Workspace, src: DataSource, range: DayRange | null): TimeChartData {
  const errors: SeriesError[] = [];
  const values = spec.series.map((s) => attempt(ws, s, range, errors));

  let domain: { min: DayNum; max: DayNum } | null = range ? { min: range.from, max: range.to } : null;
  if (!range) {
    for (const v of values) {
      if (v?.kind !== 'series' || v.t.length === 0) continue;
      const lo = v.t[0];
      const hi = v.t[v.t.length - 1];
      domain = domain ? { min: Math.min(domain.min, lo), max: Math.max(domain.max, hi) } : { min: lo, max: hi };
    }
  }

  const series = spec.series.map((s, i): TimeSeriesOut => {
    const out: TimeSeriesOut = { id: s.id, label: labelOf(s), color: s.color, points: [], step: false };
    const v = values[i];
    if (!v) return out;
    if (v.kind === 'series') {
      out.step = v.step;
      for (let k = 0; k < v.t.length; k++) out.points.push([v.t[k], v.v[k]]);
    } else if (!domain) {
      // Metrics with no entries yet are "no data", not a mistake in the formula.
      if (!ws.usesMetrics(s.expr)) errors.push(seriesError(s.id, `${describe(v)} needs a series to define the time range`));
    } else if (v.kind === 'scalar') {
      if (!Number.isNaN(v.value)) out.points.push([domain.min, v.value], [domain.max, v.value]);
    } else {
      for (let day = domain.min; day <= domain.max; day++) {
        const y = v.at(day);
        if (Number.isFinite(y)) out.points.push([day, y]);
      }
    }
    return out;
  });

  const bands: Band[] = [];
  if (spec.bands) {
    const set = src.periodSets.find((s) => s.id === spec.bands?.setId);
    if (!set) {
      errors.push(chartError('The shaded periods come from a period set that no longer exists'));
    } else if (domain) {
      const { min, max } = domain;
      for (const p of datedPeriods(src, set.id)) {
        if (p.range.from > max || p.range.to < min) continue;
        bands.push({
          start: p.range.from,
          end: p.range.to,
          label: p.period.name,
          color: p.period.color ?? set.color ?? null,
          periodId: p.period.id,
        });
      }
    }
  }

  return { mode: 'time', series, bands, domain, errors };
}

function elapsedChart(spec: ChartSpec, ws: Workspace, range: DayRange | null): ElapsedChartData {
  const errors: SeriesError[] = [];
  const series = spec.series.map((s): ElapsedSeriesOut => {
    const out: ElapsedSeriesOut = { id: s.id, label: labelOf(s), color: s.color, points: [], startDay: range?.from ?? 0 };
    const v = attempt(ws, s, range, errors);
    if (!v) return out;
    if (v.kind !== 'series') {
      errors.push(seriesError(s.id, `${describe(v)} can't be drawn against days elapsed; it needs a series`));
      return out;
    }
    if (v.t.length > 0) {
      const first = v.t[0];
      out.startDay = first;
      for (let k = 0; k < v.t.length; k++) out.points.push([v.t[k] - first + 1, v.v[k]]);
    }
    return out;
  });
  return { mode: 'elapsed', series, errors };
}

// ---------------------------------------------------------------------------
// Category axes: buckets and periods
// ---------------------------------------------------------------------------

function categoryChart(
  spec: ChartSpec,
  ws: Workspace,
  src: DataSource,
  range: DayRange | null,
): CategoryChartData | OhlcChartData | WaterfallChartData {
  const errors: SeriesError[] = [];
  const waterfall = spec.kind === 'waterfall';
  // A waterfall shows its first series only.
  const specs = waterfall ? spec.series.slice(0, 1) : spec.series;
  // Evaluating over the whole range finds broken series and the data's extent.
  const whole = specs.map((s) => attempt(ws, s, range, errors));

  let categories: Category[] = [];
  const x = spec.x;
  if (x.mode === 'bucket') {
    const extent = range ? { lo: range.from, hi: range.to } : dataExtent(ws, specs, whole);
    if (extent) {
      categories = bucketCategories(extent.lo, extent.hi, x.bucket, range);
    } else {
      specs.forEach((s, i) => {
        const v = whole[i];
        if (v && v.kind !== 'series' && !ws.usesMetrics(s.expr)) errors.push(seriesError(s.id, `${describe(v)} needs a series to define the time range`));
      });
    }
  } else if (x.mode === 'periods') {
    const set = src.periodSets.find((s) => s.id === x.setId);
    if (set) categories = periodCategories(src, set, range);
    else errors.push(chartError('This chart uses a period set that no longer exists'));
  }

  // Each cell is the expression evaluated with every metric restricted to the category.
  const cells = (s: ChartSeriesSpec, i: number): Array<Value | null> => {
    if (!whole[i]) return categories.map(() => null);
    let reported = false;
    return categories.map((cat) => {
      try {
        return ws.evalExpr(s.expr, { from: cat.from, to: cat.to });
      } catch (e) {
        if (!reported) {
          reported = true;
          errors.push(toSeriesError(s.id, e));
        }
        return null;
      }
    });
  };

  if (waterfall) {
    const first = specs[0];
    const reducer = first?.reducer ?? 'sum';
    const deltas = first
      ? cells(first, 0).map((v, k) => reduceCell(v, reducer, categories[k]))
      : categories.map(() => null);
    const base: number[] = [];
    const total: number[] = [];
    let running = 0;
    for (const d of deltas) {
      base.push(running);
      running += d ?? 0;
      total.push(running);
    }
    return { mode: 'waterfall', categories, deltas, base, total, label: first ? labelOf(first) : '', errors };
  }

  if (spec.kind === 'candles') {
    const series = specs.map((s, i) => ({
      id: s.id,
      label: labelOf(s),
      color: s.color,
      ohlc: cells(s, i).map((v, k) => ohlcCell(v, categories[k])),
    }));
    return { mode: 'ohlc', categories, series, errors };
  }

  const series = specs.map((s, i) => {
    const reducer = s.reducer ?? 'last';
    return {
      id: s.id,
      label: labelOf(s),
      color: s.color,
      values: cells(s, i).map((v, k) => reduceCell(v, reducer, categories[k])),
    };
  });
  return { mode: 'category', categories, series, errors };
}

/** Every bucket from the one containing `lo` to the one containing `hi`, limited to `range`. */
function bucketCategories(lo: DayNum, hi: DayNum, bucket: Bucket, range: DayRange | null): Category[] {
  const out: Category[] = [];
  for (let start = bucketStart(lo, bucket); start <= hi; ) {
    const next = nextBucket(start, bucket);
    out.push({
      label: bucketLabel(start, bucket),
      from: range ? Math.max(start, range.from) : start,
      to: range ? Math.min(next - 1, range.to) : next - 1,
    });
    start = next;
  }
  return out;
}

function periodCategories(src: DataSource, set: PeriodSet, range: DayRange | null): Category[] {
  const out: Category[] = [];
  for (const p of datedPeriods(src, set.id)) {
    let { from, to } = p.range;
    if (range) {
      if (from > range.to || to < range.from) continue;
      from = Math.max(from, range.from);
      to = Math.min(to, range.to);
    }
    out.push({ label: p.period.name, from, to, periodId: p.period.id });
  }
  return out;
}

/**
 * Earliest and latest data day across the series: the points of series
 * values, and for single numbers or date functions the entries of the
 * metrics they use (e.g. last(networth) - first(networth)).
 */
function dataExtent(
  ws: Workspace,
  specs: ChartSeriesSpec[],
  values: Array<Value | null>,
): { lo: DayNum; hi: DayNum } | null {
  let extent: { lo: DayNum; hi: DayNum } | null = null;
  const include = (lo: DayNum, hi: DayNum): void => {
    extent = extent ? { lo: Math.min(extent.lo, lo), hi: Math.max(extent.hi, hi) } : { lo, hi };
  };
  values.forEach((v, i) => {
    if (!v) return;
    if (v.kind === 'series') {
      if (v.t.length > 0) include(v.t[0], v.t[v.t.length - 1]);
      return;
    }
    const used = ws.dataRange(specs[i].expr);
    if (used) include(used.from, used.to);
  });
  return extent;
}

/** One number for a category: a scalar as is, a series reduced, a date function on the last day. */
function reduceCell(v: Value | null, reducer: Reducer, cat: Category): number | null {
  if (!v) return null;
  let y: number;
  if (v.kind === 'scalar') y = v.value;
  else if (v.kind === 'fn') y = v.at(cat.to);
  else if (v.t.length === 0) return null;
  else y = reduce(v.v, reducer);
  return Number.isFinite(y) ? y : null;
}

/** [open, close, low, high] of a category. */
function ohlcCell(v: Value | null, cat: Category): Ohlc | null {
  if (!v) return null;
  if (v.kind === 'scalar') return Number.isFinite(v.value) ? [v.value, v.value, v.value, v.value] : null;
  let ohlc: Ohlc | null = null;
  const add = (y: number): void => {
    if (!ohlc) ohlc = [y, y, y, y];
    else {
      ohlc[1] = y;
      if (y < ohlc[2]) ohlc[2] = y;
      if (y > ohlc[3]) ohlc[3] = y;
    }
  };
  if (v.kind === 'series') {
    for (let k = 0; k < v.v.length; k++) add(v.v[k]);
  } else {
    for (let day = cat.from; day <= cat.to; day++) {
      const y = v.at(day);
      if (Number.isFinite(y)) add(y);
    }
  }
  return ohlc;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Periods of a set with valid dates, sorted by start. Open periods end today. */
function datedPeriods(src: DataSource, setId: string): DatedPeriod[] {
  const out: DatedPeriod[] = [];
  for (const period of src.periods) {
    if (period.setId !== setId || !isISODate(period.start)) continue;
    if (period.end !== null && !isISODate(period.end)) continue;
    const from = toDayNum(period.start);
    const end = period.end === null ? src.today : toDayNum(period.end);
    out.push({ period, range: { from, to: Math.max(from, end) } });
  }
  return out.sort((a, b) => a.range.from - b.range.from || a.range.to - b.range.to);
}

function attempt(ws: Workspace, s: ChartSeriesSpec, range: DayRange | null, errors: SeriesError[]): Value | null {
  try {
    return ws.evalExpr(s.expr, range);
  } catch (e) {
    errors.push(toSeriesError(s.id, e));
    return null;
  }
}

function toSeriesError(seriesId: string, e: unknown): SeriesError {
  if (e instanceof ExprError) return { seriesId, message: e.message, span: e.span };
  return { seriesId, message: e instanceof Error ? e.message : String(e), span: null };
}

function seriesError(seriesId: string, message: string): SeriesError {
  return { seriesId, message, span: null };
}

function chartError(message: string): SeriesError {
  return { seriesId: '', message, span: null };
}

function uniqueErrors(errors: SeriesError[]): SeriesError[] {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const key = `${e.seriesId}\u0000${e.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function labelOf(s: ChartSeriesSpec): string {
  return s.label?.trim() ? s.label : s.expr;
}

function describe(v: Value): string {
  return v.kind === 'scalar' ? 'A single number' : v.kind === 'fn' ? 'A date function' : 'A series';
}

function emptyChart(spec: ChartSpec, errors: SeriesError[]): PlainChartData {
  switch (spec.x.mode) {
    case 'date':
      return { mode: 'time', series: [], bands: [], domain: null, errors };
    case 'elapsed':
      return { mode: 'elapsed', series: [], errors };
    default:
      if (spec.kind === 'waterfall') {
        const first = spec.series[0];
        return { mode: 'waterfall', categories: [], deltas: [], base: [], total: [], label: first ? labelOf(first) : '', errors };
      }
      if (spec.kind === 'candles') return { mode: 'ohlc', categories: [], series: [], errors };
      return { mode: 'category', categories: [], series: [], errors };
  }
}
