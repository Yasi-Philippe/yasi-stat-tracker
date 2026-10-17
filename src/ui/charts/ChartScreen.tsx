import { ArrowLeft, ChevronLeft, ChevronRight, PencilLine, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme, useVault } from '@/app/hooks';
import { back, navigate } from '@/app/router';
import { chart as getChart, saveChart } from '@/core/data/repo';
import type { ChartData, TimeChartData } from '@/core/engine/types';
import { addMonths, type DayNum, dayNumToMs, fromYMD, monthEnd, monthStart, msToDayNum, quarterStart, yearEnd, yearStart, ymd } from '@/core/model/dates';
import type { ChartSpec, ViewPreset } from '@/core/model/types';
import { Segmented, ToggleRow } from '../components/Controls';
import { Sheet } from '../components/Sheet';
import { toast } from '../components/Toast';
import { fmtDay, fmtValue, parseInput, splitNumber } from '../format';
import { buildOption, categoryLabel, windowSize } from './buildOption';
import { ChartBody, isEmpty, PanelChange } from './ChartCard';
import { ChartCanvas } from './ChartCanvas';
import type { ECharts } from './echarts';
import { changeClass, useChartData } from './useChart';
import './charts.css';

type Win = { start: DayNum; end: DayNum };

/** Calendar-aligned window of a preset containing `anchor`. */
function calendarWindow(preset: ViewPreset, anchor: DayNum): Win | null {
  switch (preset) {
    case 'year':
      return { start: yearStart(anchor), end: yearEnd(anchor) };
    case 'quarter': {
      const s = quarterStart(anchor);
      return { start: s, end: addMonths(s, 3) - 1 };
    }
    case 'month':
      return { start: monthStart(anchor), end: monthEnd(anchor) };
    default:
      return null;
  }
}

function shiftWindow(preset: ViewPreset, w: Win, dir: 1 | -1): Win | null {
  if (preset === 'year') {
    const y = ymd(w.start).y + dir;
    return { start: fromYMD(y, 1, 1), end: fromYMD(y + 1, 1, 1) - 1 };
  }
  const months = preset === 'quarter' ? 3 : 1;
  const s = addMonths(w.start, dir * months);
  return { start: s, end: addMonths(s, months) - 1 };
}

function windowLabel(preset: ViewPreset | 'custom', w: Win | null): string {
  if (!w || preset === 'all') return 'All time';
  if (preset === 'year') return fmtDay(w.start, 'year');
  if (preset === 'month') return fmtDay(w.start, 'month');
  if (preset === 'quarter') return `Q${Math.floor((ymd(w.start).m - 1) / 3) + 1} ${ymd(w.start).y}`;
  return `${fmtDay(w.start, 'medium')} – ${fmtDay(w.end, 'medium')}`;
}

export function ChartScreen({ id }: { id: string }) {
  const { vault, version } = useVault();
  const spec = useMemo(() => getChart(vault, id), [vault, version, id]);
  if (!spec) {
    return (
      <div className="empty card">
        <h3>Chart not found</h3>
        <button className="btn" onClick={() => navigate({ name: 'charts' })}>
          Back to charts
        </button>
      </div>
    );
  }
  return <ChartView spec={spec} />;
}

function ChartView({ spec }: { spec: ChartSpec }) {
  const { vault } = useVault();
  const theme = useTheme();
  const { data, better } = useChartData(spec);
  const [axisOpen, setAxisOpen] = useState(false);
  const [axis, setAxis] = useState({ yMin: spec.view.yMin ?? null, yMax: spec.view.yMax ?? null, yZero: spec.view.yZero ?? false });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const isTime = data?.mode === 'time';
  const domain = isTime ? (data as TimeChartData).domain : null;

  // Grouped charts (per week/month/…) browse a window of categories instead of zooming.
  const catData = data && (data.mode === 'category' || data.mode === 'ohlc' || data.mode === 'waterfall') ? data : null;
  const catCount = catData?.categories.length ?? 0;
  const bucket = spec.x.mode === 'bucket' ? spec.x.bucket : undefined;
  const [catSize, setCatSize] = useState<number | null>(() => windowSize(bucket, spec.view.preset));
  const [catEnd, setCatEnd] = useState<number | null>(null);
  const catWindow =
    catData && catSize && catSize < catCount
      ? (() => {
          const end = Math.min(catEnd ?? catCount - 1, catCount - 1);
          return { start: Math.max(0, end - catSize + 1), end };
        })()
      : null;
  const catSizes: Array<[number | null, string]> =
    bucket === 'week'
      ? [[null, 'All'], [52, 'Year'], [13, 'Quarter']]
      : bucket === 'month'
        ? [[null, 'All'], [24, '2 years'], [12, 'Year'], [6, '6 months']]
        : bucket === 'quarter'
          ? [[null, 'All'], [12, '3 years'], [4, 'Year']]
          : [];

  const [preset, setPreset] = useState<ViewPreset | 'custom'>(spec.view.preset);
  const [win, setWin] = useState<Win | null>(() => (domain ? calendarWindow(spec.view.preset, domain.max) : null));
  const initialWin = useRef(win);
  const chartRef = useRef<ECharts | null>(null);

  useEffect(() => {
    if (domain && initialWin.current === null && spec.view.preset !== 'all') {
      const w = calendarWindow(spec.view.preset, domain.max);
      initialWin.current = w;
      setWin(w);
    }
  }, [domain, spec.view.preset]);

  const option = useMemo(
    () =>
      data && data.mode !== 'multiples'
        ? buildOption(data, { spec, theme: theme.tokens, size: 'full', window: initialWin.current, yMin: axis.yMin, yMax: axis.yMax, yZero: axis.yZero, hidden, catWindow })
        : null,
    // The time window is applied imperatively after the first render, so it is not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, spec, theme, axis, hidden, catWindow?.start, catWindow?.end],
  );

  const applyWindow = useCallback((w: Win | null, d = domain) => {
    const c = chartRef.current;
    if (!c || !d) return;
    const start = dayNumToMs(w ? w.start : d.min);
    const end = dayNumToMs(w ? w.end : d.max);
    c.dispatchAction({ type: 'dataZoom', startValue: start, endValue: end });
  }, [domain]);

  const choosePreset = (p: ViewPreset) => {
    setPreset(p);
    const anchor = win ? Math.min(win.end, domain?.max ?? win.end) : domain?.max;
    const w = p === 'all' || anchor === undefined ? null : calendarWindow(p, anchor);
    setWin(w);
    applyWindow(w);
  };

  const step = (dir: 1 | -1) => {
    if (!win || preset === 'all' || preset === 'custom') return;
    const w = shiftWindow(preset, win, dir);
    if (!w || !domain) return;
    if (dir < 0 && w.end < domain.min) return;
    if (dir > 0 && w.start > domain.max) return;
    setWin(w);
    applyWindow(w);
  };

  const onZoom = useCallback(
    (e: { startValue: number | null; endValue: number | null }) => {
      if (!isTime || e.startValue === null || e.endValue === null) return;
      const w = { start: msToDayNum(e.startValue), end: msToDayNum(e.endValue) };
      setWin((prev) => {
        if (prev && Math.abs(prev.start - w.start) <= 1 && Math.abs(prev.end - w.end) <= 1) return prev;
        setPreset('custom');
        return w;
      });
    },
    [isTime],
  );

  const stats = useMemo(() => (isTime ? windowStats(data as TimeChartData, win, hidden) : null), [isTime, data, win, hidden]);
  const unit = spec.unit ?? '';
  const decimals = spec.decimals ?? 1;
  const multi = data?.mode === 'multiples' ? data : null;
  const seriesForLegend = data && 'series' in data ? (data.series as Array<{ id: string; label: string; color?: string | null }>) : [];

  return (
    <div className="chart-screen">
      <div className="chart-top">
        <button className="icon-btn" onClick={() => back({ name: 'charts' })} aria-label="Back">
          <ArrowLeft size={20} />
        </button>
        <div className="row">
          {data?.mode !== 'multiples' && (
            <button className="icon-btn" onClick={() => setAxisOpen(true)} title="Axis">
              <SlidersHorizontal size={18} />
            </button>
          )}
          <button className="icon-btn" onClick={() => navigate({ name: 'studio', section: 'charts', id: spec.id })} title="Edit chart">
            <PencilLine size={18} />
          </button>
        </div>
      </div>
      <header className="chart-head">
        <h1 className="display chart-title">{spec.title}</h1>
        {spec.subtitle && <p className="muted">{spec.subtitle}</p>}
      </header>

      {stats && stats.last !== null && (
        <div className="chart-figure">
          <BigNumber value={stats.last} unit={unit} decimals={decimals} />
          {stats.change !== null && (
            <span className={`chip ${changeClass(stats.change, better)}`}>
              {fmtValue(stats.change, unit, decimals, { sign: true })} <span className="faint">· {windowLabel(preset, win)}</span>
            </span>
          )}
        </div>
      )}

      {isTime && (
        <div className="range-bar">
          <Segmented<ViewPreset>
            value={preset === 'custom' ? ('' as ViewPreset) : preset}
            onChange={choosePreset}
            options={[
              { value: 'all', label: 'All' },
              { value: 'year', label: 'Year' },
              { value: 'quarter', label: 'Quarter' },
              { value: 'month', label: 'Month' },
            ]}
          />
          {preset !== 'all' && preset !== 'custom' && (
            <div className="range-nav">
              <button className="icon-btn" onClick={() => step(-1)} aria-label="Previous">
                <ChevronLeft size={18} />
              </button>
              <span className="range-label">{windowLabel(preset, win)}</span>
              <button className="icon-btn" onClick={() => step(1)} aria-label="Next">
                <ChevronRight size={18} />
              </button>
            </div>
          )}
          {preset === 'custom' && <span className="range-label small muted">{windowLabel('custom', win)}</span>}
        </div>
      )}

      {catData && catSizes.length > 0 && catCount > 3 && (
        <div className="range-bar">
          <div className="seg" role="group" aria-label="Range">
            {catSizes.map(([size, label]) => (
              <button
                key={label}
                type="button"
                aria-pressed={catSize === size || (size !== null && catSize !== null && catSize >= catCount && size >= catCount)}
                onClick={() => {
                  setCatSize(size);
                  setCatEnd(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {catWindow && (
            <div className="range-nav">
              <button className="icon-btn" aria-label="Earlier" disabled={catWindow.start === 0} onClick={() => setCatEnd(Math.max(catSize! - 1, catWindow.end - catSize!))}>
                <ChevronLeft size={18} />
              </button>
              <span className="range-label small">
                {categoryLabel(catData.categories[catWindow.start]!, bucket)} – {categoryLabel(catData.categories[catWindow.end]!, bucket)}
              </span>
              <button className="icon-btn" aria-label="Later" disabled={catWindow.end >= catCount - 1} onClick={() => setCatEnd(Math.min(catCount - 1, catWindow.end + catSize!))}>
                <ChevronRight size={18} />
              </button>
            </div>
          )}
        </div>
      )}

      {seriesForLegend.length > 1 && (
        <div className="legend scroll-x">
          {seriesForLegend.map((s, i) => {
            const color = s.color || theme.tokens.palette[spec.series.findIndex((x) => x.id === s.id) % theme.tokens.palette.length] || theme.tokens.accent;
            const off = hidden.has(s.id);
            return (
              <button
                key={s.id}
                className={`legend-item${off ? ' off' : ''}`}
                onClick={() => {
                  const next = new Set(hidden);
                  if (off) next.delete(s.id);
                  else if (next.size < seriesForLegend.length - 1) next.add(s.id);
                  setHidden(next);
                }}
              >
                <span className="legend-swatch" style={{ background: color }} />
                {s.label}
                <span className="sr-only">{i}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="chart-stage card">
        {data && data.errors.length > 0 && (
          <div className="chart-errors">
            {data.errors.map((e, i) => (
              <div key={i}>{e.message}</div>
            ))}
          </div>
        )}
        {multi ? (
          <div className="multiples full">
            {multi.panels.map((p) => (
              <div key={p.period.id} className="multiple">
                <div className="multiple-head">
                  <b>{p.period.name}</b>
                  <span className="tiny muted">
                    {fmtDay(p.period.start, 'medium')} – {p.period.end ? fmtDay(p.period.end, 'medium') : 'now'}
                  </span>
                </div>
                <PanelChange data={p.data} unit={unit} decimals={decimals} better={better} />
                <ChartBody data={p.data} spec={{ ...spec, filter: null }} theme={theme.tokens} height={190} better={better} />
              </div>
            ))}
            {multi.panels.length === 0 && <p className="muted small">No periods yet.</p>}
          </div>
        ) : data && isEmpty(data) ? (
          <ChartBody data={data} spec={spec} theme={theme.tokens} height={300} />
        ) : (
          option && (
            <ChartCanvas
              option={option}
              height="min(58vh, 520px)"
              onReady={(c) => {
                chartRef.current = c;
              }}
              onZoom={onZoom}
            />
          )
        )}
      </div>

      {stats && stats.count > 0 && (
        <div className="stat-grid">
          <Stat label="Lowest" value={fmtValue(stats.min, unit, decimals)} sub={stats.minDay !== null ? fmtDay(stats.minDay, 'medium') : ''} />
          <Stat label="Highest" value={fmtValue(stats.max, unit, decimals)} sub={stats.maxDay !== null ? fmtDay(stats.maxDay, 'medium') : ''} />
          <Stat label="Average" value={fmtValue(stats.mean, unit, decimals)} sub={`${stats.count} points`} />
          <Stat label="Range" value={fmtValue(stats.max - stats.min, unit, decimals)} sub={windowLabel(preset, win)} />
        </div>
      )}

      <Sheet open={axisOpen} onClose={() => setAxisOpen(false)} title="Axis">
        <AxisEditor
          value={axis}
          onChange={setAxis}
          onSave={() => {
            saveChart(vault, { ...spec, view: { ...spec.view, yMin: axis.yMin, yMax: axis.yMax, yZero: axis.yZero } });
            toast('Saved as this chart’s default');
            setAxisOpen(false);
          }}
          onReset={() => {
            setAxis({ yMin: null, yMax: null, yZero: false });
            choosePreset('all');
          }}
        />
      </Sheet>
    </div>
  );
}

function BigNumber({ value, unit, decimals }: { value: number; unit: string; decimals: number }) {
  const s = fmtValue(value, unit, decimals);
  const bare = unit === '%' ? s.replace('%', '') : s.replace(` ${unit}`, '');
  const { int, frac } = splitNumber(bare);
  return (
    <span className="big-number">
      <span className="display">
        {int}
        <span className="frac">{frac}</span>
      </span>
      <span className="big-unit">{unit}</span>
    </span>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat card flat">
      <div className="eyebrow">{label}</div>
      <div className="stat-value num">{value}</div>
      {sub && <div className="tiny muted">{sub}</div>}
    </div>
  );
}

function AxisEditor({
  value,
  onChange,
  onSave,
  onReset,
}: {
  value: { yMin: number | null; yMax: number | null; yZero: boolean };
  onChange: (v: { yMin: number | null; yMax: number | null; yZero: boolean }) => void;
  onSave: () => void;
  onReset: () => void;
}) {
  const [min, setMin] = useState(value.yMin === null ? '' : String(value.yMin));
  const [max, setMax] = useState(value.yMax === null ? '' : String(value.yMax));
  const commit = (nextMin = min, nextMax = max, zero = value.yZero) => onChange({ yMin: parseInput(nextMin), yMax: parseInput(nextMax), yZero: zero });
  return (
    <div className="stack-16">
      <p className="small muted">Leave a box empty to let the axis fit the data. Pinch or scroll on the chart to zoom the time axis.</p>
      <div className="row">
        <div className="field grow">
          <label>Lowest value</label>
          <input className="input" inputMode="decimal" value={min} placeholder="Auto" onChange={(e) => (setMin(e.target.value), commit(e.target.value, max))} />
        </div>
        <div className="field grow">
          <label>Highest value</label>
          <input className="input" inputMode="decimal" value={max} placeholder="Auto" onChange={(e) => (setMax(e.target.value), commit(min, e.target.value))} />
        </div>
      </div>
      <ToggleRow title="Always include zero" sub="Useful for totals; off zooms into the variation." checked={value.yZero} onChange={(z) => commit(min, max, z)} />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button
          className="btn ghost"
          onClick={() => {
            setMin('');
            setMax('');
            onReset();
          }}
        >
          Reset view
        </button>
        <button className="btn primary" onClick={onSave}>
          Save as default
        </button>
      </div>
    </div>
  );
}

interface WindowStats {
  last: number | null;
  change: number | null;
  min: number;
  max: number;
  mean: number;
  count: number;
  minDay: DayNum | null;
  maxDay: DayNum | null;
}

function windowStats(data: TimeChartData, win: Win | null, hidden: Set<string>): WindowStats | null {
  const s = data.series.find((x) => !hidden.has(x.id));
  if (!s) return null;
  const pts = win ? s.points.filter(([d]) => d >= win.start && d <= win.end) : s.points;
  if (!pts.length) return { last: null, change: null, min: 0, max: 0, mean: 0, count: 0, minDay: null, maxDay: null };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let minDay: DayNum | null = null;
  let maxDay: DayNum | null = null;
  for (const [d, v] of pts) {
    sum += v;
    if (v < min) {
      min = v;
      minDay = d;
    }
    if (v > max) {
      max = v;
      maxDay = d;
    }
  }
  const last = pts[pts.length - 1]![1];
  return { last, change: pts.length > 1 ? last - pts[0]![1] : null, min, max, mean: sum / pts.length, count: pts.length, minDay, maxDay };
}

export type { ChartData };
