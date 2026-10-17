/**
 * ChartData (from the engine) + ChartSpec + theme → an ECharts option.
 * This is where the look of every chart is decided.
 */

import type {
  CategoryChartData,
  ChartData,
  ElapsedChartData,
  OhlcChartData,
  TimeChartData,
  WaterfallChartData,
} from '@/core/engine/types';
import { type DayNum, dayNumToMs, fromDayNum } from '@/core/model/dates';
import type { ChartSpec, ThemeTokens, ViewPreset } from '@/core/model/types';
import { alpha } from '../theme/applyTheme';
import { fontStack } from '../theme/themes';
import { fmtDay, fmtNum, fmtValue } from '../format';
import type { EChartsOption } from './echarts';

export interface BuildContext {
  spec: ChartSpec;
  theme: ThemeTokens;
  /** Card (compact) or full-screen chart. */
  size: 'card' | 'full' | 'mini';
  /** Visible window for time charts, in days. */
  window?: { start: DayNum; end: DayNum } | null;
  /** Manual axis overrides from the axis editor. */
  yMin?: number | null;
  yMax?: number | null;
  yZero?: boolean;
  /** Series hidden through the legend. */
  hidden?: Set<string>;
  /** Visible categories (inclusive indexes) for bucket/period charts. */
  catWindow?: { start: number; end: number } | null;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function seriesColor(ctx: BuildContext, index: number, explicit?: string | null): string {
  if (explicit) return explicit;
  const p = ctx.theme.palette;
  return p[index % p.length] ?? ctx.theme.accent;
}

function base(ctx: BuildContext) {
  const t = ctx.theme;
  const font = fontStack(t.fontUI);
  const numberFont = fontStack(t.fontNumber);
  const compact = ctx.size !== 'full';
  const splitLine =
    t.grid === 'none'
      ? { show: false }
      : { show: true, lineStyle: { color: t.line, type: t.grid === 'dashed' ? ([3, 4] as number[]) : 'solid', width: 1 } };
  const axisLabel = { color: t.muted, fontFamily: numberFont, fontSize: compact ? 10.5 : 11.5, hideOverlap: true };
  const tooltip = {
    trigger: 'axis' as const,
    confine: true,
    backgroundColor: t.surface,
    borderColor: t.line,
    borderWidth: 1,
    padding: [10, 12],
    textStyle: { color: t.text, fontFamily: font, fontSize: 12.5 },
    extraCssText: `border-radius:${Math.max(8, t.radius * 0.7)}px;box-shadow:0 18px 40px -16px rgba(0,0,0,.55);backdrop-filter:blur(8px);`,
    axisPointer: {
      type: 'line' as const,
      lineStyle: { color: alpha(t.text, 0.35), width: 1, type: [4, 4] as number[] },
      label: { show: false },
    },
  };
  return { t, font, numberFont, compact, splitLine, axisLabel, tooltip };
}

function grid(ctx: BuildContext, slider: boolean, rightAxis: boolean) {
  if (ctx.size === 'mini') return { left: 4, right: 4, top: 8, bottom: 4, containLabel: false };
  return {
    left: 6,
    right: rightAxis ? 10 : 14,
    top: ctx.size === 'full' ? 26 : 16,
    bottom: slider ? 58 : 6,
    containLabel: true,
  };
}

function valueAxis(ctx: BuildContext, b: ReturnType<typeof base>, unit: string, decimals: number, position: 'left' | 'right' = 'left') {
  const zero = ctx.yZero ?? ctx.spec.view.yZero ?? false;
  const yMin = ctx.yMin ?? ctx.spec.view.yMin ?? null;
  const yMax = ctx.yMax ?? ctx.spec.view.yMax ?? null;
  return {
    type: 'value' as const,
    position,
    scale: !zero,
    min: yMin ?? undefined,
    max: yMax ?? undefined,
    splitNumber: b.compact ? 3 : 5,
    splitLine: position === 'left' ? b.splitLine : { show: false },
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: {
      ...b.axisLabel,
      show: ctx.size !== 'mini',
      formatter: (v: number) => {
        const abs = Math.abs(v);
        const s = abs >= 10_000 ? fmtNum(v, 1, { compact: true }) : fmtNum(v, abs < 10 && decimals > 0 ? Math.min(decimals, 2) : 0);
        return unit === '%' ? `${s}%` : s;
      },
    },
  };
}

function dateLabelFormatter() {
  return {
    year: '{yyyy}',
    month: '{MMM}',
    day: '{d} {MMM}',
    hour: '{HH}:{mm}',
    minute: '{HH}:{mm}',
    second: '{HH}:{mm}:{ss}',
    millisecond: '{HH}:{mm}',
    none: '{d} {MMM}',
  };
}

/** Start/end of the initial window for a preset, ending at the data's last day. */
export function presetWindow(preset: ViewPreset, domain: { min: DayNum; max: DayNum } | null): { start: DayNum; end: DayNum } | null {
  if (!domain || preset === 'all') return null;
  const span = preset === 'year' ? 365 : preset === 'quarter' ? 91 : 30;
  return { start: Math.max(domain.min, domain.max - span + 1), end: domain.max };
}

function dataZoom(ctx: BuildContext, b: ReturnType<typeof base>, axisType: 'time' | 'value' | 'category', startValue?: number, endValue?: number) {
  if (ctx.size === 'mini') return [];
  const inside = {
    type: 'inside' as const,
    xAxisIndex: 0,
    filterMode: 'filter' as const,
    startValue,
    endValue,
    zoomOnMouseWheel: ctx.size === 'full',
    moveOnMouseWheel: false,
    moveOnMouseMove: true,
    preventDefaultMouseMove: ctx.size === 'full',
  };
  if (ctx.size !== 'full') return [inside];
  const t = b.t;
  return [
    inside,
    {
      type: 'slider' as const,
      xAxisIndex: 0,
      filterMode: 'filter' as const,
      startValue,
      endValue,
      height: 30,
      bottom: 8,
      borderColor: 'transparent',
      backgroundColor: alpha(t.text, 0.03),
      fillerColor: alpha(t.accent, 0.13),
      dataBackground: { lineStyle: { color: alpha(t.muted, 0.6), width: 1 }, areaStyle: { color: alpha(t.muted, 0.12) } },
      selectedDataBackground: { lineStyle: { color: t.accent, width: 1 }, areaStyle: { color: alpha(t.accent, 0.18) } },
      handleIcon: 'path://M-2,-10 L2,-10 L2,10 L-2,10 Z',
      handleSize: '70%',
      handleStyle: { color: t.accent, borderColor: t.accent, borderWidth: 0, shadowBlur: 6 * t.glow, shadowColor: alpha(t.accent, 0.5) },
      moveHandleSize: 0,
      brushSelect: false,
      showDetail: false,
      textStyle: { color: t.muted },
      labelFormatter: axisType === 'time' ? (v: number) => fmtDay(Math.floor(v / 86_400_000), 'short') : undefined,
    },
  ];
}

function lineSeriesStyle(ctx: BuildContext, color: string, i: number, style: ChartSpec['series'][number]['style'] | undefined, n: number, area: boolean) {
  const t = ctx.theme;
  const width = style?.width ?? (i === 0 ? t.lineWidth : t.lineWidth * 0.85);
  const smooth = style?.smooth ?? t.curve === 'smooth';
  const dash = style?.line === 'dashed' ? [6, 5] : style?.line === 'dotted' ? [1.5, 4] : 'solid';
  const points = style?.points ?? 'auto';
  const showSymbol = points === 'all' || (points === 'auto' && n <= (ctx.size === 'full' ? 90 : 40));
  const glow = t.glow * (ctx.size === 'mini' ? 6 : 12);
  const opacity = style?.opacity ?? 1;
  return {
    type: 'line' as const,
    color,
    smooth: smooth ? 0.35 : false,
    step: style?.step || t.curve === 'step' ? ('end' as const) : false,
    showSymbol,
    symbol: 'circle',
    symbolSize: ctx.size === 'full' ? 6 : 5,
    connectNulls: false,
    sampling: n > 1500 ? ('lttb' as const) : undefined,
    lineStyle: { width, color, opacity, type: dash, shadowBlur: glow * opacity, shadowColor: alpha(color, 0.45 * t.glow), cap: 'round' as const },
    itemStyle: { color, opacity, borderColor: t.surface, borderWidth: 1.5 },
    emphasis: { focus: 'series' as const, lineStyle: { width: width + 0.6 } },
    areaStyle: area
      ? {
          color: {
            type: 'linear' as const,
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: alpha(color, Math.max(0.08, t.areaOpacity)) },
              { offset: 1, color: alpha(color, 0) },
            ],
          },
          origin: 'auto' as const,
        }
      : undefined,
    // Later series draw on top, so a trend sits above the raw data it smooths.
    z: 3 + i * 0.01,
  };
}

function refLines(ctx: BuildContext) {
  const t = ctx.theme;
  if (!ctx.spec.refLines?.length) return undefined;
  return {
    silent: true,
    symbol: 'none',
    lineStyle: { color: alpha(t.text, 0.28), type: [5, 5] as number[], width: 1 },
    label: {
      position: 'insideEndTop' as const,
      color: t.muted,
      fontFamily: fontStack(t.fontUI),
      fontSize: 10.5,
      formatter: (p: { name?: string; value?: number }) => p.name || '',
    },
    data: ctx.spec.refLines.map((r) => ({ yAxis: r.value, name: r.label ?? '' })),
  };
}

// ---------------------------------------------------------------------------

export function buildOption(data: ChartData, ctx: BuildContext): EChartsOption {
  switch (data.mode) {
    case 'time':
      return timeOption(data, ctx);
    case 'elapsed':
      return elapsedOption(data, ctx);
    case 'category':
      return categoryOption(sliceCategories(data, ctx.catWindow ?? defaultCategoryWindow(ctx.spec, data.categories.length)), ctx);
    case 'ohlc':
      return ohlcOption(sliceCategories(data, ctx.catWindow ?? defaultCategoryWindow(ctx.spec, data.categories.length)), ctx);
    case 'waterfall':
      return waterfallOption(sliceCategories(data, ctx.catWindow ?? defaultCategoryWindow(ctx.spec, data.categories.length)), ctx);
    case 'multiples':
      return {};
  }
}

function timeOption(data: TimeChartData, ctx: BuildContext): EChartsOption {
  const b = base(ctx);
  const t = b.t;
  const unit = ctx.spec.unit ?? '';
  const decimals = ctx.spec.decimals ?? 1;
  const isArea = ctx.spec.kind === 'area';
  const asBars = ctx.spec.kind === 'bar';
  const asDots = ctx.spec.kind === 'dots';
  const specSeries = new Map(ctx.spec.series.map((s, i) => [s.id, { s, i }]));
  const visible = data.series.filter((s) => !ctx.hidden?.has(s.id));
  const win = ctx.window ?? presetWindow(ctx.spec.view.preset, data.domain);
  const startValue = win ? dayNumToMs(win.start) : undefined;
  const endValue = win ? dayNumToMs(win.end) : undefined;
  const series: unknown[] = [];

  visible.forEach((s) => {
    const meta = specSeries.get(s.id);
    const idx = meta?.i ?? 0;
    const color = seriesColor(ctx, idx, s.color);
    const pts = s.points.map(([d, v]) => [dayNumToMs(d), v]);
    if (asBars) {
      series.push({
        type: 'bar',
        name: s.label,
        id: s.id,
        data: pts,
        barMaxWidth: 10,
        itemStyle: { color: (p: { value: [number, number] }) => (p.value[1] < 0 ? t.negative : color), borderRadius: [3, 3, 0, 0] },
      });
      return;
    }
    if (asDots) {
      series.push({ type: 'scatter', name: s.label, id: s.id, data: pts, symbolSize: 6, itemStyle: { color, opacity: 0.85 } });
      return;
    }
    const area = isArea ? idx === 0 || !!meta?.s.style?.area : !!meta?.s.style?.area;
    const st = lineSeriesStyle(ctx, color, idx, meta?.s.style, pts.length, area);
    if (s.step) st.step = 'end';
    series.push({ ...st, name: s.label, id: s.id, data: pts });
  });

  // The lit point: the latest value of the first series pulses gently.
  const lead = visible[0];
  if (lead && lead.points.length && ctx.size !== 'mini') {
    const last = lead.points[lead.points.length - 1]!;
    const color = seriesColor(ctx, specSeries.get(lead.id)?.i ?? 0, lead.color);
    series.push({
      type: 'effectScatter',
      name: '__last',
      silent: true,
      data: [[dayNumToMs(last[0]), last[1]]],
      symbolSize: ctx.size === 'full' ? 9 : 7,
      rippleEffect: { scale: 3.2, brushType: 'fill', period: 3.2, number: 2 },
      itemStyle: { color, shadowBlur: 14 * t.glow, shadowColor: color },
      z: 10,
      tooltip: { show: false },
    });
  }

  // Period bands and reference lines ride on the first real series.
  const first = series.find((x) => (x as { name?: string }).name !== '__last') as Record<string, unknown> | undefined;
  if (first) {
    if (data.bands.length) {
      first.markArea = {
        silent: true,
        itemStyle: { color: alpha(t.accent2, t.scheme === 'dark' ? 0.09 : 0.07) },
        label: {
          show: ctx.size !== 'mini',
          position: 'insideTopLeft',
          color: alpha(t.text, 0.55),
          fontFamily: b.font,
          fontSize: 10,
          fontWeight: 600,
        },
        data: data.bands.map((band) => [
          { xAxis: dayNumToMs(band.start), name: band.label, itemStyle: band.color ? { color: alpha(band.color, 0.12) } : undefined },
          { xAxis: dayNumToMs(band.end + 1) },
        ]),
      };
    }
    const rl = refLines(ctx);
    if (rl) first.markLine = rl;
  }

  return {
    backgroundColor: 'transparent',
    animationDuration: 700,
    animationEasing: 'cubicOut',
    textStyle: { fontFamily: b.font },
    grid: grid(ctx, ctx.size === 'full', false),
    tooltip: {
      ...b.tooltip,
      show: ctx.size !== 'mini',
      formatter: (params: Array<{ seriesName: string; value: [number, number]; color: string; axisValue: number }>) => {
        const list = params.filter((p) => p.seriesName !== '__last');
        if (!list.length) return '';
        const day = Math.floor(list[0]!.value[0] / 86_400_000);
        const rows = list
          .map(
            (p) =>
              `<div style="display:flex;align-items:center;gap:8px;margin-top:4px"><span style="width:8px;height:8px;border-radius:50%;background:${p.color}"></span><span style="opacity:.75">${esc(p.seriesName)}</span><b style="margin-left:auto;font-family:${b.numberFont};padding-left:14px">${esc(fmtValue(p.value[1], unit, decimals))}</b></div>`,
          )
          .join('');
        return `<div style="font-weight:700;font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.6">${esc(fmtDay(day, 'medium'))}</div>${rows}`;
      },
    },
    xAxis: {
      type: 'time',
      show: ctx.size !== 'mini',
      boundaryGap: false,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { ...b.axisLabel, formatter: dateLabelFormatter() },
      axisPointer: { snap: true },
    },
    yAxis: valueAxis(ctx, b, unit, decimals),
    dataZoom: dataZoom(ctx, b, 'time', startValue, endValue),
    series,
  };
}

function elapsedOption(data: ElapsedChartData, ctx: BuildContext): EChartsOption {
  const b = base(ctx);
  const unit = ctx.spec.unit ?? '';
  const decimals = ctx.spec.decimals ?? 1;
  const specSeries = new Map(ctx.spec.series.map((s, i) => [s.id, { s, i }]));
  const visible = data.series.filter((s) => !ctx.hidden?.has(s.id));
  const starts = new Map(visible.map((s) => [s.label, s.startDay]));
  const series = visible.map((s) => {
    const meta = specSeries.get(s.id);
    const idx = meta?.i ?? 0;
    const color = seriesColor(ctx, idx, s.color);
    const st = lineSeriesStyle(ctx, color, idx, meta?.s.style, s.points.length, ctx.spec.kind === 'area' && idx === 0);
    return { ...st, name: s.label, id: s.id, data: s.points };
  });
  const rl = refLines(ctx);
  if (rl && series[0]) (series[0] as Record<string, unknown>).markLine = rl;
  return {
    backgroundColor: 'transparent',
    animationDuration: 700,
    textStyle: { fontFamily: b.font },
    grid: grid(ctx, ctx.size === 'full', false),
    tooltip: {
      ...b.tooltip,
      show: ctx.size !== 'mini',
      formatter: (params: Array<{ seriesName: string; value: [number, number]; color: string }>) => {
        if (!params.length) return '';
        const dayIndex = params[0]!.value[0];
        const rows = params
          .map((p) => {
            const start = starts.get(p.seriesName);
            const date = start !== undefined ? fmtDay(start + p.value[0] - 1, 'medium') : '';
            return `<div style="display:flex;align-items:center;gap:8px;margin-top:4px"><span style="width:8px;height:8px;border-radius:50%;background:${p.color}"></span><span style="opacity:.75">${esc(p.seriesName)} <span style="opacity:.6">· ${esc(date)}</span></span><b style="margin-left:auto;font-family:${b.numberFont};padding-left:14px">${esc(fmtValue(p.value[1], unit, decimals))}</b></div>`;
          })
          .join('');
        return `<div style="font-weight:700;font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.6">Day ${dayIndex}</div>${rows}`;
      },
    },
    xAxis: {
      type: 'value',
      show: ctx.size !== 'mini',
      min: 1,
      max: 'dataMax',
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { ...b.axisLabel, formatter: (v: number) => `day ${v}` },
    },
    yAxis: valueAxis(ctx, b, unit, decimals),
    dataZoom: dataZoom(ctx, b, 'value'),
    series,
  };
}

export function categoryLabel(c: { label: string; from: DayNum; to: DayNum; periodId?: string }, bucket: string | undefined): string {
  if (c.periodId) return c.label;
  switch (bucket) {
    case 'year':
      return fmtDay(c.from, 'year');
    case 'month':
      return fmtDay(c.from, 'monthShort');
    case 'quarter': {
      const iso = fromDayNum(c.from);
      return `Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1} ’${iso.slice(2, 4)}`;
    }
    case 'week':
      return fmtDay(c.from, 'short');
    default:
      return c.label;
  }
}

/** How many categories each preset shows, per bucket size. */
export function windowSize(bucket: string | undefined, preset: ViewPreset): number | null {
  if (!bucket || preset === 'all') return null;
  const perYear = bucket === 'week' ? 52 : bucket === 'month' ? 12 : bucket === 'quarter' ? 4 : 1;
  const span = preset === 'year' ? perYear : preset === 'quarter' ? Math.round(perYear / 4) : Math.round(perYear / 12);
  return Math.max(span, bucket === 'year' ? 1 : 3);
}

/** The categories a chart opens on: the latest window of its preset. */
export function defaultCategoryWindow(spec: ChartSpec, n: number): { start: number; end: number } {
  const size = windowSize(spec.x.mode === 'bucket' ? spec.x.bucket : undefined, spec.view.preset);
  if (!size || size >= n) return { start: 0, end: Math.max(n - 1, 0) };
  return { start: n - size, end: n - 1 };
}

/** Keeps only the visible categories; a waterfall restarts its running total at the first one. */
export function sliceCategories<T extends CategoryChartData | OhlcChartData | WaterfallChartData>(data: T, win: { start: number; end: number }): T {
  const s = Math.max(0, win.start);
  const e = Math.min(data.categories.length, win.end + 1);
  if (s === 0 && e === data.categories.length) return data;
  const categories = data.categories.slice(s, e);
  switch (data.mode) {
    case 'category':
      return { ...data, categories, series: data.series.map((x) => ({ ...x, values: x.values.slice(s, e) })) };
    case 'ohlc':
      return { ...data, categories, series: data.series.map((x) => ({ ...x, ohlc: x.ohlc.slice(s, e) })) };
    default: {
      const deltas = data.deltas.slice(s, e);
      const base: number[] = [];
      const total: number[] = [];
      let run = 0;
      for (const d of deltas) {
        base.push(run);
        run += d ?? 0;
        total.push(run);
      }
      return { ...data, categories, deltas, base, total };
    }
  }
}

function categoryOption(data: CategoryChartData, ctx: BuildContext): EChartsOption {
  const b = base(ctx);
  const t = b.t;
  const unit = ctx.spec.unit ?? '';
  const decimals = ctx.spec.decimals ?? 1;
  const bucket = ctx.spec.x.mode === 'bucket' ? ctx.spec.x.bucket : undefined;
  const labels = data.categories.map((c) => categoryLabel(c, bucket));
  const specSeries = new Map(ctx.spec.series.map((s, i) => [s.id, { s, i }]));
  const visible = data.series.filter((s) => !ctx.hidden?.has(s.id));
  const rightAxis = visible.some((s) => specSeries.get(s.id)?.s.axis === 'right');
  const asLine = ctx.spec.kind === 'line' || ctx.spec.kind === 'area';
  const signColors = visible.length === 1;
  const radius = Math.max(2, Math.round(t.radius * 0.35));

  const series = visible.map((s) => {
    const meta = specSeries.get(s.id);
    const idx = meta?.i ?? 0;
    const color = seriesColor(ctx, idx, s.color);
    const yAxisIndex = meta?.s.axis === 'right' ? 1 : 0;
    if (asLine) {
      return { ...lineSeriesStyle(ctx, color, idx, meta?.s.style, s.values.length, ctx.spec.kind === 'area'), name: s.label, id: s.id, yAxisIndex, data: s.values.map((v) => v ?? '-') };
    }
    return {
      type: 'bar',
      name: s.label,
      id: s.id,
      yAxisIndex,
      data: s.values.map((v) => v ?? '-'),
      barMaxWidth: ctx.size === 'full' ? 34 : 22,
      barCategoryGap: '28%',
      itemStyle: {
        color: (p: { value: number }) => {
          const c = signColors && typeof p.value === 'number' && p.value < 0 ? t.negative : color;
          return {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: c },
              { offset: 1, color: alpha(c, 0.55) },
            ],
          };
        },
        borderRadius: [radius, radius, radius * 0.4, radius * 0.4],
        shadowBlur: 10 * t.glow,
        shadowColor: alpha(color, 0.35 * t.glow),
      },
      label: {
        show: ctx.size === 'full' && data.categories.length <= 14,
        position: 'top',
        color: t.muted,
        fontFamily: b.numberFont,
        fontSize: 10.5,
        formatter: (p: { value: number }) => (typeof p.value === 'number' ? fmtNum(p.value, Math.abs(p.value) >= 100 ? 0 : decimals, { compact: Math.abs(p.value) >= 10_000 }) : ''),
      },
    };
  });
  const rl = refLines(ctx);
  if (rl && series[0]) (series[0] as Record<string, unknown>).markLine = rl;

  return {
    backgroundColor: 'transparent',
    animationDuration: 650,
    animationDelay: (i: number) => i * 18,
    textStyle: { fontFamily: b.font },
    grid: grid(ctx, false, rightAxis),
    tooltip: {
      ...b.tooltip,
      show: ctx.size !== 'mini',
      axisPointer: { type: 'shadow', shadowStyle: { color: alpha(t.text, 0.05) } },
      formatter: (params: Array<{ seriesName: string; value: number | string; color: unknown; dataIndex: number; seriesId: string }>) => {
        if (!params.length) return '';
        const cat = data.categories[params[0]!.dataIndex]!;
        const head = cat.periodId ? `${cat.label} · ${fmtDay(cat.from, 'monthShort')} – ${fmtDay(cat.to, 'monthShort')}` : categoryLabel(cat, bucket);
        const rows = params
          .map((p) => {
            const right = specSeries.get(p.seriesId)?.s.axis === 'right';
            const v = typeof p.value === 'number' ? (right ? fmtNum(p.value, 2) : fmtValue(p.value, unit, decimals)) : '—';
            const dot = typeof p.color === 'string' ? p.color : t.accent;
            return `<div style="display:flex;align-items:center;gap:8px;margin-top:4px"><span style="width:8px;height:8px;border-radius:2px;background:${dot}"></span><span style="opacity:.75">${esc(p.seriesName)}</span><b style="margin-left:auto;font-family:${b.numberFont};padding-left:14px">${esc(v)}</b></div>`;
          })
          .join('');
        return `<div style="font-weight:700;font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.6">${esc(head)}</div>${rows}`;
      },
    },
    xAxis: {
      type: 'category',
      show: ctx.size !== 'mini',
      data: labels,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...b.axisLabel, fontFamily: data.categories[0]?.periodId ? b.font : b.numberFont },
    },
    yAxis: rightAxis ? [valueAxis(ctx, b, unit, decimals), { ...valueAxis(ctx, b, '', 2, 'right'), scale: true, min: undefined, max: undefined }] : valueAxis(ctx, b, unit, decimals),
    dataZoom: [],
    series,
  };
}

function ohlcOption(data: OhlcChartData, ctx: BuildContext): EChartsOption {
  const b = base(ctx);
  const t = b.t;
  const unit = ctx.spec.unit ?? '';
  const decimals = ctx.spec.decimals ?? 0;
  const bucket = ctx.spec.x.mode === 'bucket' ? ctx.spec.x.bucket : undefined;
  const labels = data.categories.map((c) => categoryLabel(c, bucket));
  const s = data.series[0];
  return {
    backgroundColor: 'transparent',
    animationDuration: 600,
    textStyle: { fontFamily: b.font },
    grid: grid(ctx, false, false),
    tooltip: {
      ...b.tooltip,
      show: ctx.size !== 'mini',
      formatter: (params: Array<{ dataIndex: number }>) => {
        const i = params[0]?.dataIndex ?? 0;
        const o = s?.ohlc[i];
        if (!o) return '';
        const row = (k: string, v: number) =>
          `<div style="display:flex;gap:16px;margin-top:3px"><span style="opacity:.7">${k}</span><b style="margin-left:auto;font-family:${b.numberFont}">${esc(fmtValue(v, unit, decimals))}</b></div>`;
        const change = o[1] - o[0];
        return `<div style="font-weight:700;font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.6">${esc(labels[i] ?? '')}</div>${row('Open', o[0])}${row('High', o[3])}${row('Low', o[2])}${row('Close', o[1])}<div style="margin-top:6px;font-weight:700;color:${change >= 0 ? t.positive : t.negative}">${esc(fmtValue(change, unit, decimals, { sign: true }))}</div>`;
      },
    },
    xAxis: { type: 'category', show: ctx.size !== 'mini', data: labels, axisLine: { show: false }, axisTick: { show: false }, axisLabel: b.axisLabel },
    yAxis: valueAxis(ctx, b, unit, decimals),
    dataZoom: [],
    series: s
      ? [
          {
            type: 'candlestick',
            name: s.label,
            data: s.ohlc.map((o) => o ?? '-'),
            barMaxWidth: ctx.size === 'full' ? 18 : 12,
            itemStyle: {
              color: t.positive,
              color0: t.negative,
              borderColor: t.positive,
              borderColor0: t.negative,
              borderWidth: 1.2,
              shadowBlur: 8 * t.glow,
              shadowColor: alpha(t.text, 0.08),
            },
          },
        ]
      : [],
  };
}

function waterfallOption(data: WaterfallChartData, ctx: BuildContext): EChartsOption {
  const b = base(ctx);
  const t = b.t;
  const unit = ctx.spec.unit ?? '';
  const decimals = ctx.spec.decimals ?? 0;
  const bucket = ctx.spec.x.mode === 'bucket' ? ctx.spec.x.bucket : undefined;
  const labels = data.categories.map((c) => categoryLabel(c, bucket));
  const radius = Math.max(2, Math.round(t.radius * 0.3));
  const helper = data.deltas.map((d, i) => (d === null ? '-' : Math.min(data.base[i]!, data.total[i]!)));
  const visible = data.deltas.map((d) => (d === null ? '-' : Math.abs(d)));
  return {
    backgroundColor: 'transparent',
    animationDuration: 650,
    animationDelay: (i: number) => i * 20,
    textStyle: { fontFamily: b.font },
    grid: grid(ctx, false, false),
    tooltip: {
      ...b.tooltip,
      show: ctx.size !== 'mini',
      axisPointer: { type: 'shadow', shadowStyle: { color: alpha(t.text, 0.05) } },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const i = params[0]?.dataIndex ?? 0;
        const d = data.deltas[i];
        const color = d === null ? t.muted : d >= 0 ? t.positive : t.negative;
        return `<div style="font-weight:700;font-size:11px;letter-spacing:.06em;text-transform:uppercase;opacity:.6">${esc(labels[i] ?? '')}</div><div style="margin-top:4px;font-family:${b.numberFont};font-weight:700;font-size:15px;color:${color}">${esc(d === null ? '—' : fmtValue(d, unit, decimals, { sign: true }))}</div><div style="opacity:.7;margin-top:2px">Running total <b style="font-family:${b.numberFont}">${esc(fmtValue(data.total[i] ?? 0, unit, decimals))}</b></div>`;
      },
    },
    xAxis: { type: 'category', show: ctx.size !== 'mini', data: labels, axisLine: { show: false }, axisTick: { show: false }, axisLabel: b.axisLabel },
    yAxis: { ...valueAxis(ctx, b, unit, decimals), scale: true },
    dataZoom: [],
    series: [
      {
        type: 'bar',
        stack: 'wf',
        stackStrategy: 'all',
        silent: true,
        itemStyle: { color: 'transparent' },
        emphasis: { disabled: true },
        tooltip: { show: false },
        data: helper,
      },
      {
        type: 'bar',
        stack: 'wf',
        stackStrategy: 'all',
        name: data.label,
        barMaxWidth: ctx.size === 'full' ? 30 : 18,
        data: visible.map((v, i) => ({
          value: v,
          itemStyle: {
            color: (data.deltas[i] ?? 0) >= 0 ? t.positive : t.negative,
            borderRadius: radius,
            shadowBlur: 10 * t.glow,
            shadowColor: alpha((data.deltas[i] ?? 0) >= 0 ? t.positive : t.negative, 0.35 * t.glow),
          },
        })),
      },
      {
        type: 'line',
        name: 'Total',
        data: data.total,
        smooth: 0.3,
        showSymbol: false,
        lineStyle: { color: alpha(t.text, 0.5), width: 1.2, type: [2, 3] as number[] },
        z: 4,
        tooltip: { show: false },
      },
    ],
  };
}
