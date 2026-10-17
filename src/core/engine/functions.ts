/**
 * The function library of the formula language. Each entry carries its own
 * documentation, which feeds autocomplete (FUNCTION_DOCS) and must stay in
 * line with docs/FORMULAS.md.
 */

import type { DayNum } from '../model/dates';
import type { Bucket, Reducer } from '../model/types';
import {
  bucketize,
  clip,
  combine,
  daily,
  dateFn,
  ema,
  interp,
  mapValue,
  reduce,
  rolling,
  scalar,
  SeriesBuilder,
  shiftSeries,
  withStep,
  type DayRange,
} from './series';
import type { ExprError, FunctionDoc, Scalar, Series, Value } from './types';

/**
 * How an argument is checked before evaluation:
 * - value: any expression.
 * - number: an expression that must give a single number.
 * - date: a date in quotes, "YYYY-MM-DD".
 * - reducer: a reducer name in quotes, e.g. "median".
 * - dateOrValue: a date in quotes, or an expression.
 */
export type ArgKind = 'value' | 'number' | 'date' | 'reducer' | 'dateOrValue';

/** What a function implementation sees of its call. */
export interface Call {
  readonly name: string;
  /** Number of arguments written. */
  readonly argc: number;
  /** The range the evaluation is restricted to, if any. */
  readonly range: DayRange | null;
  readonly today: DayNum;
  /** Evaluates argument i in the current (possibly restricted) context. */
  value(i: number): Value;
  /** Evaluates argument i over the whole history, ignoring any restriction. */
  wholeValue(i: number): Value;
  /** Argument i as a single finite number; `fallback` when it was not written. */
  number(i: number, fallback?: number): number;
  /** True when argument i is written as text in quotes. */
  isText(i: number): boolean;
  /** Argument i as a day (it must be a date in quotes). */
  date(i: number): DayNum;
  /** Argument i as a reducer name; `fallback` when it was not written. */
  reducer(i: number, fallback: Reducer): Reducer;
  /** An error pointing at argument i, or at the whole call. */
  error(message: string, i?: number): ExprError;
}

export interface FunctionSpec extends FunctionDoc {
  min: number;
  /** Infinity for any number of arguments (the last kind repeats). */
  max: number;
  args: readonly ArgKind[];
  /** Names accepted by 'reducer' arguments. */
  reducers?: readonly Reducer[];
  run(c: Call): Value;
}

function describe(v: Value): string {
  return v.kind === 'scalar' ? 'a single number' : v.kind === 'fn' ? 'a date function' : 'a series';
}

function seriesArg(c: Call, i = 0): Series {
  const v = c.value(i);
  if (v.kind !== 'series') throw c.error(`"${c.name}" needs a series, not ${describe(v)}`, i);
  return v;
}

function allValues(c: Call): Value[] {
  return Array.from({ length: c.argc }, (_, i) => c.value(i));
}

function aggregate(r: Reducer | 'stdev'): (c: Call) => Value {
  return (c) => {
    const x = c.value(0);
    if (x.kind === 'fn') throw c.error(`"${c.name}" needs a series, not a date function`, 0);
    if (x.kind === 'scalar') {
      // A single number counts as a series with one value.
      if (Number.isNaN(x.value)) return scalar(r === 'count' ? 0 : NaN);
      return scalar(reduce(Float64Array.of(x.value), r));
    }
    return scalar(reduce(x.v, r));
  };
}

function windowDays(c: Call): number {
  const n = c.number(1);
  if (!Number.isInteger(n) || n < 1) throw c.error(`The window of "${c.name}" must be a whole number of days, at least 1`, 1);
  return n;
}

/** First value of a series (NaN when empty), or the number itself. */
function firstOf(x: Series | Scalar): number {
  return x.kind === 'scalar' ? x.value : x.v.length > 0 ? x.v[0] : NaN;
}

/** Rounds half away from zero, without binary artefacts (round(1.005, 2) = 1.01). */
export function roundTo(x: number, digits: number): number {
  const f = 10 ** Math.abs(digits);
  const scaled = digits >= 0 ? Math.abs(x) * f : Math.abs(x) / f;
  const r = Math.round(Number(scaled.toPrecision(15)));
  const result = Math.sign(x) * (digits >= 0 ? r / f : r * f);
  return result === 0 ? 0 : result;
}

function math(name: string, f: (x: number) => number, description: string, example: string): FunctionSpec {
  return {
    name,
    category: 'math',
    signature: `${name}(x)`,
    description,
    example,
    min: 1,
    max: 1,
    args: ['value'],
    run: (c) => mapValue(c.value(0), f),
  };
}

function agg(name: string, r: Reducer | 'stdev', description: string, example: string): FunctionSpec {
  return {
    name,
    category: 'aggregate',
    signature: `${name}(x)`,
    description,
    example,
    min: 1,
    max: 1,
    args: ['value'],
    run: aggregate(r),
  };
}

function minMax(name: 'min' | 'max', pick: (...xs: number[]) => number): FunctionSpec {
  const word = name === 'min' ? 'smallest' : 'largest';
  return {
    name,
    category: 'aggregate',
    signature: `${name}(x) or ${name}(a, b, …)`,
    description:
      `With one argument, the ${word} value of a series. ` +
      `With two or more, the ${word} of the arguments on each day, e.g. ${name}(bank, 5000).`,
    example: name === 'min' ? 'min(weight)' : 'max(bank, 0)',
    min: 1,
    max: Infinity,
    args: ['value'],
    run: (c) => (c.argc === 1 ? aggregate(name)(c) : combine(allValues(c), (xs) => pick(...xs))),
  };
}

function bucketFn(name: string, bucket: Bucket, period: string, example: string): FunctionSpec {
  return {
    name,
    category: 'time',
    signature: `${name}(x, reducer = "last")`,
    description:
      `One value per ${period}, combining the points inside it with the reducer ` +
      `(last, first, sum, mean, median, min, max, delta or count). ` +
      'For a step series, the value in force when the period starts counts as its first point.',
    example,
    min: 1,
    max: 2,
    args: ['value', 'reducer'],
    run: (c) => bucketize(seriesArg(c), bucket, c.reducer(1, 'last')),
  };
}

const SPECS: FunctionSpec[] = [
  // --- Math ----------------------------------------------------------------
  math('abs', Math.abs, 'Absolute value: the value without its minus sign.', 'abs(change(weight))'),
  math('sqrt', Math.sqrt, 'Square root. Negative values have no result.', 'sqrt(steps)'),
  math('ln', Math.log, 'Natural logarithm. Zero and negative values have no result.', 'ln(networth)'),
  math('log10', Math.log10, 'Base-10 logarithm. Zero and negative values have no result.', 'log10(networth)'),
  math('exp', Math.exp, 'The number e raised to the power x.', 'exp(0.05 * days(bank) / 365)'),
  math('floor', Math.floor, 'Rounds down to a whole number.', 'floor(weight)'),
  math('ceil', Math.ceil, 'Rounds up to a whole number.', 'ceil(sleep)'),
  math(
    'sign',
    (x) => (x === 0 ? 0 : Math.sign(x)),
    '-1 for negative values, 1 for positive values and 0 for zero.',
    'sign(change(weight))',
  ),
  {
    name: 'round',
    category: 'math',
    signature: 'round(x, digits = 0)',
    description:
      'Rounds to the given number of decimals; halves round away from zero. ' +
      'Negative digits round to tens, hundreds…',
    example: 'round(bmi, 1)',
    min: 1,
    max: 2,
    args: ['value', 'number'],
    run: (c) => {
      const digits = c.number(1, 0);
      if (!Number.isInteger(digits) || Math.abs(digits) > 15) {
        throw c.error('The number of decimals must be a whole number from -15 to 15', 1);
      }
      return mapValue(c.value(0), (x) => roundTo(x, digits));
    },
  },
  {
    name: 'clamp',
    category: 'math',
    signature: 'clamp(x, lo, hi)',
    description: 'Limits x to the range from lo to hi.',
    example: 'clamp(sleep, 4, 10)',
    min: 3,
    max: 3,
    args: ['value'],
    run: (c) => combine(allValues(c), (xs) => Math.min(Math.max(xs[0], xs[1]), xs[2])),
  },

  // --- Aggregates ----------------------------------------------------------
  agg('first', 'first', 'The first value of a series.', 'first(weight)'),
  agg('last', 'last', 'The most recent value of a series.', 'last(bank)'),
  minMax('min', Math.min),
  minMax('max', Math.max),
  agg('mean', 'mean', 'The average of the values of a series.', 'mean(sleep)'),
  agg('avg', 'mean', 'Same as mean.', 'avg(sleep)'),
  agg('median', 'median', 'The middle value of a series: half of the values are above it, half below.', 'median(monthly_expenses)'),
  agg('sum', 'sum', 'The total of the values of a series.', 'sum(monthly_balance)'),
  agg('count', 'count', 'How many values a series has.', 'count(weight)'),
  agg('stdev', 'stdev', 'Sample standard deviation: how spread out the values are.', 'stdev(weight)'),
  agg('delta', 'delta', 'Change from the first to the last value, the same as last(x) - first(x).', 'delta(networth)'),

  // --- Transforms ----------------------------------------------------------
  {
    name: 'fill',
    category: 'transform',
    signature: 'fill(x, before?)',
    description:
      'Makes x a step series: each value holds until the next one, and the last one holds from then on. ' +
      'The optional second argument is the value before the first point, e.g. 0 for an account that did not exist yet.',
    example: 'bank + fill(stocks, 0)',
    min: 1,
    max: 2,
    args: ['value', 'number'],
    run: (c) => {
      const x = c.value(0);
      const before = c.argc > 1 ? c.number(1) : undefined;
      if (x.kind !== 'series') return x;
      return withStep(x, true, before ?? x.before);
    },
  },
  {
    name: 'nofill',
    category: 'transform',
    signature: 'nofill(x)',
    description: 'The opposite of fill: values no longer hold between points, so gaps stay gaps.',
    example: 'nofill(bank)',
    min: 1,
    max: 1,
    args: ['value'],
    run: (c) => {
      const x = c.value(0);
      return x.kind === 'series' ? withStep(x, false) : x;
    },
  },
  {
    name: 'rolling',
    category: 'transform',
    signature: 'rolling(x, n, reducer = "mean")',
    description:
      'For each point, combines the points of the last n calendar days (that day included) with the reducer: ' +
      'mean, median, sum, min, max, first, last, delta or count.',
    example: 'rolling(weight, 7, "median")',
    min: 2,
    max: 3,
    args: ['value', 'number', 'reducer'],
    run: (c) => rolling(seriesArg(c), windowDays(c), c.reducer(2, 'mean')),
  },
  {
    name: 'ma',
    category: 'transform',
    signature: 'ma(x, n)',
    description: 'Moving average over the last n calendar days, the same as rolling(x, n).',
    example: 'ma(weight, 7)',
    min: 2,
    max: 2,
    args: ['value', 'number'],
    run: (c) => rolling(seriesArg(c), windowDays(c), 'mean'),
  },
  {
    name: 'ema',
    category: 'transform',
    signature: 'ema(x, n)',
    description:
      'Exponential moving average over the points, with smoothing factor 2 / (n + 1): ' +
      'recent values weigh more than old ones.',
    example: 'ema(weight, 10)',
    min: 2,
    max: 2,
    args: ['value', 'number'],
    run: (c) => {
      const x = seriesArg(c);
      const n = c.number(1);
      if (n < 1) throw c.error('The span of "ema" must be at least 1', 1);
      return ema(x, n);
    },
  },
  {
    name: 'pct',
    category: 'transform',
    signature: 'pct(x, base?)',
    description:
      'Percent difference from a base: (x - base) / base * 100. ' +
      'Without a base, the first value of x is used (the first one in the visible range when a chart is filtered).',
    example: 'pct(stocks, 1000)',
    min: 1,
    max: 2,
    args: ['value', 'value'],
    run: (c) => {
      const x = c.value(0);
      let base: Value;
      if (c.argc > 1) {
        base = c.value(1);
        if (base.kind === 'scalar' && base.value === 0) throw c.error('The base of "pct" can\'t be 0', 1);
      } else {
        if (x.kind === 'fn') throw c.error('"pct" of a date function needs a base, like pct(x, 1000)', 0);
        const first = firstOf(x);
        if (first === 0) throw c.error('"pct" can\'t use a first value of 0 as its base. Give a base, like pct(x, 1000)', 0);
        base = scalar(first);
      }
      return combine([x, base], (xs) => ((xs[0] - xs[1]) / xs[1]) * 100);
    },
  },
  {
    name: 'rebase',
    category: 'transform',
    signature: 'rebase(x, to = 100)',
    description: 'Scales x so that its first value becomes `to` (100 by default), to compare how different things grow.',
    example: 'rebase(stocks)',
    min: 1,
    max: 2,
    args: ['value', 'number'],
    run: (c) => {
      const x = c.value(0);
      const to = c.number(1, 100);
      if (x.kind === 'fn') throw c.error('"rebase" needs a series, not a date function', 0);
      const first = firstOf(x);
      if (first === 0) throw c.error('"rebase" can\'t scale a series whose first value is 0', 0);
      return mapValue(x, (v) => (v / first) * to);
    },
  },
  {
    name: 'change',
    category: 'transform',
    signature: 'change(x)',
    description: 'Difference from the previous point. The first point has no previous one, so it is left out.',
    example: 'change(weight)',
    min: 1,
    max: 1,
    args: ['value'],
    run: (c) => differences(seriesArg(c), (cur, prev) => cur - prev),
  },
  {
    name: 'diff',
    category: 'transform',
    signature: 'diff(x)',
    description: 'Same as change.',
    example: 'diff(bank)',
    min: 1,
    max: 1,
    args: ['value'],
    run: (c) => differences(seriesArg(c), (cur, prev) => cur - prev),
  },
  {
    name: 'pctchange',
    category: 'transform',
    signature: 'pctchange(x)',
    description: 'Percent change from the previous point: (x - previous) / |previous| * 100.',
    example: 'pctchange(networth)',
    min: 1,
    max: 1,
    args: ['value'],
    run: (c) => differences(seriesArg(c), (cur, prev) => ((cur - prev) / Math.abs(prev)) * 100),
  },
  {
    name: 'cumsum',
    category: 'transform',
    signature: 'cumsum(x)',
    description: 'Running total of the values.',
    example: 'cumsum(monthly_balance)',
    min: 1,
    max: 1,
    args: ['value'],
    run: (c) => {
      const x = seriesArg(c);
      const out = new SeriesBuilder(x.t.length);
      let total = 0;
      for (let i = 0; i < x.t.length; i++) {
        total += x.v[i];
        out.push(x.t[i], total);
      }
      return out.build(x.step);
    },
  },

  // --- Time ------------------------------------------------------------------
  {
    name: 'daily',
    category: 'time',
    signature: 'daily(x)',
    description:
      'One value per day, each day holding the latest value, from the first point until today ' +
      '(or until the end of the range when a chart is filtered).',
    example: 'daily(monthly_need)',
    min: 1,
    max: 1,
    args: ['value'],
    run: (c) => {
      const x = c.value(0);
      return x.kind === 'series' ? daily(x, c.today, c.range) : x;
    },
  },
  {
    name: 'interp',
    category: 'time',
    signature: 'interp(x)',
    description: 'Fills every day between two points with a straight line from one to the next.',
    example: 'interp(weight)',
    min: 1,
    max: 1,
    args: ['value'],
    run: (c) => {
      const x = c.value(0);
      return x.kind === 'series' ? interp(x) : x;
    },
  },
  {
    name: 'days',
    category: 'time',
    signature: 'days(x)',
    description: 'On each point of x, the number of days since its first point (0 on the first point).',
    example: 'days(weight)',
    min: 1,
    max: 1,
    args: ['value'],
    run: (c) => {
      const x = seriesArg(c);
      const out = new SeriesBuilder(x.t.length);
      for (let i = 0; i < x.t.length; i++) out.push(x.t[i], x.t[i] - x.t[0]);
      return out.build(false);
    },
  },
  {
    name: 'since',
    category: 'time',
    signature: 'since("YYYY-MM-DD") or since(x)',
    description:
      'Days elapsed since a date, defined on every day (negative before it). ' +
      'Given a series instead, counts from its first point; that start never moves, even when a chart is filtered.',
    example: 'since("2021-03-01")',
    min: 1,
    max: 1,
    args: ['dateOrValue'],
    run: (c) => {
      if (c.isText(0)) {
        const start = c.date(0);
        return dateFn((day) => day - start);
      }
      const x = c.wholeValue(0);
      if (x.kind !== 'series') throw c.error('"since" needs a date in quotes, like since("2021-03-01"), or a series', 0);
      const start = x.t.length > 0 ? x.t[0] : NaN;
      return dateFn((day) => day - start);
    },
  },
  {
    name: 'between',
    category: 'time',
    signature: 'between(x, "from", "to"?)',
    description:
      'Keeps the points between two dates, both included. Without the end date, keeps everything from the start date on. ' +
      'A step series gets a point on the start date with the value in force then.',
    example: 'between(weight, "2024-01-01", "2024-06-30")',
    min: 2,
    max: 3,
    args: ['value', 'date', 'date'],
    run: (c) => {
      const x = c.value(0);
      const from = c.date(1);
      const to = c.argc > 2 ? c.date(2) : Infinity;
      if (x.kind === 'scalar') return x;
      if (x.kind === 'fn') throw c.error('"between" needs a series, not a date function', 0);
      return clip(x, from, to);
    },
  },
  {
    name: 'shift',
    category: 'time',
    signature: 'shift(x, n)',
    description: 'Moves every point n days later; a negative n moves them earlier.',
    example: 'weight - shift(weight, 7)',
    min: 2,
    max: 2,
    args: ['value', 'number'],
    run: (c) => {
      const x = c.value(0);
      const n = c.number(1);
      if (!Number.isInteger(n)) throw c.error('"shift" needs a whole number of days', 1);
      if (x.kind === 'scalar') return x;
      if (x.kind === 'fn') {
        const at = x.at;
        return dateFn((day) => at(day - n));
      }
      const moved = shiftSeries(x, n);
      return c.range ? clip(moved, c.range.from, c.range.to) : moved;
    },
  },
  bucketFn('weekly', 'week', 'week (Monday to Sunday), dated on its Monday', 'weekly(weight, "mean")'),
  bucketFn('monthly', 'month', 'calendar month, dated on the 1st', 'monthly(bank)'),
  bucketFn('quarterly', 'quarter', 'quarter, dated on its first day', 'quarterly(networth, "delta")'),
  bucketFn('yearly', 'year', 'calendar year, dated on January 1', 'yearly(monthly_expenses, "sum")'),

  // --- Logic -----------------------------------------------------------------
  {
    name: 'if',
    category: 'logic',
    signature: 'if(condition, a, b)',
    description:
      'a where the condition is true (not 0) and b elsewhere. ' +
      'Comparisons such as weight > 80 give 1 when true and 0 when false.',
    example: 'if(weight > 80, weight - 80, 0)',
    min: 3,
    max: 3,
    args: ['value'],
    run: (c) => combine(allValues(c), (xs) => (Number.isNaN(xs[0]) ? NaN : xs[0] !== 0 ? xs[1] : xs[2])),
  },
];

function differences(x: Series, f: (cur: number, prev: number) => number): Series {
  const out = new SeriesBuilder(x.t.length);
  for (let i = 1; i < x.t.length; i++) out.push(x.t[i], f(x.v[i], x.v[i - 1]));
  return out.build(false);
}

/** Every function, by name. */
export const FUNCTIONS: ReadonlyMap<string, FunctionSpec> = new Map(SPECS.map((s) => [s.name, s]));

/** Documentation of every function, for autocomplete and the formula reference. */
export const FUNCTION_DOCS: readonly FunctionDoc[] = SPECS.map(({ name, signature, description, example, category }) => ({
  name,
  signature,
  description,
  example,
  category,
}));
