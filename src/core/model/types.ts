/**
 * The sandbox data model. Everything a user creates is one of these records.
 * They are stored in the encrypted vault (see core/vault) and synced as-is, so
 * every field must be JSON-serialisable.
 */

import type { ISODate } from './dates';

export type { ISODate } from './dates';

/** How often a metric is entered. */
export type Cadence =
  /** At most one value per day (weight, balances). */
  | 'daily'
  /** At most one value per month, stored on the 1st (monthly expenses). */
  | 'monthly'
  /** Occasional values that hold until changed (height, monthly living cost). */
  | 'sparse';

/**
 * How formulas see the gaps between entries.
 * - none: a missing day is missing (weight).
 * - step: the last value holds until the next one (balances, height).
 */
export type Fill = 'none' | 'step';

export interface ReminderRule {
  enabled: boolean;
  /** Local time, 'HH:MM'. */
  time: string;
  /** Days of the week it applies to, 0 = Sunday. Empty or missing = every day. */
  weekdays?: number[];
}

/** A quantity the user enters by hand. */
export interface MetricDef {
  id: string;
  /** Identifier used in formulas: lowercase letters, digits, underscores. */
  slug: string;
  name: string;
  unit: string;
  cadence: Cadence;
  fill: Fill;
  /** Decimals shown and stored. */
  decimals: number;
  /** Increment for the +/- stepper on the input card. */
  step: number;
  min?: number | null;
  max?: number | null;
  /** Free-form grouping label, e.g. "Body" or "Money". */
  group?: string;
  color?: string | null;
  icon?: string | null;
  reminder?: ReminderRule | null;
  archived?: boolean;
  /** Hidden from the daily input screen (parameters such as height). */
  hideFromToday?: boolean;
  /** Which direction counts as good, for colouring changes. */
  better?: 'up' | 'down' | null;
  order: number;
}

/** A value computed from other metrics and formulas. */
export interface FormulaDef {
  id: string;
  slug: string;
  name: string;
  unit: string;
  expr: string;
  decimals: number;
  group?: string;
  color?: string | null;
  order: number;
}

export interface Entry {
  metricId: string;
  date: ISODate;
  value: number;
  note?: string;
}

/**
 * A family of named date ranges.
 * - campaign: started and stopped with a button, may overlap gaps (diets).
 * - segment: consecutive chapters of life (places of residence).
 */
export interface PeriodSet {
  id: string;
  slug: string;
  name: string;
  kind: 'campaign' | 'segment';
  color?: string | null;
  order: number;
}

export interface Period {
  id: string;
  setId: string;
  name: string;
  start: ISODate;
  /** null = still running. */
  end: ISODate | null;
  color?: string | null;
  note?: string;
}

export type ChartKind = 'line' | 'area' | 'bar' | 'waterfall' | 'candles' | 'dots';
export type Bucket = 'week' | 'month' | 'quarter' | 'year';
export type Reducer = 'last' | 'first' | 'sum' | 'mean' | 'median' | 'min' | 'max' | 'delta' | 'count';

export type XAxisSpec =
  /** Real calendar dates. */
  | { mode: 'date' }
  /** Days since each series' own first point, so every series starts at day 1. */
  | { mode: 'elapsed' }
  /** One category per calendar bucket. */
  | { mode: 'bucket'; bucket: Bucket }
  /** One category per period of a period set. */
  | { mode: 'periods'; setId: string };

export interface SeriesStyle {
  line?: 'solid' | 'dashed' | 'dotted';
  width?: number;
  smooth?: boolean;
  area?: boolean;
  points?: 'none' | 'auto' | 'all';
  step?: boolean;
  /** 0–1, to push a series into the background (e.g. raw data under its trend). */
  opacity?: number;
}

export interface ChartSeriesSpec {
  id: string;
  /** Formula evaluated for this series, e.g. "weight" or "pct(stocks)". */
  expr: string;
  label?: string;
  color?: string | null;
  /** How a series collapses into one value per bucket or period. */
  reducer?: Reducer;
  axis?: 'left' | 'right';
  style?: SeriesStyle;
}

export interface ChartFilter {
  setId: string;
  /** A period id, 'each' for one small chart per period, or 'latest'. */
  period: string;
}

export type ViewPreset = 'all' | 'year' | 'quarter' | 'month';

export interface ChartView {
  preset: ViewPreset;
  yMin?: number | null;
  yMax?: number | null;
  /** Force the value axis to include zero. */
  yZero?: boolean;
}

export interface ChartSpec {
  id: string;
  title: string;
  subtitle?: string;
  kind: ChartKind;
  x: XAxisSpec;
  series: ChartSeriesSpec[];
  filter?: ChartFilter | null;
  /** Shade the periods of this set behind the data. */
  bands?: { setId: string } | null;
  view: ChartView;
  refLines?: { value: number; label?: string }[];
  /** Which direction of change is good, for colouring changes. Inferred from the metric when missing. */
  better?: 'up' | 'down' | null;
  /** Unit shown on the value axis; defaults to the first series' unit. */
  unit?: string;
  decimals?: number;
}

export interface DashboardItem {
  chartId: string;
  size: 'full' | 'half';
}

export interface Dashboard {
  id: string;
  name: string;
  icon?: string | null;
  items: DashboardItem[];
  order: number;
}

export interface ThemeTokens {
  /** 'dark' or 'light' base, used for system UI and contrast decisions. */
  scheme: 'dark' | 'light';
  bg: string;
  surface: string;
  surface2: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  accent2: string;
  positive: string;
  negative: string;
  /** Categorical series colours, in order. */
  palette: string[];
  fontUI: string;
  fontDisplay: string;
  fontNumber: string;
  radius: number;
  /** 0–1: how much glow / gradient the charts use. */
  glow: number;
  /** Chart grid lines. */
  grid: 'none' | 'faint' | 'dashed';
  /** Line chart curve. */
  curve: 'straight' | 'smooth' | 'step';
  lineWidth: number;
  /** Area fill under lines: 0 = none, 1 = strong. */
  areaOpacity: number;
}

export interface ThemeDef {
  id: string;
  name: string;
  tokens: ThemeTokens;
  /** Built-in themes cannot be edited, only duplicated. */
  builtIn?: boolean;
}

export interface Settings {
  themeId: string;
  /** First day of the week in calendars: 1 = Monday, 0 = Sunday. */
  weekStart: 0 | 1;
  /** BCP 47 locale for number and date formatting; empty = system. */
  locale?: string;
  /** Hide numbers on the home screen until tapped (privacy in public). */
  discreet?: boolean;
}
