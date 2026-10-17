import { AlertTriangle, Maximize2 } from 'lucide-react';
import { useMemo } from 'react';
import { useTheme } from '@/app/hooks';
import { navigate } from '@/app/router';
import type { ChartData } from '@/core/engine/types';
import type { ChartSpec } from '@/core/model/types';
import { fmtDay, fmtValue, splitNumber } from '../format';
import { buildOption } from './buildOption';
import { ChartCanvas } from './ChartCanvas';
import { changeClass, headline, useChartData } from './useChart';
import './charts.css';

export function ChartCard({ spec, size = 'full', index = 0 }: { spec: ChartSpec; size?: 'full' | 'half'; index?: number }) {
  const { data, better } = useChartData(spec);
  const theme = useTheme();
  const head = headline(data);
  const unit = spec.unit ?? '';
  const decimals = spec.decimals ?? 1;
  const since = data?.mode === 'time' && data.domain ? fmtDay(data.domain.min, 'monthShort') : null;
  const formatted = head?.value !== null && head?.value !== undefined ? fmtValue(head.value, unit, decimals) : null;
  const parts = formatted ? splitNumber(formatted.replace(` ${unit}`, '').replace('%', '')) : null;

  return (
    <article className={`ccard card ${size}`} style={{ animationDelay: `${index * 50}ms` }}>
      <header className="ccard-head" onClick={() => navigate({ name: 'chart', id: spec.id })}>
        <div className="grow">
          <h3 className="ccard-title">{spec.title}</h3>
          {spec.subtitle && <p className="ccard-sub">{spec.subtitle}</p>}
        </div>
        <button className="icon-btn" aria-label={`Open ${spec.title}`}>
          <Maximize2 size={16} />
        </button>
      </header>
      {head && parts && (
        <div className="ccard-figure">
          <span className="display ccard-num">
            {parts.int}
            <span className="frac">{parts.frac}</span>
          </span>
          <span className="ccard-unit">{unit}</span>
          {head.change !== null && Math.abs(head.change) > 1e-9 && (
            <span className={`chip ${changeClass(head.change, better)}`}>
              {fmtValue(head.change, unit, decimals, { sign: true, compact: Math.abs(head.change) >= 10_000 })}
              {since && <span className="faint"> · since {since}</span>}
            </span>
          )}
        </div>
      )}
      <ChartBody data={data} spec={spec} theme={theme.tokens} height={size === 'half' ? 170 : 210} better={better} />
    </article>
  );
}

export function ChartBody({
  data,
  spec,
  theme,
  height,
  better = null,
}: {
  data: ChartData | null;
  spec: ChartSpec;
  theme: import('@/core/model/types').ThemeTokens;
  height: number;
  better?: 'up' | 'down' | null;
}) {
  const option = useMemo(() => (data && data.mode !== 'multiples' ? buildOption(data, { spec, theme, size: 'card' }) : null), [data, spec, theme]);
  if (!data) return null;
  const errors = data.errors;
  const empty = isEmpty(data);
  if (data.mode === 'multiples') {
    const panels = data.panels.slice(-4);
    return (
      <div className="multiples">
        {panels.length === 0 && <EmptyChart spec={spec} message="No periods yet. Start one from the Today screen." />}
        {panels.map((p) => (
          <div key={p.period.id} className="multiple">
            <div className="multiple-head">
              <b>{p.period.name}</b>
              <span className="tiny muted">
                {fmtDay(p.period.start, 'short')} – {p.period.end ? fmtDay(p.period.end, 'short') : 'now'}
              </span>
            </div>
            <PanelChange data={p.data} unit={spec.unit ?? ''} decimals={spec.decimals ?? 1} better={better} />
            <ChartCanvas option={buildOption(p.data, { spec, theme, size: 'mini' })} height={70} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <>
      {errors.length > 0 && (
        <div className="chart-errors">
          <AlertTriangle size={14} /> {errors[0]!.message}
        </div>
      )}
      {empty ? <EmptyChart spec={spec} /> : option && <ChartCanvas option={option} height={height} />}
    </>
  );
}

export function PanelChange({ data, unit, decimals, better }: { data: ChartData; unit: string; decimals: number; better: 'up' | 'down' | null }) {
  if (data.mode !== 'time' || !data.series[0] || data.series[0].points.length < 2) return null;
  const pts = data.series[0].points;
  const change = pts[pts.length - 1]![1] - pts[0]![1];
  const days = pts[pts.length - 1]![0] - pts[0]![0] + 1;
  return (
    <div className={`multiple-change ${changeClass(change, better)}`}>
      <span className="display">{fmtValue(change, unit, decimals, { sign: true })}</span>
      <span className="tiny muted"> in {days} days</span>
    </div>
  );
}

export function isEmpty(data: ChartData): boolean {
  switch (data.mode) {
    case 'time':
    case 'elapsed':
      return data.series.every((s) => s.points.length === 0);
    case 'category':
      return data.categories.length === 0 || data.series.every((s) => s.values.every((v) => v === null));
    case 'ohlc':
      return data.categories.length === 0;
    case 'waterfall':
      return data.deltas.every((d) => d === null);
    case 'multiples':
      return data.panels.length === 0;
  }
}

function EmptyChart({ spec, message }: { spec: ChartSpec; message?: string }) {
  return (
    <div className="chart-empty">
      <svg viewBox="0 0 200 60" width="140" height="42" aria-hidden>
        <path d="M4 48 C 40 48, 46 22, 80 26 S 120 52, 150 34 S 182 10, 196 8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="5 6" strokeLinecap="round" />
      </svg>
      <span className="small">{message ?? `No data for “${spec.title}” yet.`}</span>
    </div>
  );
}
