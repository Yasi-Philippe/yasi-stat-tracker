/**
 * Starter packs for the sandbox. Each creates metrics, formulas, period sets,
 * charts and a dashboard. Everything they create is ordinary and editable.
 */

import type { ChartSeriesSpec, ChartSpec, Dashboard, FormulaDef, MetricDef, PeriodSet } from '../model/types';
import type { Vault } from '../vault/vault';
import {
  dashboards,
  formulas,
  metrics,
  newId,
  nextOrder,
  periodSets,
  saveChart,
  saveDashboard,
  saveFormula,
  saveMetric,
  savePeriodSet,
  uniqueSlug,
  usedSlugs,
} from './repo';

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  icon: 'scale' | 'wallet' | 'moon' | 'smile' | 'footprints' | 'activity';
}

export const TEMPLATES: TemplateInfo[] = [
  { id: 'body', name: 'Body', description: 'Weight, BMI that follows your height, weight-loss campaigns.', icon: 'scale' },
  {
    id: 'money',
    name: 'Money',
    description: 'Bank and investments, net worth, yearly surplus, independence level, monthly flows, places lived.',
    icon: 'wallet',
  },
  { id: 'sleep', name: 'Sleep', description: 'Hours slept with a weekly trend.', icon: 'moon' },
  { id: 'mood', name: 'Mood', description: 'A daily 1–10 score with a monthly average.', icon: 'smile' },
  { id: 'steps', name: 'Steps', description: 'Daily steps and monthly totals.', icon: 'footprints' },
  { id: 'running', name: 'Running', description: 'Distance per run with weekly volume.', icon: 'activity' },
];

type MetricSeed = Omit<MetricDef, 'id' | 'order' | 'slug'> & { slug: string };
type FormulaSeed = Omit<FormulaDef, 'id' | 'order' | 'slug'> & { slug: string };

class Builder {
  private used: Set<string>;
  private map = new Map<string, string>();
  private metricOrder: number;
  private formulaOrder: number;
  readonly chartIds: string[] = [];
  readonly created = { metrics: [] as MetricDef[], formulas: [] as FormulaDef[], sets: [] as PeriodSet[] };

  constructor(private readonly vault: Vault) {
    this.used = usedSlugs(vault);
    this.metricOrder = nextOrder(metrics(vault, { includeArchived: true }));
    this.formulaOrder = nextOrder(formulas(vault));
  }

  /** Slug actually used for a template slug (renamed if it collides). */
  s = (base: string): string => this.map.get(base) ?? base;

  /** Rewrites template slugs inside an expression. */
  x = (expr: string): string => expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (w) => this.map.get(w) ?? w);

  private claim(base: string): string {
    const slug = uniqueSlug(base, this.used);
    this.used.add(slug);
    this.map.set(base, slug);
    return slug;
  }

  metric(seed: MetricSeed): MetricDef {
    const m: MetricDef = { ...seed, id: newId(), slug: this.claim(seed.slug), order: this.metricOrder++ };
    saveMetric(this.vault, m);
    this.created.metrics.push(m);
    return m;
  }

  formula(seed: FormulaSeed): FormulaDef {
    const slug = this.claim(seed.slug);
    const f: FormulaDef = { ...seed, id: newId(), slug, expr: this.x(seed.expr), order: this.formulaOrder++ };
    saveFormula(this.vault, f);
    this.created.formulas.push(f);
    return f;
  }

  periodSet(seed: Omit<PeriodSet, 'id' | 'order'>): PeriodSet {
    const p: PeriodSet = { ...seed, id: newId(), slug: this.claim(seed.slug), order: nextOrder(periodSets(this.vault)) };
    savePeriodSet(this.vault, p);
    this.created.sets.push(p);
    return p;
  }

  chart(spec: Omit<ChartSpec, 'id'>): ChartSpec {
    const c: ChartSpec = {
      ...spec,
      id: newId(),
      series: spec.series.map((s) => ({ ...s, expr: this.x(s.expr) })),
    };
    saveChart(this.vault, c);
    this.chartIds.push(c.id);
    return c;
  }

  dashboard(name: string, icon: string, sizes: Array<'full' | 'half'> = []): Dashboard {
    const d: Dashboard = {
      id: newId(),
      name,
      icon,
      order: nextOrder(dashboards(this.vault)),
      items: this.chartIds.map((chartId, i) => ({ chartId, size: sizes[i] ?? 'full' })),
    };
    saveDashboard(this.vault, d);
    return d;
  }
}

const sid = () => newId().slice(0, 8);

export interface AppliedTemplate {
  metrics: MetricDef[];
  formulas: FormulaDef[];
  sets: PeriodSet[];
  slug: (base: string) => string;
}

export function applyTemplate(vault: Vault, id: string): AppliedTemplate {
  const b = new Builder(vault);
  vault.batch(() => {
    switch (id) {
      case 'body':
        body(b);
        break;
      case 'money':
        money(b);
        break;
      case 'sleep':
        simple(b, { slug: 'sleep', name: 'Sleep', unit: 'h', decimals: 1, step: 0.25, better: 'up', icon: 'moon', avg: 7, group: 'Health' });
        break;
      case 'mood':
        simple(b, { slug: 'mood', name: 'Mood', unit: '/10', decimals: 0, step: 1, min: 1, max: 10, better: 'up', icon: 'smile', avg: 30, group: 'Health' });
        break;
      case 'steps':
        simple(b, { slug: 'steps', name: 'Steps', unit: 'steps', decimals: 0, step: 500, better: 'up', icon: 'footprints', avg: 7, group: 'Health', monthlySum: true });
        break;
      case 'running':
        simple(b, { slug: 'run_km', name: 'Running', unit: 'km', decimals: 2, step: 0.5, better: 'up', icon: 'activity', avg: 0, group: 'Sport', weeklySum: true });
        break;
      default:
        throw new Error(`Unknown template ${id}`);
    }
  });
  return { ...b.created, slug: b.s };
}

function body(b: Builder): void {
  b.metric({
    slug: 'weight',
    name: 'Weight',
    unit: 'kg',
    cadence: 'daily',
    fill: 'none',
    decimals: 1,
    step: 0.1,
    group: 'Body',
    icon: 'scale',
    better: 'down',
    reminder: { enabled: false, time: '08:00' },
  });
  b.metric({
    slug: 'height',
    name: 'Height',
    unit: 'cm',
    cadence: 'sparse',
    fill: 'step',
    decimals: 1,
    step: 0.5,
    group: 'Body',
    icon: 'ruler',
    hideFromToday: true,
  });
  b.formula({ slug: 'bmi', name: 'BMI', unit: 'kg/m²', expr: 'weight / (height / 100) ^ 2', decimals: 1, group: 'Body' });
  b.formula({ slug: 'weight_trend', name: 'Weight trend', unit: 'kg', expr: 'ma(weight, 7)', decimals: 1, group: 'Body' });
  const cuts = b.periodSet({ slug: 'cuts', name: 'Weight-loss campaigns', kind: 'campaign' });

  b.chart({
    title: 'Weight',
    better: 'down',
    subtitle: 'Daily weigh-ins and the 7-day trend',
    kind: 'line',
    x: { mode: 'date' },
    series: [
      { id: sid(), expr: 'weight', label: 'Weight', style: { points: 'auto', width: 1.2, opacity: 0.45 } },
      { id: sid(), expr: 'weight_trend', label: '7-day trend', style: { smooth: true, width: 2.8, area: true } },
    ],
    bands: { setId: cuts.id },
    view: { preset: 'all' },
    unit: 'kg',
    decimals: 1,
  });
  b.chart({
    title: 'BMI',
    better: 'down',
    subtitle: 'Uses the height in force on each day',
    kind: 'area',
    x: { mode: 'date' },
    series: [{ id: sid(), expr: 'bmi', label: 'BMI' }],
    view: { preset: 'all' },
    refLines: [
      { value: 18.5, label: 'Underweight' },
      { value: 25, label: 'Overweight' },
      { value: 30, label: 'Obese' },
    ],
    unit: 'kg/m²',
    decimals: 1,
  });
  b.chart({
    title: 'Campaigns',
    better: 'down',
    subtitle: 'Each weight-loss campaign on its own',
    kind: 'line',
    x: { mode: 'date' },
    filter: { setId: cuts.id, period: 'each' },
    series: [{ id: sid(), expr: 'weight', label: 'Weight', style: { points: 'auto' } }],
    view: { preset: 'all' },
    unit: 'kg',
    decimals: 1,
  });
  b.dashboard('Body', 'scale');
}

function money(b: Builder): void {
  const money = (slug: string, name: string, extra: Partial<MetricSeed> = {}) =>
    b.metric({
      slug,
      name,
      unit: '€',
      cadence: 'daily',
      fill: 'step',
      decimals: 2,
      step: 10,
      group: 'Money',
      icon: 'wallet',
      better: 'up',
      ...extra,
    });
  money('bank', 'Bank');
  money('fund_a', 'Fund A', { icon: 'trending-up' });
  money('fund_b', 'Fund B', { icon: 'trending-up' });
  const param = (slug: string, name: string) =>
    b.metric({ slug, name, unit: '€', cadence: 'sparse', fill: 'step', decimals: 0, step: 100, group: 'Plan', icon: 'target', hideFromToday: true });
  param('fund_a_capital', 'Fund A initial capital');
  param('fund_b_capital', 'Fund B initial capital');
  param('monthly_need', 'Monthly cost of living');
  param('lifetime_need', 'Money needed for life');
  b.metric({
    slug: 'month_net',
    name: 'Monthly net balance',
    unit: '€',
    cadence: 'monthly',
    fill: 'none',
    decimals: 2,
    step: 10,
    group: 'Money',
    icon: 'calendar',
    better: 'up',
  });
  b.metric({
    slug: 'month_spend',
    name: 'Monthly expenses',
    unit: '€',
    cadence: 'monthly',
    fill: 'none',
    decimals: 2,
    step: 10,
    group: 'Money',
    icon: 'receipt',
    better: 'down',
  });
  b.formula({ slug: 'networth', name: 'Net worth', unit: '€', expr: 'bank + fill(fund_a, 0) + fill(fund_b, 0)', decimals: 2, group: 'Money' });
  b.formula({
    slug: 'independence',
    name: 'Independence level',
    unit: '%',
    // daily() gives the plan a value every day, so the level moves with time as well as money.
    expr: 'networth / (lifetime_need - since(lifetime_need) * daily(monthly_need) / 30.4375) * 100',
    decimals: 2,
    group: 'Plan',
  });
  const places = b.periodSet({ slug: 'places', name: 'Places lived', kind: 'segment' });

  b.chart({
    title: 'Net worth',
    better: 'up',
    subtitle: 'Bank, each investment and the total',
    kind: 'line',
    x: { mode: 'date' },
    series: [
      { id: sid(), expr: 'networth', label: 'Net worth', style: { area: true, width: 2.8 } },
      { id: sid(), expr: 'bank', label: 'Bank' },
      { id: sid(), expr: 'fund_a', label: 'Fund A' },
      { id: sid(), expr: 'fund_b', label: 'Fund B' },
    ],
    view: { preset: 'all' },
    unit: '€',
    decimals: 0,
  });
  b.chart({
    title: 'Investments from day one',
    better: 'up',
    subtitle: 'Return on the initial capital, all starting together',
    kind: 'line',
    x: { mode: 'elapsed' },
    series: [
      { id: sid(), expr: 'pct(fund_a, fund_a_capital)', label: 'Fund A' },
      { id: sid(), expr: 'pct(fund_b, fund_b_capital)', label: 'Fund B' },
    ],
    view: { preset: 'all' },
    refLines: [{ value: 0 }],
    unit: '%',
    decimals: 1,
  });
  b.chart({
    title: 'Investments over time',
    better: 'up',
    subtitle: 'Return on the initial capital, on real dates',
    kind: 'line',
    x: { mode: 'date' },
    series: [
      { id: sid(), expr: 'pct(fund_a, fund_a_capital)', label: 'Fund A' },
      { id: sid(), expr: 'pct(fund_b, fund_b_capital)', label: 'Fund B' },
    ],
    view: { preset: 'all' },
    refLines: [{ value: 0 }],
    unit: '%',
    decimals: 1,
  });
  b.chart({
    title: 'Yearly surplus',
    better: 'up',
    subtitle: 'Net worth at the end of each year minus the start',
    kind: 'bar',
    x: { mode: 'bucket', bucket: 'year' },
    series: [{ id: sid(), expr: 'last(networth) - first(networth)', label: 'Surplus' }],
    view: { preset: 'all', yZero: true },
    unit: '€',
    decimals: 0,
  });
  b.chart({
    title: 'Independence level',
    better: 'up',
    subtitle: 'How much of a lifetime of costs your money already covers',
    kind: 'area',
    x: { mode: 'date' },
    series: [{ id: sid(), expr: 'independence', label: 'Level' }],
    view: { preset: 'all', yZero: true },
    refLines: [{ value: 100, label: 'Free' }],
    unit: '%',
    decimals: 2,
  });
  b.chart({
    title: 'Monthly net balance',
    better: 'up',
    subtitle: 'What each month added or took away',
    kind: 'waterfall',
    x: { mode: 'bucket', bucket: 'month' },
    series: [{ id: sid(), expr: 'month_net', label: 'Net', reducer: 'sum' }],
    view: { preset: 'year' },
    unit: '€',
    decimals: 0,
  });
  b.chart({
    title: 'Monthly expenses',
    better: 'down',
    subtitle: 'Is spending creeping up?',
    kind: 'bar',
    x: { mode: 'bucket', bucket: 'month' },
    series: [{ id: sid(), expr: 'month_spend', label: 'Expenses', reducer: 'sum' }],
    view: { preset: 'year', yZero: true },
    unit: '€',
    decimals: 0,
  });
  b.chart({
    title: 'By place lived',
    subtitle: 'Median month in each place',
    kind: 'bar',
    x: { mode: 'periods', setId: places.id },
    series: [
      { id: sid(), expr: 'median(month_net)', label: 'Median net' },
      { id: sid(), expr: 'median(month_spend)', label: 'Median expenses' },
      { id: sid(), expr: 'median(month_net) / median(month_spend)', label: 'Ratio', axis: 'right' },
    ],
    view: { preset: 'all', yZero: true },
    unit: '€',
    decimals: 0,
  });
  b.chart({
    title: 'Net worth candles',
    better: 'up',
    subtitle: 'Open, high, low and close of every month',
    kind: 'candles',
    x: { mode: 'bucket', bucket: 'month' },
    series: [{ id: sid(), expr: 'networth', label: 'Net worth' }],
    view: { preset: 'year' },
    unit: '€',
    decimals: 0,
  });
  b.dashboard('Money', 'wallet', ['full', 'half', 'half', 'full', 'full', 'full', 'full', 'full', 'full']);
}

interface SimpleSeed {
  slug: string;
  name: string;
  unit: string;
  decimals: number;
  step: number;
  min?: number;
  max?: number;
  better: 'up' | 'down';
  icon: string;
  /** Days of the moving average, 0 for none. */
  avg: number;
  group: string;
  monthlySum?: boolean;
  weeklySum?: boolean;
}

function simple(b: Builder, s: SimpleSeed): void {
  b.metric({
    slug: s.slug,
    name: s.name,
    unit: s.unit,
    cadence: 'daily',
    fill: 'none',
    decimals: s.decimals,
    step: s.step,
    min: s.min ?? null,
    max: s.max ?? null,
    group: s.group,
    icon: s.icon,
    better: s.better,
  });
  const series: ChartSeriesSpec[] = [{ id: sid(), expr: s.slug, label: s.name, style: { points: 'auto' } }];
  if (s.avg) series.push({ id: sid(), expr: `ma(${s.slug}, ${s.avg})`, label: `${s.avg}-day average`, style: { points: 'none', smooth: true, width: 2.6 } });
  b.chart({ title: s.name, better: s.better, kind: 'line', x: { mode: 'date' }, series, view: { preset: 'quarter' }, unit: s.unit, decimals: s.decimals });
  if (s.monthlySum || s.weeklySum) {
    const bucket = s.monthlySum ? 'month' : 'week';
    b.chart({
      title: `${s.name} per ${bucket}`,
      kind: 'bar',
      x: { mode: 'bucket', bucket },
      series: [{ id: sid(), expr: s.slug, label: s.name, reducer: 'sum' }],
      view: { preset: 'year', yZero: true },
      unit: s.unit,
      decimals: s.decimals,
    });
  } else if (s.slug === 'mood') {
    b.chart({
      title: 'Mood by month',
      kind: 'bar',
      x: { mode: 'bucket', bucket: 'month' },
      series: [{ id: sid(), expr: 'mood', label: 'Average', reducer: 'mean' }],
      view: { preset: 'year', yMin: 0, yMax: 10 },
      unit: s.unit,
      decimals: 1,
    });
  }
  b.dashboard(s.name, s.icon);
}
