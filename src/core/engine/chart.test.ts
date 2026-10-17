import { describe, expect, it } from 'vitest';
import { fromDayNum } from '../model/dates';
import type { ChartSeriesSpec, ChartSpec, Period, PeriodSet } from '../model/types';
import { evaluateChart } from './chart';
import { d, makeSource } from './testkit';
import type {
  CategoryChartData,
  ChartData,
  ElapsedChartData,
  MultiplesChartData,
  OhlcChartData,
  TimeChartData,
  WaterfallChartData,
} from './types';
import { Workspace } from './workspace';

const sets: PeriodSet[] = [
  { id: 'diets', slug: 'diets', name: 'Diets', kind: 'campaign', color: '#f00', order: 0 },
  { id: 'homes', slug: 'homes', name: 'Homes', kind: 'segment', order: 1 },
  { id: 'none', slug: 'none', name: 'Nothing yet', kind: 'campaign', order: 2 },
];
const periods: Period[] = [
  { id: 'spring', setId: 'diets', name: 'Spring', start: '2024-03-01', end: null },
  { id: 'winter', setId: 'diets', name: 'Winter', start: '2024-01-01', end: '2024-01-31', color: '#00f' },
  { id: 'flat', setId: 'homes', name: 'Flat', start: '2024-01-01', end: '2024-02-14' },
  { id: 'house', setId: 'homes', name: 'House', start: '2024-02-15', end: null },
];
const src = makeSource({
  today: '2024-03-31',
  metrics: [
    {
      slug: 'weight',
      points: [
        ['2024-01-05', 80],
        ['2024-01-20', 79],
        ['2024-02-10', 78],
        ['2024-03-15', 77],
      ],
    },
    { slug: 'bank', fill: 'step', points: [['2024-01-01', 100], ['2024-02-15', 200], ['2024-03-10', 150]] },
    { slug: 'flow', cadence: 'monthly', points: [['2024-01-01', 10], ['2024-02-01', -5], ['2024-03-01', 20]] },
    { slug: 'gappy', points: [['2024-01-10', 1], ['2024-03-10', 3]] },
  ],
  periodSets: sets,
  periods,
});
const ws = new Workspace(src);

const s = (id: string, expr: string, extra: Partial<ChartSeriesSpec> = {}): ChartSeriesSpec => ({ id, expr, ...extra });
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
const iso = (points: Array<[number, number]>): Array<[string, number]> => points.map(([t, v]) => [fromDayNum(t), v]);

describe('date axis', () => {
  it('draws series, horizontal lines for numbers and daily samples for date functions', () => {
    const data: TimeChartData = as(
      evaluateChart(
        chart({
          series: [
            s('w', 'weight', { color: '#123' }),
            s('b', 'bank', { label: 'Bank' }),
            s('goal', '78'),
            s('t', 'since("2024-01-01") / 10'),
          ],
        }),
        ws,
        src,
      ),
      'time',
    );
    expect(data.errors).toEqual([]);
    expect(data.domain).toEqual({ min: d('2024-01-01'), max: d('2024-03-15') });
    const [w, b, goal, t] = data.series;
    expect(w).toMatchObject({ id: 'w', label: 'weight', color: '#123', step: false });
    expect(iso(w.points)[0]).toEqual(['2024-01-05', 80]);
    expect(b).toMatchObject({ label: 'Bank', step: true });
    expect(goal.points).toEqual([
      [d('2024-01-01'), 78],
      [d('2024-03-15'), 78],
    ]);
    expect(t.points.length).toBe(d('2024-03-15') - d('2024-01-01') + 1);
    expect(t.points[10]).toEqual([d('2024-01-11'), 1]);
  });

  it('a chart with only numbers has no time range', () => {
    const data = as(evaluateChart(chart({ series: [s('a', '1 + 1'), s('f', 'since("2024-01-01")')] }), ws), 'time');
    expect(data.domain).toBeNull();
    expect(data.errors).toEqual([
      { seriesId: 'a', message: 'A single number needs a series to define the time range', span: null },
      { seriesId: 'f', message: 'A date function needs a series to define the time range', span: null },
    ]);
  });

  it('reports a broken series and still draws the others', () => {
    const data = as(evaluateChart(chart({ series: [s('bad', 'wieght * 2'), s('ok', 'weight')] }), ws), 'time');
    expect(data.errors).toEqual([
      { seriesId: 'bad', message: 'Unknown name "wieght". Did you mean "weight"?', span: { start: 0, end: 6 } },
    ]);
    expect(data.series.map((x) => [x.id, x.points.length])).toEqual([
      ['bad', 0],
      ['ok', 4],
    ]);
  });

  it('shades the periods that overlap the data', () => {
    const data = as(evaluateChart(chart({ series: [s('w', 'weight')], bands: { setId: 'diets' } }), ws), 'time');
    expect(data.bands).toEqual([
      { start: d('2024-01-01'), end: d('2024-01-31'), label: 'Winter', color: '#00f', periodId: 'winter' },
      // Open period: ends today; no color of its own, so the set's.
      { start: d('2024-03-01'), end: d('2024-03-31'), label: 'Spring', color: '#f00', periodId: 'spring' },
    ]);
    const narrow = as(evaluateChart(chart({ series: [s('w', 'between(weight, "2024-02-01", "2024-02-28")')], bands: { setId: 'diets' } }), ws), 'time');
    expect(narrow.bands).toEqual([]);
    const missing = as(evaluateChart(chart({ series: [s('w', 'weight')], bands: { setId: 'gone' } }), ws), 'time');
    expect(missing.errors).toEqual([
      { seriesId: '', message: 'The shaded periods come from a period set that no longer exists', span: null },
    ]);
  });
});

describe('elapsed axis', () => {
  it('counts days from each series start', () => {
    const data: ElapsedChartData = as(
      evaluateChart(chart({ x: { mode: 'elapsed' }, series: [s('w', 'weight'), s('n', '5')] }), ws),
      'elapsed',
    );
    const [w] = data.series;
    expect(w.startDay).toBe(d('2024-01-05'));
    expect(w.points).toEqual([
      [1, 80],
      [16, 79],
      [37, 78],
      [71, 77],
    ]);
    expect(data.errors).toEqual([
      { seriesId: 'n', message: "A single number can't be drawn against days elapsed; it needs a series", span: null },
    ]);
  });
});

describe('bucket axis', () => {
  it('has one category per bucket, empty ones included', () => {
    const data: CategoryChartData = as(
      evaluateChart(
        chart({
          kind: 'bar',
          x: { mode: 'bucket', bucket: 'month' },
          series: [
            s('g', 'gappy'),
            s('w', 'weight', { reducer: 'mean' }),
            s('c', 'weight', { reducer: 'count' }),
            s('d', 'last(bank) - first(bank)'),
            s('f', 'since("2024-01-01")'),
          ],
        }),
        ws,
      ),
      'category',
    );
    expect(data.errors).toEqual([]);
    expect(data.categories).toEqual([
      { label: '2024-01', from: d('2024-01-01'), to: d('2024-01-31') },
      { label: '2024-02', from: d('2024-02-01'), to: d('2024-02-29') },
      { label: '2024-03', from: d('2024-03-01'), to: d('2024-03-31') },
    ]);
    const byId = Object.fromEntries(data.series.map((x) => [x.id, x.values]));
    expect(byId.g).toEqual([1, null, 3]);
    expect(byId.w).toEqual([79.5, 78, 77]);
    expect(byId.c).toEqual([2, 1, 1]);
    // Step series: each month starts from the value in force on the 1st.
    expect(byId.d).toEqual([0, 100, -50]);
    // Date functions: value on the last day of each category.
    expect(byId.f).toEqual([30, 59, 90]);
  });

  it('labels weeks, quarters and years', () => {
    const labels = (bucket: 'week' | 'quarter' | 'year'): string[] =>
      as(evaluateChart(chart({ x: { mode: 'bucket', bucket }, series: [s('w', 'weight')] }), ws), 'category').categories.map(
        (c) => c.label,
      );
    expect(labels('week')[0]).toBe('2024-01-01');
    expect(labels('week').length).toBe(11);
    expect(labels('quarter')).toEqual(['2024-Q1']);
    expect(labels('year')).toEqual(['2024']);
  });

  it('turns NaN into null and needs a series to know its range', () => {
    const data = as(
      evaluateChart(chart({ x: { mode: 'bucket', bucket: 'month' }, series: [s('w', 'weight'), s('m', 'mean(gappy)')] }), ws),
      'category',
    );
    expect(data.series[1].values).toEqual([1, null, 3]);
    const none = as(evaluateChart(chart({ x: { mode: 'bucket', bucket: 'month' }, series: [s('n', '1')] }), ws), 'category');
    expect(none.categories).toEqual([]);
    expect(none.errors[0].message).toBe('A single number needs a series to define the time range');
  });
});

describe('periods axis', () => {
  it('has one category per period, sorted by start', () => {
    const data = as(
      evaluateChart(
        chart({ kind: 'bar', x: { mode: 'periods', setId: 'homes' }, series: [s('w', 'mean(weight)'), s('b', 'bank')] }),
        ws,
      ),
      'category',
    );
    expect(data.categories).toEqual([
      { label: 'Flat', from: d('2024-01-01'), to: d('2024-02-14'), periodId: 'flat' },
      { label: 'House', from: d('2024-02-15'), to: d('2024-03-31'), periodId: 'house' },
    ]);
    expect(data.series[0].values).toEqual([79, 77]);
    expect(data.series[1].values).toEqual([100, 150]);
    const missing = as(evaluateChart(chart({ x: { mode: 'periods', setId: 'gone' }, series: [s('w', 'weight')] }), ws), 'category');
    expect(missing.errors).toEqual([{ seriesId: '', message: 'This chart uses a period set that no longer exists', span: null }]);
  });
});

describe('candles and waterfall', () => {
  it('candles give open, close, low and high per category', () => {
    const data: OhlcChartData = as(
      evaluateChart(chart({ kind: 'candles', x: { mode: 'bucket', bucket: 'month' }, series: [s('b', 'bank'), s('k', '7')] }), ws),
      'ohlc',
    );
    expect(data.series[0].ohlc).toEqual([
      [100, 100, 100, 100],
      [100, 200, 100, 200],
      [200, 150, 150, 200],
    ]);
    expect(data.series[1].ohlc).toEqual([
      [7, 7, 7, 7],
      [7, 7, 7, 7],
      [7, 7, 7, 7],
    ]);
    const gaps = as(evaluateChart(chart({ kind: 'candles', x: { mode: 'bucket', bucket: 'month' }, series: [s('g', 'gappy')] }), ws), 'ohlc');
    expect(gaps.series[0].ohlc).toEqual([[1, 1, 1, 1], null, [3, 3, 3, 3]]);
  });

  it('waterfall sums the first series per category and keeps running totals', () => {
    const data: WaterfallChartData = as(
      evaluateChart(
        chart({ kind: 'waterfall', x: { mode: 'bucket', bucket: 'month' }, series: [s('f', 'flow'), s('ignored', 'weight')] }),
        ws,
      ),
      'waterfall',
    );
    expect(data.label).toBe('flow');
    expect(data.deltas).toEqual([10, -5, 20]);
    expect(data.base).toEqual([0, 10, 5]);
    expect(data.total).toEqual([10, 5, 25]);
    const gaps = as(evaluateChart(chart({ kind: 'waterfall', x: { mode: 'bucket', bucket: 'month' }, series: [s('g', 'gappy')] }), ws), 'waterfall');
    expect(gaps.deltas).toEqual([1, null, 3]);
    expect(gaps.total).toEqual([1, 1, 4]);
  });
});

describe('period filters', () => {
  const line = (period: string, over: Partial<ChartSpec> = {}): ChartSpec =>
    chart({ series: [s('w', 'weight'), s('p', 'pct(weight)')], filter: { setId: 'diets', period }, ...over });

  it("'each' draws one panel per period, restricted to it", () => {
    const data: MultiplesChartData = as(evaluateChart(line('each'), ws), 'multiples');
    expect(data.panels.map((p) => p.period.id)).toEqual(['winter', 'spring']);
    const [winter, spring] = data.panels.map((p) => as(p.data, 'time'));
    expect(winter.domain).toEqual({ min: d('2024-01-01'), max: d('2024-01-31') });
    expect(iso(winter.series[0].points)).toEqual([
      ['2024-01-05', 80],
      ['2024-01-20', 79],
    ]);
    // pct restarts at each period's first value.
    expect(spring.series[1].points).toEqual([[d('2024-03-15'), 0]]);
    expect(spring.domain).toEqual({ min: d('2024-03-01'), max: d('2024-03-31') });
  });

  it("'latest', a period id, and missing sets or periods", () => {
    const latest = as(evaluateChart(line('latest'), ws), 'time');
    expect(latest.domain).toEqual({ min: d('2024-03-01'), max: d('2024-03-31') });
    const winter = as(evaluateChart(line('winter', { x: { mode: 'bucket', bucket: 'week' } }), ws), 'category');
    expect(winter.categories[0]).toMatchObject({ label: '2024-01-01', from: d('2024-01-01') });
    expect(winter.categories.at(-1)).toMatchObject({ label: '2024-01-29', to: d('2024-01-31') });
    expect(as(evaluateChart(line('gone'), ws), 'time').errors[0].message).toBe(
      'This chart is filtered by a period that no longer exists',
    );
    const noSet = evaluateChart(chart({ series: [s('w', 'weight')], filter: { setId: 'gone', period: 'each' } }), ws);
    expect(noSet.errors[0]).toEqual({
      seriesId: '',
      message: 'This chart is filtered by a period set that no longer exists',
      span: null,
    });
    const empty = evaluateChart(chart({ series: [s('w', 'weight')], filter: { setId: 'none', period: 'latest' } }), ws);
    expect(empty.errors[0].message).toBe('"Nothing yet" has no periods yet');
    const panels = as(evaluateChart(chart({ series: [s('w', 'weight')], filter: { setId: 'none', period: 'each' } }), ws), 'multiples');
    expect(panels.panels).toEqual([]);
  });

  it('collects panel errors once at the top', () => {
    const data = as(evaluateChart(line('each', { series: [s('x', 'nope')] }), ws), 'multiples');
    expect(data.errors).toEqual([{ seriesId: 'x', message: 'Unknown name "nope"', span: { start: 0, end: 4 } }]);
    expect(as(data.panels[0].data, 'time').errors.length).toBe(1);
  });
});
