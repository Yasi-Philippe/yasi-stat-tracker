import { describe, expect, it } from 'vitest';
import type { ChartSpec } from '../model/types';
import { evaluateChart } from './chart';
import { d, makeSource, rng, walk } from './testkit';
import { Workspace } from './workspace';

describe('performance', () => {
  it('a monthly chart over 20 years of daily data takes well under a second', () => {
    const random = rng(42);
    const from = d('2006-10-12');
    const to = d('2026-10-11');
    const src = makeSource({
      today: '2026-10-11',
      metrics: [
        { slug: 'weight', points: walk(random, from, to, 85, { noise: 0.4, skip: 0.2 }) },
        { slug: 'height', fill: 'step', points: [[from, 178], [d('2010-01-01'), 179], [d('2015-01-01'), 180]] },
        { slug: 'bank', fill: 'step', points: walk(random, from, to, 5000, { drift: 2, noise: 40 }) },
        { slug: 'stocks', fill: 'step', points: walk(random, d('2010-01-01'), to, 1000, { drift: 1, noise: 10 }) },
        { slug: 'steps', points: walk(random, from, to, 8000, { noise: 500, skip: 0.1 }) },
      ],
      formulas: {
        networth: 'bank + fill(stocks, 0)',
        bmi: 'weight / (height / 100) ^ 2',
        bmi_ma: 'ma(bmi, 30)',
        weight_med: 'rolling(weight, 7, "median")',
        nw_pct: 'pct(networth)',
        nw_change: 'change(networth)',
        ratio: 'networth / (steps + 1)',
        fi: 'networth / (1000000 - since("2010-01-01") * 3000 / 30.4375) * 100',
        steps_week: 'rolling(steps, 7, "sum")',
        combo: 'if(bmi > 25, bmi_ma, weight_med / 3)',
      },
    });
    const spec: ChartSpec = {
      id: 'perf',
      title: 'Everything, monthly',
      kind: 'bar',
      x: { mode: 'bucket', bucket: 'month' },
      series: [
        { id: 'nw', expr: 'networth' },
        { id: 'bmi', expr: 'bmi', reducer: 'mean' },
        { id: 'surplus', expr: 'last(networth) - first(networth)' },
        { id: 'steps', expr: 'mean(steps_week)' },
        { id: 'combo', expr: 'combo', reducer: 'median' },
        { id: 'fi', expr: 'fi' },
        { id: 'ratio', expr: 'ratio', reducer: 'max' },
        { id: 'pct', expr: 'nw_pct' },
        { id: 'chg', expr: 'nw_change', reducer: 'sum' },
      ],
      view: { preset: 'all' },
    };

    const start = performance.now();
    const data = evaluateChart(spec, new Workspace(src), src);
    const ms = performance.now() - start;
    console.log(`monthly chart, 20 years x 5 metrics, 10 formulas, 9 series: ${ms.toFixed(0)} ms`);

    expect(data.mode).toBe('category');
    if (data.mode !== 'category') return;
    expect(data.errors).toEqual([]);
    expect(data.categories.length).toBe(241);
    expect(data.series.every((s) => s.values.filter((v) => v !== null).length > 230)).toBe(true);
    expect(ms).toBeLessThan(1500);
  });
});
