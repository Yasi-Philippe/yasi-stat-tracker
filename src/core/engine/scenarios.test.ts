/**
 * End-to-end scenarios on synthetic data. Each expectation is computed
 * independently from the generated points, not with engine code.
 */

import { describe, expect, it } from 'vitest';
import { fromDayNum, monthEnd, type DayNum } from '../model/dates';
import type { ChartSpec, Period } from '../model/types';
import { evaluateChart } from './chart';
import { asSeries, d, makeSource, rng, walk } from './testkit';
import type { CategoryChartData, ChartData, ElapsedChartData, MultiplesChartData, OhlcChartData, TimeChartData } from './types';
import { Workspace } from './workspace';

type Pts = Array<[DayNum, number]>;
const TODAY = '2026-10-11';

/** Value in force on a day for step data, or undefined before the first point. */
function inForce(points: Pts, day: DayNum): number | undefined {
  let value: number | undefined;
  for (const [t, v] of points) {
    if (t > day) break;
    value = v;
  }
  return value;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

const chart = (over: Partial<ChartSpec>): ChartSpec => ({
  id: 'c',
  title: 'Chart',
  kind: 'line',
  x: { mode: 'date' },
  series: [],
  view: { preset: 'all' },
  ...over,
});

function as<M extends ChartData['mode']>(data: ChartData, mode: M): Extract<ChartData, { mode: M }> {
  expect(data.mode).toBe(mode);
  return data as Extract<ChartData, { mode: M }>;
}

describe('1. BMI from daily weight and a height that changes once', () => {
  const random = rng(1);
  const weight = walk(random, d('2024-01-01'), d('2024-12-31'), 85, { drift: -0.02, noise: 0.3, skip: 0.3 });
  const heightPts: Pts = [
    [d('2024-01-01'), 175],
    [d('2024-06-15'), 176],
  ];
  const src = makeSource({
    today: TODAY,
    metrics: [
      { slug: 'weight', points: weight },
      { slug: 'height', fill: 'step', cadence: 'sparse', points: heightPts },
    ],
    formulas: { bmi: 'weight / (height / 100) ^ 2' },
  });

  it('uses the height in force on each weighing day', () => {
    const bmi = asSeries(new Workspace(src).value('bmi'));
    expect(bmi.step).toBe(false);
    expect(Array.from(bmi.t)).toEqual(weight.map((p) => p[0]));
    weight.forEach(([day, w], i) => {
      const h = day < d('2024-06-15') ? 175 : 176;
      expect(bmi.v[i]).toBeCloseTo(w / (h / 100) ** 2, 10);
    });
    // Missing days stay missing.
    expect(bmi.t.length).toBeLessThan(366);
  });
});

describe('2. Weight-loss campaigns, one panel each', () => {
  const random = rng(2);
  const weight = walk(random, d('2024-01-01'), d(TODAY), 90, { drift: -0.01, noise: 0.4, skip: 0.2 });
  const campaigns: Period[] = [
    { id: 'c2', setId: 'cuts', name: 'New year', start: '2025-01-10', end: '2025-02-20' },
    { id: 'c1', setId: 'cuts', name: 'First try', start: '2024-02-01', end: '2024-03-15' },
    { id: 'c3', setId: 'cuts', name: 'Autumn', start: '2026-09-01', end: null },
  ];
  const src = makeSource({
    today: TODAY,
    metrics: [{ slug: 'weight', points: weight }],
    periodSets: [{ id: 'cuts', slug: 'cuts', name: 'Cuts', kind: 'campaign', order: 0 }],
    periods: campaigns,
  });

  it('draws only the data of each campaign, the open one ending today', () => {
    const spec = chart({ series: [{ id: 'w', expr: 'weight' }], filter: { setId: 'cuts', period: 'each' } });
    const data: MultiplesChartData = as(evaluateChart(spec, new Workspace(src), src), 'multiples');
    expect(data.errors).toEqual([]);
    expect(data.panels.map((p) => p.period.name)).toEqual(['First try', 'New year', 'Autumn']);
    const ranges: Array<[string, string]> = [
      ['2024-02-01', '2024-03-15'],
      ['2025-01-10', '2025-02-20'],
      ['2026-09-01', TODAY],
    ];
    data.panels.forEach((panel, i) => {
      const [from, to] = ranges[i].map(d);
      const time: TimeChartData = as(panel.data, 'time');
      expect(time.domain).toEqual({ min: from, max: to });
      expect(time.series[0].points).toEqual(weight.filter(([t]) => t >= from && t <= to));
    });
  });
});

// Money: a daily bank balance, and two investments that start later.
const money = (() => {
  const random = rng(3);
  const bank = walk(random, d('2019-01-01'), d(TODAY), 5000, { drift: 3, noise: 50 });
  const stocks = walk(random, d('2021-06-01'), d(TODAY), 1000, { drift: 0.5, noise: 10, skip: 0.1 });
  const savings = walk(random, d('2022-03-15'), d(TODAY), 500, { drift: 0.1, noise: 5, skip: 0.5 });
  const lifetime: Pts = [
    [d('2021-03-01'), 900_000],
    [d('2023-01-01'), 950_000],
    [d('2025-06-01'), 1_000_000],
  ];
  const monthly: Pts = [
    [d('2021-03-01'), 2500],
    [d('2022-07-01'), 2700],
    [d('2024-09-01'), 2900],
  ];
  const src = makeSource({
    today: TODAY,
    metrics: [
      { slug: 'bank', fill: 'step', points: bank },
      { slug: 'stocks', fill: 'step', points: stocks },
      { slug: 'savings', fill: 'step', points: savings },
      { slug: 'lifetime_need', fill: 'step', cadence: 'sparse', points: lifetime },
      { slug: 'monthly_need', fill: 'step', cadence: 'sparse', points: monthly },
    ],
    formulas: {
      networth: 'bank + fill(stocks, 0) + fill(savings, 0)',
      fi_literal: 'networth / (lifetime_need - since("2021-03-01") * monthly_need / 30.4375) * 100',
      fi: 'networth / (lifetime_need - since("2021-03-01") * daily(monthly_need) / 30.4375) * 100',
      fi_since: 'networth / (lifetime_need - since(lifetime_need) * daily(monthly_need) / 30.4375) * 100',
    },
  });
  const networthAt = (day: DayNum): number | undefined => {
    const b = inForce(bank, day);
    return b === undefined ? undefined : b + (inForce(stocks, day) ?? 0) + (inForce(savings, day) ?? 0);
  };
  return { bank, stocks, savings, lifetime, monthly, src, networthAt };
})();

describe('3. Net worth from a bank account and two later investments', () => {
  const { src, stocks, savings, networthAt } = money;
  const ws = new Workspace(src);

  it('counts investments as 0 before they existed', () => {
    const nw = asSeries(ws.value('networth'));
    expect(nw.step).toBe(true);
    expect(nw.t[0]).toBe(d('2019-01-01'));
    expect(nw.t.length).toBe(d(TODAY) - d('2019-01-01') + 1);
    for (const iso of ['2019-01-01', '2021-05-31', '2021-06-01', '2022-03-15', '2023-07-04', TODAY]) {
      const i = Array.from(nw.t).indexOf(d(iso));
      expect(nw.v[i]).toBeCloseTo(networthAt(d(iso)) ?? NaN, 6);
    }
  });

  it('compares investments by days since each one started', () => {
    const spec = chart({
      x: { mode: 'elapsed' },
      series: [
        { id: 'stocks', expr: 'pct(stocks, 1000)' },
        { id: 'savings', expr: 'pct(savings, 500)' },
      ],
    });
    const data: ElapsedChartData = as(evaluateChart(spec, ws, src), 'elapsed');
    expect(data.errors).toEqual([]);
    const [e, c] = data.series;
    expect(e.startDay).toBe(stocks[0][0]);
    expect(c.startDay).toBe(savings[0][0]);
    expect(e.points[0]).toEqual([1, ((stocks[0][1] - 1000) / 1000) * 100]);
    expect(e.points.map((p) => p[0])).toEqual(stocks.map(([t]) => t - stocks[0][0] + 1));
    expect(c.points.at(-1)?.[1]).toBeCloseTo(((savings[savings.length - 1][1] - 500) / 500) * 100, 10);
  });

  it('and on real dates', () => {
    const spec = chart({ series: [{ id: 'stocks', expr: 'pct(stocks, 1000)' }, { id: 'savings', expr: 'pct(savings, 500)' }] });
    const data: TimeChartData = as(evaluateChart(spec, ws, src), 'time');
    expect(data.domain).toEqual({ min: stocks[0][0], max: d(TODAY) });
    expect(data.series[0].step).toBe(true);
    expect(data.series[1].points[0]).toEqual([savings[0][0], ((savings[0][1] - 500) / 500) * 100]);
  });
});

describe('4. Yearly surplus as bars', () => {
  const { src, networthAt } = money;

  it('is the change in net worth over each calendar year', () => {
    const spec = chart({
      kind: 'bar',
      x: { mode: 'bucket', bucket: 'year' },
      series: [{ id: 'surplus', expr: 'last(networth) - first(networth)' }],
    });
    const data: CategoryChartData = as(evaluateChart(spec, new Workspace(src), src), 'category');
    expect(data.categories.map((c) => c.label)).toEqual(['2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026']);
    data.categories.forEach((cat, i) => {
      const end = Math.min(cat.to, d(TODAY));
      const expected = (networthAt(end) ?? NaN) - (networthAt(cat.from) ?? NaN);
      expect(data.series[0].values[i]).toBeCloseTo(expected, 6);
    });
  });
});

describe('5. Financial-independence level', () => {
  const { src, lifetime, monthly, networthAt } = money;
  const level = (day: DayNum, start: DayNum): number =>
    ((networthAt(day) ?? NaN) /
      ((inForce(lifetime, day) ?? NaN) - ((day - start) * (inForce(monthly, day) ?? NaN)) / 30.4375)) *
    100;

  it('combining a step series with since() samples it on its change days', () => {
    const fi = asSeries(new Workspace(src).value('fi_literal'));
    expect(fi.step).toBe(false);
    expect(Array.from(fi.t)).toEqual(monthly.map((p) => p[0]));
    fi.t.forEach((day, i) => expect(fi.v[i]).toBeCloseTo(level(day, d('2021-03-01')), 8));
  });

  it('with daily() it has a value on every day', () => {
    const fi = asSeries(new Workspace(src).value('fi'));
    expect(fi.t[0]).toBe(d('2021-03-01'));
    expect(fi.t.at(-1)).toBe(d(TODAY));
    expect(fi.t.length).toBe(d(TODAY) - d('2021-03-01') + 1);
    for (const iso of ['2021-03-01', '2022-06-30', '2022-07-01', '2024-02-29', TODAY]) {
      const i = Array.from(fi.t).indexOf(d(iso));
      expect(fi.v[i]).toBeCloseTo(level(d(iso), d('2021-03-01')), 8);
    }
  });

  it('since(lifetime_need) starts on its first entry and does not move in a filtered range', () => {
    const ws = new Workspace(src);
    const whole = asSeries(ws.value('fi_since'));
    expect(Array.from(whole.v)).toEqual(Array.from(asSeries(ws.value('fi')).v));
    const range = { from: d('2025-01-01'), to: d('2025-12-31') };
    const inRange = asSeries(ws.value('fi_since', range));
    expect(inRange.t[0]).toBe(range.from);
    const at = (s: typeof whole, iso: string): number => s.v[Array.from(s.t).indexOf(d(iso))];
    expect(at(inRange, '2025-03-01')).toBeCloseTo(at(whole, '2025-03-01'), 10);
    expect(at(inRange, '2025-03-01')).toBeCloseTo(level(d('2025-03-01'), d('2021-03-01')), 8);
  });
});

// Monthly figures, dated on the 1st, and the places lived in.
const monthlyData = (() => {
  const random = rng(4);
  const balance: Pts = [];
  const expenses: Pts = [];
  for (let m = 0; m < 24; m++) {
    const day = d(`${2023 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}-01`);
    balance.push([day, Math.round(-500 + random() * 2000)]);
    expenses.push([day, Math.round(1500 + random() * 1000)]);
  }
  const homes: Period[] = [
    { id: 'b', setId: 'homes', name: 'Riverside', start: '2023-08-15', end: '2024-03-31' },
    { id: 'a', setId: 'homes', name: 'Old town', start: '2023-01-01', end: '2023-08-14' },
    { id: 'c', setId: 'homes', name: 'Hillside', start: '2024-04-01', end: null },
  ];
  const src = makeSource({
    today: TODAY,
    metrics: [
      { slug: 'monthly_balance', cadence: 'monthly', points: balance },
      { slug: 'monthly_expenses', cadence: 'monthly', points: expenses },
    ],
    periodSets: [{ id: 'homes', slug: 'homes', name: 'Homes', kind: 'segment', order: 0 }],
    periods: homes,
  });
  return { balance, expenses, src };
})();

describe('6. Monthly balance as a waterfall, expenses as bars', () => {
  const { balance, expenses, src } = monthlyData;
  const ws = new Workspace(src);

  it('waterfall: one step per month with running totals', () => {
    const spec = chart({
      kind: 'waterfall',
      x: { mode: 'bucket', bucket: 'month' },
      series: [{ id: 'bal', expr: 'monthly_balance', label: 'Net balance' }],
    });
    const data = as(evaluateChart(spec, ws, src), 'waterfall');
    expect(data.label).toBe('Net balance');
    expect(data.categories.length).toBe(24);
    expect(data.categories[0]).toEqual({ label: '2023-01', from: d('2023-01-01'), to: d('2023-01-31') });
    expect(data.deltas).toEqual(balance.map((p) => p[1]));
    let running = 0;
    data.deltas.forEach((delta, i) => {
      expect(data.base[i]).toBe(running);
      running += delta ?? 0;
      expect(data.total[i]).toBe(running);
    });
  });

  it('bars: the value of each month', () => {
    const spec = chart({ kind: 'bar', x: { mode: 'bucket', bucket: 'month' }, series: [{ id: 'exp', expr: 'monthly_expenses' }] });
    const data = as(evaluateChart(spec, ws, src), 'category');
    expect(data.series[0].values).toEqual(expenses.map((p) => p[1]));
    expect(data.categories.at(-1)).toEqual({ label: '2024-12', from: d('2024-12-01'), to: monthEnd(d('2024-12-01')) });
  });
});

describe('7. Medians per place of residence', () => {
  const { balance, expenses, src } = monthlyData;

  it('evaluates each series restricted to each period', () => {
    const spec = chart({
      kind: 'bar',
      x: { mode: 'periods', setId: 'homes' },
      series: [
        { id: 'bal', expr: 'median(monthly_balance)' },
        { id: 'exp', expr: 'median(monthly_expenses)' },
        { id: 'ratio', expr: 'median(monthly_balance) / median(monthly_expenses)' },
      ],
    });
    const data: CategoryChartData = as(evaluateChart(spec, new Workspace(src), src), 'category');
    expect(data.errors).toEqual([]);
    expect(data.categories.map((c) => [c.label, c.periodId, fromDayNum(c.from), fromDayNum(c.to)])).toEqual([
      ['Old town', 'a', '2023-01-01', '2023-08-14'],
      ['Riverside', 'b', '2023-08-15', '2024-03-31'],
      ['Hillside', 'c', '2024-04-01', TODAY],
    ]);
    data.categories.forEach((cat, i) => {
      const inside = (p: Pts): number[] => p.filter(([t]) => t >= cat.from && t <= cat.to).map((x) => x[1]);
      const b = median(inside(balance));
      const e = median(inside(expenses));
      expect(data.series[0].values[i]).toBe(b);
      expect(data.series[1].values[i]).toBe(e);
      expect(data.series[2].values[i]).toBeCloseTo(b / e, 12);
    });
  });
});

describe('8. Monthly candles of a daily net worth', () => {
  const { src, networthAt } = money;

  it('open, close, low and high of each month', () => {
    const spec = chart({ kind: 'candles', x: { mode: 'bucket', bucket: 'month' }, series: [{ id: 'nw', expr: 'networth' }] });
    const data: OhlcChartData = as(evaluateChart(spec, new Workspace(src), src), 'ohlc');
    expect(data.categories.length).toBe(12 * 7 + 10);
    data.categories.forEach((cat, i) => {
      const values: number[] = [];
      for (let day = cat.from; day <= Math.min(cat.to, d(TODAY)); day++) values.push(networthAt(day) ?? NaN);
      const [open, close, low, high] = data.series[0].ohlc[i] ?? [NaN, NaN, NaN, NaN];
      expect(open).toBeCloseTo(values[0], 6);
      expect(close).toBeCloseTo(values[values.length - 1], 6);
      expect(low).toBeCloseTo(Math.min(...values), 6);
      expect(high).toBeCloseTo(Math.max(...values), 6);
    });
  });
});
