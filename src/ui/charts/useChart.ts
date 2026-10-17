import { useMemo } from 'react';
import { useWorkspace } from '@/app/hooks';
import { evaluateChart } from '@/core/engine';
import type { ChartData, DataSource } from '@/core/engine/types';
import type { DayNum } from '@/core/model/dates';
import type { ChartSpec } from '@/core/model/types';

/** Evaluates a chart spec against the current data. */
export function useChartData(spec: ChartSpec | undefined): { data: ChartData | null; today: DayNum; better: 'up' | 'down' | null } {
  const { ws, src, today } = useWorkspace();
  const data = useMemo(() => {
    if (!spec) return null;
    try {
      return evaluateChart(spec, ws, src);
    } catch (err) {
      return {
        mode: 'time',
        series: [],
        bands: [],
        domain: null,
        errors: [{ seriesId: '', message: err instanceof Error ? err.message : String(err), span: null }],
      } satisfies ChartData;
    }
  }, [spec, ws, src]);
  const better = useMemo(() => (spec ? chartBetter(spec, src) : null), [spec, src]);
  return { data, today, better };
}

/** Whether a rise is good for this chart: explicit, or taken from the metric it plots. */
export function chartBetter(spec: ChartSpec, src: DataSource): 'up' | 'down' | null {
  if (spec.better !== undefined) return spec.better ?? null;
  const expr = spec.series[0]?.expr.trim() ?? '';
  const m = /^[A-Za-z_][A-Za-z0-9_]*$/.test(expr) ? src.metrics.find((x) => x.slug === expr) : undefined;
  return m?.better ?? null;
}

/** CSS class for a change: green when it goes the good way, red otherwise, plain when unknown. */
export function changeClass(change: number, better: 'up' | 'down' | null): string {
  if (!better || Math.abs(change) < 1e-12) return '';
  return (change > 0) === (better === 'up') ? 'pos' : 'neg';
}

export interface Headline {
  value: number | null;
  /** Change across the visible data. */
  change: number | null;
  label: string;
}

/** The big number shown on a chart card: last value of the first series and its change. */
export function headline(data: ChartData | null): Headline | null {
  if (!data) return null;
  switch (data.mode) {
    case 'time': {
      const s = data.series[0];
      if (!s || !s.points.length) return null;
      const last = s.points[s.points.length - 1]![1];
      const first = s.points[0]![1];
      return { value: last, change: s.points.length > 1 ? last - first : null, label: s.label };
    }
    case 'elapsed': {
      const s = data.series[0];
      if (!s || !s.points.length) return null;
      return { value: s.points[s.points.length - 1]![1], change: null, label: s.label };
    }
    case 'category': {
      const s = data.series[0];
      if (!s) return null;
      const vals = s.values.filter((v): v is number => v !== null);
      if (!vals.length) return null;
      // Bars are compared by eye; a change against the previous bar reads as noise.
      return { value: vals[vals.length - 1]!, change: null, label: s.label };
    }
    case 'ohlc': {
      const s = data.series[0];
      const rows = s?.ohlc.filter((o): o is [number, number, number, number] => o !== null) ?? [];
      if (!rows.length) return null;
      const last = rows[rows.length - 1]!;
      return { value: last[1], change: last[1] - last[0], label: s!.label };
    }
    case 'waterfall': {
      const vals = data.deltas.filter((v): v is number => v !== null);
      if (!vals.length) return null;
      return { value: vals[vals.length - 1]!, change: null, label: data.label };
    }
    case 'multiples': {
      const p = data.panels[data.panels.length - 1];
      return p ? headline(p.data) : null;
    }
  }
}
