import { describe, expect, it } from 'vitest';
import { FUNCTION_DOCS, FUNCTIONS, roundTo } from './functions';
import { asNumber, asSeries, d, makeSource, pts } from './testkit';
import { ExprError, type Value } from './types';
import { Workspace } from './workspace';

// Made-up data. 2024-01-01 is a Monday.
const src = makeSource({
  today: '2024-01-08',
  metrics: [
    {
      slug: 'weight',
      points: [
        ['2024-01-01', 80],
        ['2024-01-02', 79.5],
        ['2024-01-04', 79],
        ['2024-01-05', 78.5],
        ['2024-01-08', 78],
      ],
    },
    { slug: 'height', fill: 'step', points: [['2024-01-01', 180], ['2024-01-04', 181]] },
    { slug: 'bank', fill: 'step', points: [['2024-01-01', 1000], ['2024-01-03', 1200], ['2024-01-06', 900]] },
    { slug: 'stocks', fill: 'step', points: [['2024-01-03', 500], ['2024-01-05', 550]] },
    { slug: 'neg', points: [['2024-01-01', -4], ['2024-01-02', 0], ['2024-01-03', 9]] },
    { slug: 'zero_start', points: [['2024-01-01', 0], ['2024-01-02', 5]] },
    { slug: 'empty' },
  ],
  formulas: { networth: 'bank + fill(stocks, 0)' },
});
const ws = new Workspace(src);
const ev = (expr: string): Value => ws.evalExpr(expr);
const values = (expr: string): number[] => Array.from(asSeries(ev(expr)).v);
const num = (expr: string): number => asNumber(ev(expr));

function failure(expr: string): ExprError {
  try {
    ev(expr);
  } catch (e) {
    if (e instanceof ExprError) return e;
    throw e;
  }
  throw new Error(`expected "${expr}" to fail`);
}

describe('math functions', () => {
  it('apply elementwise and drop points without a result', () => {
    expect(values('abs(neg)')).toEqual([4, 0, 9]);
    expect(pts(ev('sqrt(neg)'))).toEqual([
      ['2024-01-02', 0],
      ['2024-01-03', 3],
    ]);
    expect(pts(ev('ln(neg)'))).toEqual([['2024-01-03', Math.log(9)]]);
    expect(values('sign(neg)')).toEqual([-1, 0, 1]);
    expect(values('clamp(neg, 0, 5)')).toEqual([0, 0, 5]);
  });

  it('work on plain numbers', () => {
    expect(num('log10(1000)')).toBe(3);
    expect(num('exp(0)')).toBe(1);
    expect(num('floor(-2.5)')).toBe(-3);
    expect(num('ceil(-2.5)')).toBe(-2);
    expect(num('sqrt(-1)')).toBeNaN();
    expect(num('sign(0)')).toBe(0);
  });

  it('round halves away from zero and avoids binary artefacts', () => {
    expect(num('round(2.5)')).toBe(3);
    expect(num('round(-2.5)')).toBe(-3);
    expect(num('round(1.005, 2)')).toBe(1.01);
    expect(num('round(1234.5, -2)')).toBe(1200);
    expect(num('round(-0.4)')).toBe(0);
    expect(Object.is(roundTo(-0.4, 0), 0)).toBe(true);
    expect(values('round(weight / 3, 1)')).toEqual([26.7, 26.5, 26.3, 26.2, 26]);
    expect(failure('round(weight, 1.5)').message).toBe('The number of decimals must be a whole number from -15 to 15');
  });

  it('min and max are elementwise with two or more arguments', () => {
    const r = asSeries(ev('min(bank, 1000)'));
    expect(r.step).toBe(true);
    expect(Array.from(r.v)).toEqual([1000, 1000, 900]);
    expect(values('max(weight, 79)')).toEqual([80, 79.5, 79, 79, 79]);
    expect(num('max(1, 5, 3)')).toBe(5);
    expect(num('min(4, 2, 8)')).toBe(2);
  });
});

describe('aggregates', () => {
  it.each([
    ['first(weight)', 80],
    ['last(weight)', 78],
    ['min(weight)', 78],
    ['max(weight)', 80],
    ['mean(weight)', 79],
    ['avg(weight)', 79],
    ['median(weight)', 79],
    ['sum(weight)', 395],
    ['count(weight)', 5],
    ['delta(weight)', -2],
    ['last(bank) - first(bank)', -100],
  ])('%s = %d', (expr, expected) => {
    expect(num(expr)).toBe(expected);
  });

  it('stdev is the sample standard deviation', () => {
    expect(num('stdev(weight)')).toBeCloseTo(Math.sqrt(2.5 / 4), 12);
  });

  it('treat a plain number as a single value', () => {
    expect(num('sum(5)')).toBe(5);
    expect(num('count(5)')).toBe(1);
    expect(num('delta(5)')).toBe(0);
    expect(num('stdev(5)')).toBeNaN();
    expect(num('count(first(empty))')).toBe(0);
  });

  it('give NaN (no data) for an empty series, except count', () => {
    expect(num('mean(empty)')).toBeNaN();
    expect(num('sum(empty)')).toBeNaN();
    expect(num('count(empty)')).toBe(0);
    expect(num('first(empty) + 1')).toBeNaN();
  });

  it('reject date functions', () => {
    const e = failure('mean(since("2024-01-01"))');
    expect(e.message).toBe('"mean" needs a series, not a date function');
    expect(e.span).toEqual({ start: 5, end: 24 });
  });
});

describe('fill and resampling', () => {
  it('fill makes a step series, optionally with a value before the first point', () => {
    const f = asSeries(ev('fill(stocks, 0)'));
    expect(f.step).toBe(true);
    expect(f.before).toBe(0);
    expect(asSeries(ev('fill(weight)')).step).toBe(true);
    expect(num('fill(5)')).toBe(5);
    expect(pts(ev('bank + fill(stocks, 0)'))).toEqual([
      ['2024-01-01', 1000],
      ['2024-01-03', 1700],
      ['2024-01-05', 1750],
      ['2024-01-06', 1450],
    ]);
    // Without fill, the sum only starts once both exist.
    expect(pts(ev('bank + stocks'))).toEqual([
      ['2024-01-03', 1700],
      ['2024-01-05', 1750],
      ['2024-01-06', 1450],
    ]);
  });

  it('nofill turns a step series into plain points', () => {
    const r = asSeries(ev('nofill(fill(stocks, 0))'));
    expect(r.step).toBe(false);
    expect(r.before).toBeUndefined();
    // As plain points, weight and bank only meet on days both have an entry.
    expect(pts(ev('weight + nofill(bank)'))).toEqual([['2024-01-01', 1080]]);
  });

  it('daily holds the latest value on every day until today', () => {
    expect(values('daily(bank)')).toEqual([1000, 1000, 1200, 1200, 1200, 900, 900, 900]);
    expect(pts(ev('daily(bank)'))[7][0]).toBe('2024-01-08');
    expect(num('daily(5)')).toBe(5);
  });

  it('interp fills days with straight lines', () => {
    const r = pts(ev('interp(weight)'));
    expect(r.map((p) => p[0])).toEqual([
      '2024-01-01',
      '2024-01-02',
      '2024-01-03',
      '2024-01-04',
      '2024-01-05',
      '2024-01-06',
      '2024-01-07',
      '2024-01-08',
    ]);
    expect(r[2][1]).toBeCloseTo(79.25, 12);
    expect(r[5][1]).toBeCloseTo(78 + 1 / 3, 12);
  });
});

describe('windows and smoothing', () => {
  it('rolling uses calendar days, with mean by default', () => {
    expect(values('rolling(weight, 3)')).toEqual([80, 79.75, 79.25, 78.75, 78]);
    expect(values('rolling(weight, 3, "max")')).toEqual([80, 80, 79.5, 79, 78]);
    expect(values('rolling(weight, 3, "count")')).toEqual([1, 2, 2, 2, 1]);
    expect(values('ma(weight, 3)')).toEqual(values('rolling(weight, 3, "mean")'));
  });

  it('ema smooths with alpha = 2 / (n + 1)', () => {
    expect(values('ema(weight, 3)')).toEqual([80, 79.75, 79.375, 78.9375, 78.46875]);
  });

  it('check their window', () => {
    expect(failure('rolling(weight, 0)').message).toBe('The window of "rolling" must be a whole number of days, at least 1');
    expect(failure('ma(weight, 2.5)').message).toBe('The window of "ma" must be a whole number of days, at least 1');
    expect(failure('ema(weight, 0)').message).toBe('The span of "ema" must be at least 1');
    const e = failure('rolling(weight, weight)');
    expect(e.message).toBe('The 2nd argument of "rolling" must be a single number, not a series');
    expect(e.span).toEqual({ start: 16, end: 22 });
    expect(failure('rolling(weight, since("2024-01-01"))').message).toBe(
      'The 2nd argument of "rolling" must be a single number, not a date function',
    );
    expect(failure('rolling(weight, first(empty))').message).toBe(
      'The 2nd argument of "rolling" has no value: there is no data to compute it from',
    );
    const notSeries = failure('rolling(5, 3)');
    expect(notSeries.message).toBe('"rolling" needs a series, not a single number');
    expect(notSeries.span).toEqual({ start: 8, end: 9 });
  });
});

describe('relative values', () => {
  it('pct compares to the first value by default, or to a base', () => {
    expect(values('pct(weight)')).toEqual([0, -0.625, -1.25, -1.875, -2.5]);
    expect(values('pct(weight, 100)')).toEqual([-20, -20.5, -21, -21.5, -22]);
    const filled = asSeries(ev('pct(fill(stocks, 0), 500)'));
    expect(Array.from(filled.v)).toEqual([0, 10]);
    expect(filled.before).toBe(-100);
    expect(num('pct(5)')).toBe(0);
  });

  it('pct refuses a base of 0', () => {
    expect(failure('pct(weight, 0)').message).toBe('The base of "pct" can\'t be 0');
    expect(failure('pct(zero_start)').message).toBe(
      '"pct" can\'t use a first value of 0 as its base. Give a base, like pct(x, 1000)',
    );
    expect(failure('pct(since("2024-01-01"))').message).toBe('"pct" of a date function needs a base, like pct(x, 1000)');
    expect(pts(ev('weight * 0 + pct(since("2023-12-31"), 1)'))[1]).toEqual(['2024-01-02', 100]);
  });

  it('rebase scales the first value to 100 or to a given value', () => {
    expect(values('rebase(weight)')).toEqual([100, 99.375, 98.75, 98.125, 97.5]);
    expect(values('rebase(weight, 1)')).toEqual([1, 0.99375, 0.9875, 0.98125, 0.975]);
    expect(failure('rebase(zero_start)').message).toBe('"rebase" can\'t scale a series whose first value is 0');
    expect(failure('rebase(since("2024-01-01"))').message).toBe('"rebase" needs a series, not a date function');
  });

  it('change, diff and pctchange compare with the previous point', () => {
    expect(pts(ev('change(weight)'))).toEqual([
      ['2024-01-02', -0.5],
      ['2024-01-04', -0.5],
      ['2024-01-05', -0.5],
      ['2024-01-08', -0.5],
    ]);
    const r = asSeries(ev('diff(bank)'));
    expect(r.step).toBe(false);
    expect(pts(r)).toEqual([
      ['2024-01-03', 200],
      ['2024-01-06', -300],
    ]);
    expect(values('pctchange(bank)')).toEqual([20, -25]);
    expect(values('pctchange(neg)')).toEqual([100]);
  });

  it('cumsum adds up values', () => {
    expect(values('cumsum(weight)')).toEqual([80, 159.5, 238.5, 317, 395]);
    expect(asSeries(ev('cumsum(bank)')).step).toBe(true);
  });
});

describe('time functions', () => {
  it('days counts from the first point', () => {
    expect(values('days(weight)')).toEqual([0, 1, 3, 4, 7]);
    expect(failure('days(5)').message).toBe('"days" needs a series, not a single number');
  });

  it('since a date is defined on every day', () => {
    const f = ev('since("2024-01-01")');
    expect(f.kind).toBe('fn');
    expect(f.kind === 'fn' && f.at(d('2024-01-11'))).toBe(10);
    expect(f.kind === 'fn' && f.at(d('2023-12-31'))).toBe(-1);
    expect(values('weight * 0 + since("2024-01-01")')).toEqual([0, 1, 3, 4, 7]);
  });

  it('since a series counts from its first point', () => {
    expect(values('weight * 0 + since(stocks)')).toEqual([-2, -1, 1, 2, 5]);
    expect(failure('since(2021-03-01)').message).toBe(
      '"since" needs a date in quotes, like since("2021-03-01"), or a series',
    );
    expect(failure('since(since("2024-01-01"))').message).toBe(
      '"since" needs a date in quotes, like since("2021-03-01"), or a series',
    );
    const none = ev('since(empty)');
    expect(none.kind === 'fn' && none.at(0)).toBeNaN();
  });

  it('between keeps an inclusive range, open-ended without an end date', () => {
    expect(pts(ev('between(weight, "2024-01-02", "2024-01-05")'))).toEqual([
      ['2024-01-02', 79.5],
      ['2024-01-04', 79],
      ['2024-01-05', 78.5],
    ]);
    const r = asSeries(ev('between(bank, "2024-01-02")'));
    expect(r.step).toBe(true);
    expect(pts(r)).toEqual([
      ['2024-01-02', 1000],
      ['2024-01-03', 1200],
      ['2024-01-06', 900],
    ]);
    expect(num('between(5, "2024-01-01")')).toBe(5);
    expect(failure('between(since("2024-01-01"), "2024-01-01")').message).toBe(
      '"between" needs a series, not a date function',
    );
  });

  it('shift moves points in time', () => {
    expect(pts(ev('shift(weight, 1)')).map((p) => p[0])).toEqual([
      '2024-01-02',
      '2024-01-03',
      '2024-01-05',
      '2024-01-06',
      '2024-01-09',
    ]);
    expect(pts(ev('shift(weight, -1)'))[0]).toEqual(['2023-12-31', 80]);
    expect(pts(ev('weight - shift(weight, 1)'))).toEqual([
      ['2024-01-02', -0.5],
      ['2024-01-05', -0.5],
    ]);
    const f = ev('shift(since("2024-01-01"), 2)');
    expect(f.kind === 'fn' && f.at(d('2024-01-03'))).toBe(0);
    expect(failure('shift(weight, 0.5)').message).toBe('"shift" needs a whole number of days');
  });

  it('weekly, monthly, quarterly and yearly reduce per calendar bucket', () => {
    expect(pts(ev('weekly(weight)'))).toEqual([
      ['2024-01-01', 78.5],
      ['2024-01-08', 78],
    ]);
    expect(pts(ev('monthly(weight, "mean")'))).toEqual([['2024-01-01', 79]]);
    expect(pts(ev('quarterly(bank, "delta")'))).toEqual([['2024-01-01', -100]]);
    expect(pts(ev('yearly(weight, "count")'))).toEqual([['2024-01-01', 5]]);
    expect(asSeries(ev('monthly(bank)')).step).toBe(false);
    expect(failure('weekly(5)').message).toBe('"weekly" needs a series, not a single number');
  });
});

describe('logic and comparisons', () => {
  it('comparisons give 1 or 0', () => {
    expect(values('weight > 79')).toEqual([1, 1, 0, 0, 0]);
    expect(values('weight >= 79')).toEqual([1, 1, 1, 0, 0]);
    expect(values('weight < 79')).toEqual([0, 0, 0, 1, 1]);
    expect(values('weight <= 79')).toEqual([0, 0, 1, 1, 1]);
    expect(values('weight == 79')).toEqual([0, 0, 1, 0, 0]);
    expect(values('weight != 79')).toEqual([1, 1, 0, 1, 1]);
    expect(num('first(empty) < 3')).toBeNaN();
  });

  it('if picks elementwise and aligns all three arguments', () => {
    expect(values('if(weight > 79, 1, 0)')).toEqual([1, 1, 0, 0, 0]);
    expect(values('if(weight > 79, weight, bank)')).toEqual([80, 79.5, 1200, 1200, 900]);
    expect(num('if(first(empty), 1, 2)')).toBeNaN();
    expect(num('if(0, 1, 2)')).toBe(2);
  });
});

describe('static checks of calls', () => {
  const invalid = (expr: string): ExprError => {
    const r = ws.validate(expr);
    if (r.ok) throw new Error(`expected "${expr}" to be invalid`);
    return r.error;
  };

  it.each([
    ['rolling(weight)', '"rolling" needs 2 or 3 arguments'],
    ['abs()', '"abs" needs 1 argument'],
    ['abs(weight, 2)', '"abs" needs 1 argument'],
    ['if(1, 2)', '"if" needs 3 arguments'],
    ['min()', '"min" needs at least 1 argument'],
    ['round(1, 2, 3)', '"round" needs 1 or 2 arguments'],
  ])('%s', (expr, message) => {
    const e = invalid(expr);
    expect(e.message).toBe(message);
    expect(e.span).toEqual({ start: 0, end: expr.length });
  });

  it('checks reducer names', () => {
    const typo = invalid('rolling(weight, 7, "medain")');
    expect(typo.message).toBe('Unknown reducer "medain". Did you mean "median"?');
    expect(typo.hint).toBe('"median"');
    expect(typo.span).toEqual({ start: 19, end: 27 });
    expect(invalid('weekly(weight, "foo")').message).toBe(
      'Unknown reducer "foo". Use one of: last, first, sum, mean, median, min, max, delta, count',
    );
    const bare = invalid('rolling(weight, 7, median)');
    expect(bare.message).toBe('Put the reducer name in quotes: "median"');
    expect(bare.hint).toBe('"median"');
    expect(invalid('rolling(weight, 7, 3)').message).toBe(
      'The 3rd argument of "rolling" must be a reducer name in quotes, like "median"',
    );
  });

  it('checks dates', () => {
    expect(invalid('between(weight, 2024-01-01)').message).toBe(
      'The 2nd argument of "between" must be a date in quotes, like "2021-03-01"',
    );
    const bad = invalid('since("2021-02-30")');
    expect(bad.message).toBe('Invalid date "2021-02-30". Write dates as "YYYY-MM-DD", like "2021-03-01"');
    expect(bad.span).toEqual({ start: 6, end: 18 });
    expect(invalid('between(weight, "2024-02-01", "2024-01-01")').message).toBe('The end date is before the start date');
  });

  it('only allows text where a date or reducer is expected', () => {
    expect(invalid('weight + "abc"').message).toBe(
      'Text in quotes is only used for dates (like "2021-03-01") and reducer names (like "median")',
    );
    const quoted = invalid('ma("weight", 7)');
    expect(quoted.message).toBe('Remove the quotes around "weight" to use its values');
    expect(quoted.hint).toBe('weight');
    expect(invalid('rolling(weight, "7")').message).toBe('The 2nd argument of "rolling" must be a number, not text in quotes');
  });

  it('tells functions and names apart', () => {
    expect(invalid('sum').message).toBe('"sum" is a function: use it like sum(x)');
    expect(invalid('weight(3)').message).toBe('"weight" is not a function. Remove the parentheses to use its values');
    const typo = invalid('rollin(weight, 7)');
    expect(typo.message).toBe('Unknown function "rollin". Did you mean "rolling"?');
    expect(typo.span).toEqual({ start: 0, end: 6 });
    expect(typo.hint).toBe('rolling');
    expect(invalid('foo(1)').message).toBe('Unknown function "foo"');
  });
});

describe('function table', () => {
  it('documents every function', () => {
    expect(FUNCTION_DOCS.map((f) => f.name)).toEqual([...FUNCTIONS.keys()]);
    for (const doc of FUNCTION_DOCS) {
      expect(doc.signature.startsWith(`${doc.name}(`)).toBe(true);
      expect(doc.description.length).toBeGreaterThan(10);
      expect(['math', 'time', 'aggregate', 'transform', 'logic']).toContain(doc.category);
    }
  });

  it('has every function the language promises', () => {
    const expected = [
      'abs sqrt ln log10 exp floor ceil sign round clamp min max',
      'first last mean avg median sum count stdev delta',
      'fill nofill daily interp rolling ma ema pct rebase change diff pctchange cumsum',
      'days since between shift weekly monthly quarterly yearly if',
    ]
      .join(' ')
      .split(' ');
    expect([...FUNCTIONS.keys()].sort()).toEqual(expected.sort());
  });
});
