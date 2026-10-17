/**
 * Public contract of the formula and chart engine. The engine is pure: it
 * takes plain data in and returns plain data out, with no I/O and no UI.
 */

import type { DayNum } from '../model/dates';
import type { ChartSpec, FormulaDef, MetricDef, Period, PeriodSet } from '../model/types';

/** A date-indexed sequence of values. */
export interface Series {
  kind: 'series';
  /** Day numbers, strictly ascending. */
  t: Int32Array;
  /** Values, same length as t. Never NaN: a missing value is a missing point. */
  v: Float64Array;
  /**
   * When true the value holds from each point until the next one, and the
   * last value holds forever. Undefined before t[0] unless `before` is set.
   */
  step: boolean;
  /** For step series: the value before the first point (e.g. 0 before an investment existed). */
  before?: number;
}

export interface Scalar {
  kind: 'scalar';
  value: number;
}

/** A value defined on every day, computed from the date (e.g. days since a date). */
export interface DateFn {
  kind: 'fn';
  at: (day: DayNum) => number;
}

export type Value = Series | Scalar | DateFn;

/** Source position of an expression error, for underlining in the editor. */
export interface Span {
  start: number;
  end: number;
}

export class ExprError extends Error {
  constructor(
    message: string,
    public readonly span: Span | null = null,
    /** Suggested replacement, e.g. a close identifier name. */
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'ExprError';
  }
}

/** Everything the engine needs from the vault. */
export interface DataSource {
  metrics: MetricDef[];
  formulas: FormulaDef[];
  periodSets: PeriodSet[];
  periods: Period[];
  /** Entries of a metric, sorted by date, one value per day. */
  entries(metricId: string): { t: Int32Array; v: Float64Array };
  /** The user's current local day. */
  today: DayNum;
}

/** Documentation of one function, for autocomplete and the formula reference. */
export interface FunctionDoc {
  name: string;
  signature: string;
  description: string;
  example: string;
  category: 'math' | 'time' | 'aggregate' | 'transform' | 'logic';
}

// ---------------------------------------------------------------------------
// Chart evaluation output: renderer-agnostic, every number already computed.
// ---------------------------------------------------------------------------

export interface Band {
  start: DayNum;
  /** Inclusive. Open periods end today. */
  end: DayNum;
  label: string;
  color?: string | null;
  periodId: string;
}

export interface SeriesError {
  seriesId: string;
  message: string;
  span: Span | null;
}

export interface TimeSeriesOut {
  id: string;
  label: string;
  color?: string | null;
  /** [day, value] pairs, ascending by day. */
  points: Array<[DayNum, number]>;
  step: boolean;
}

export interface TimeChartData {
  mode: 'time';
  series: TimeSeriesOut[];
  bands: Band[];
  /** Smallest and largest day across all series, or null if empty. */
  domain: { min: DayNum; max: DayNum } | null;
  errors: SeriesError[];
}

export interface ElapsedSeriesOut {
  id: string;
  label: string;
  color?: string | null;
  /** [dayIndex, value] where dayIndex 1 is the series' first day. */
  points: Array<[number, number]>;
  /** Real date of dayIndex 1. */
  startDay: DayNum;
}

export interface ElapsedChartData {
  mode: 'elapsed';
  series: ElapsedSeriesOut[];
  errors: SeriesError[];
}

export interface Category {
  label: string;
  from: DayNum;
  /** Inclusive. */
  to: DayNum;
  /** Period id in 'periods' mode. */
  periodId?: string;
}

export interface CategorySeriesOut {
  id: string;
  label: string;
  color?: string | null;
  /** One value per category; null where the series has no data. */
  values: Array<number | null>;
}

export interface CategoryChartData {
  mode: 'category';
  categories: Category[];
  series: CategorySeriesOut[];
  errors: SeriesError[];
}

export interface OhlcSeriesOut {
  id: string;
  label: string;
  color?: string | null;
  /** One [open, close, low, high] per category; null where empty. */
  ohlc: Array<[number, number, number, number] | null>;
}

export interface OhlcChartData {
  mode: 'ohlc';
  categories: Category[];
  series: OhlcSeriesOut[];
  errors: SeriesError[];
}

export interface WaterfallChartData {
  mode: 'waterfall';
  categories: Category[];
  /** Change in each category (null = no data, drawn as a gap with no change). */
  deltas: Array<number | null>;
  /** Running total before each category. */
  base: number[];
  /** Running total after each category. */
  total: number[];
  label: string;
  errors: SeriesError[];
}

export interface MultiplesChartData {
  mode: 'multiples';
  panels: Array<{ period: Period; data: Exclude<ChartData, MultiplesChartData> }>;
  errors: SeriesError[];
}

export type ChartData =
  | TimeChartData
  | ElapsedChartData
  | CategoryChartData
  | OhlcChartData
  | WaterfallChartData
  | MultiplesChartData;

export type { ChartSpec };
