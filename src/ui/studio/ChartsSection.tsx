import { ArrowDown, ArrowUp, BarChart3, CandlestickChart, ChevronRight, Copy, LineChart, Plus, ScatterChart, TrendingUp, Trash2, Waves } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTheme, useVault } from '@/app/hooks';
import { navigate } from '@/app/router';
import { chart as getChart, charts, dashboards, deleteChart, newId, periods, periodSets, saveChart, saveDashboard } from '@/core/data/repo';
import type { Bucket, ChartKind, ChartSeriesSpec, ChartSpec, Reducer, ViewPreset, XAxisSpec } from '@/core/model/types';
import { ChartBody } from '../charts/ChartCard';
import { useChartData } from '../charts/useChart';
import { ColorPicker, confirm, Segmented, Select, TextField, Toggle } from '../components/Controls';
import { toast } from '../components/Toast';
import { parseInput } from '../format';
import { AddButton, SaveBar, Section, StudioPage } from './common';
import { ExprInput } from './ExprInput';

const KINDS: Array<{ kind: ChartKind; label: string; icon: typeof LineChart }> = [
  { kind: 'line', label: 'Line', icon: LineChart },
  { kind: 'area', label: 'Area', icon: Waves },
  { kind: 'bar', label: 'Bars', icon: BarChart3 },
  { kind: 'waterfall', label: 'Waterfall', icon: TrendingUp },
  { kind: 'candles', label: 'Candles', icon: CandlestickChart },
  { kind: 'dots', label: 'Dots', icon: ScatterChart },
];

const REDUCERS: Array<{ value: Reducer; label: string }> = [
  { value: 'last', label: 'Last value' },
  { value: 'first', label: 'First value' },
  { value: 'sum', label: 'Sum' },
  { value: 'mean', label: 'Average' },
  { value: 'median', label: 'Median' },
  { value: 'min', label: 'Lowest' },
  { value: 'max', label: 'Highest' },
  { value: 'delta', label: 'Change (last − first)' },
  { value: 'count', label: 'Count' },
];

const sid = () => newId().slice(0, 8);

export function ChartsSection({ id }: { id?: string }) {
  if (id) return <ChartEditor id={id} />;
  return <ChartList />;
}

function ChartList() {
  const { vault, version } = useVault();
  const list = useMemo(() => charts(vault).sort((a, b) => a.title.localeCompare(b.title)), [vault, version]);
  const where = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const d of dashboards(vault)) for (const i of d.items) map.set(i.chartId, [...(map.get(i.chartId) ?? []), d.name]);
    return map;
  }, [vault, version]);
  return (
    <StudioPage title={<em>Charts</em>} actions={<AddButton label="New chart" onClick={() => navigate({ name: 'studio', section: 'charts', id: 'new' })} />}>
      {list.length === 0 ? (
        <div className="empty card">
          <h3>No charts yet</h3>
        </div>
      ) : (
        <div className="card list">
          {list.map((c) => {
            const K = KINDS.find((k) => k.kind === c.kind)?.icon ?? LineChart;
            return (
              <button key={c.id} className="list-row" onClick={() => navigate({ name: 'studio', section: 'charts', id: c.id })}>
                <span className="badge">
                  <K size={18} />
                </span>
                <span className="grow">
                  <span className="title">{c.title}</span>
                  <span className="sub">{where.get(c.id)?.join(', ') || 'Not on a dashboard'}</span>
                </span>
                <ChevronRight size={16} className="faint" />
              </button>
            );
          })}
        </div>
      )}
    </StudioPage>
  );
}

function blankChart(): ChartSpec {
  return {
    id: newId(),
    title: '',
    kind: 'line',
    x: { mode: 'date' },
    series: [{ id: sid(), expr: '' }],
    view: { preset: 'all' },
  };
}

function ChartEditor({ id }: { id: string }) {
  const { vault, version } = useVault();
  const theme = useTheme();
  const isNew = id === 'new';
  const original = useMemo(() => (isNew ? undefined : getChart(vault, id)), [vault, id, isNew]);
  const [c, setC] = useState<ChartSpec>(() => original ?? blankChart());
  const sets = useMemo(() => periodSets(vault), [vault, version]);
  const dashList = useMemo(() => dashboards(vault), [vault, version]);
  const [onDash, setOnDash] = useState<Set<string>>(() => new Set(dashList.filter((d) => d.items.some((i) => i.chartId === c.id)).map((d) => d.id)));
  const set = (patch: Partial<ChartSpec>) => setC((p) => ({ ...p, ...patch }));
  const setSeries = (i: number, patch: Partial<ChartSeriesSpec>) => set({ series: c.series.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  // Preview only series with an expression, so typing doesn't flash errors for empty rows.
  const previewSpec = useMemo(() => ({ ...c, series: c.series.filter((s) => s.expr.trim()) }), [c]);
  const { data } = useChartData(previewSpec.series.length ? previewSpec : undefined);

  if (!isNew && !original) {
    return (
      <StudioPage title="Not found" back={{ section: 'charts' }}>
        <p className="muted">This chart no longer exists.</p>
      </StudioPage>
    );
  }

  const categoryMode = c.x.mode === 'bucket' || c.x.mode === 'periods';
  const lineLike = c.kind === 'line' || c.kind === 'area';
  const xKind = c.x.mode;

  const save = () => {
    const spec: ChartSpec = { ...c, title: c.title.trim() || 'Untitled chart', series: c.series.filter((s) => s.expr.trim()) };
    vault.batch(() => {
      saveChart(vault, spec);
      for (const d of dashList) {
        const has = d.items.some((i) => i.chartId === spec.id);
        if (onDash.has(d.id) && !has) saveDashboard(vault, { ...d, items: [...d.items, { chartId: spec.id, size: 'full' }] });
        if (!onDash.has(d.id) && has) saveDashboard(vault, { ...d, items: d.items.filter((i) => i.chartId !== spec.id) });
      }
    });
    toast(isNew ? 'Chart created' : 'Saved');
    navigate({ name: 'chart', id: spec.id }, { replace: true });
  };

  return (
    <StudioPage
      title={isNew ? <em>New chart</em> : <em>{original!.title}</em>}
      back={{ section: 'charts' }}
      eyebrow="Chart"
      actions={
        original && (
          <button
            className="icon-btn"
            title="Duplicate"
            onClick={() => {
              const copy = { ...c, id: newId(), title: `${c.title} (copy)` };
              saveChart(vault, copy);
              navigate({ name: 'studio', section: 'charts', id: copy.id }, { replace: true });
              toast('Duplicated');
            }}
          >
            <Copy size={18} />
          </button>
        )
      }
    >
      <div className="editor-layout">
        <div className="editor-preview">
          <div className="card chart-stage">
            <div className="preview-title">
              <b>{c.title || 'Untitled chart'}</b>
              {c.subtitle && <span className="small muted">{c.subtitle}</span>}
            </div>
            {previewSpec.series.length === 0 ? (
              <div className="chart-empty">
                <span className="small">Write a formula for the first series to see the chart.</span>
              </div>
            ) : (
              <ChartBody data={data} spec={previewSpec} theme={theme.tokens} height={window.innerWidth < 760 ? 170 : 240} />
            )}
          </div>
        </div>

        <div className="studio-form">
          <Section title="Title">
            <TextField label="Title" value={c.title} onChange={(title) => set({ title })} placeholder="e.g. Weight" autoFocus={isNew} />
            <TextField label="Subtitle" value={c.subtitle ?? ''} onChange={(subtitle) => set({ subtitle })} placeholder="Optional" />
          </Section>

          <Section title="Type">
            <div className="kind-grid">
              {KINDS.map((k) => (
                <button key={k.kind} type="button" className="kind" aria-pressed={c.kind === k.kind} onClick={() => set(adaptKind(c, k.kind))}>
                  <k.icon size={20} />
                  <span>{k.label}</span>
                </button>
              ))}
            </div>
            <div className="field">
              <span className="field-label">Horizontal axis</span>
              <Segmented
                value={xKind}
                onChange={(mode) => set({ x: defaultX(mode, sets[0]?.id) })}
                options={[
                  { value: 'date', label: 'Dates' },
                  { value: 'elapsed', label: 'From day 1' },
                  { value: 'bucket', label: 'Grouped' },
                  { value: 'periods', label: 'By period' },
                ]}
              />
              <span className="hint">
                {xKind === 'date'
                  ? 'Real calendar dates.'
                  : xKind === 'elapsed'
                    ? 'Every series starts at day 1 — compare things that began at different times.'
                    : xKind === 'bucket'
                      ? 'One value per week, month, quarter or year.'
                      : 'One value per period, e.g. per place lived.'}
              </span>
            </div>
            {c.x.mode === 'bucket' && (
              <Segmented<Bucket>
                value={c.x.bucket}
                onChange={(bucket) => set({ x: { mode: 'bucket', bucket } })}
                options={[
                  { value: 'week', label: 'Week' },
                  { value: 'month', label: 'Month' },
                  { value: 'quarter', label: 'Quarter' },
                  { value: 'year', label: 'Year' },
                ]}
              />
            )}
            {c.x.mode === 'periods' &&
              (sets.length ? (
                <Select label="Period set" value={c.x.setId} onChange={(setId) => set({ x: { mode: 'periods', setId } })} options={sets.map((s) => ({ value: s.id, label: s.name }))} />
              ) : (
                <p className="small neg">Create a period set first.</p>
              ))}
          </Section>

          <Section title="Series" hint="A formula per line or bar">
            {c.series.map((s, i) => (
              <div key={s.id} className="series-block">
                <div className="spread">
                  <span className="series-index" style={{ background: s.color || theme.tokens.palette[i % theme.tokens.palette.length] }}>
                    {i + 1}
                  </span>
                  <div className="row" style={{ gap: 2 }}>
                    <button className="icon-btn" disabled={i === 0} onClick={() => set({ series: move(c.series, i, -1) })} aria-label="Move up">
                      <ArrowUp size={16} />
                    </button>
                    <button className="icon-btn" disabled={i === c.series.length - 1} onClick={() => set({ series: move(c.series, i, 1) })} aria-label="Move down">
                      <ArrowDown size={16} />
                    </button>
                    <button className="icon-btn" disabled={c.series.length === 1} onClick={() => set({ series: c.series.filter((_, j) => j !== i) })} aria-label="Remove">
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <ExprInput value={s.expr} onChange={(expr) => setSeries(i, { expr })} preview={false} />
                <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                  <div className="grow" style={{ minWidth: 150 }}>
                    <TextField label="Label" value={s.label ?? ''} onChange={(label) => setSeries(i, { label })} placeholder={s.expr || 'Series'} />
                  </div>
                  {categoryMode && (
                    <div className="grow" style={{ minWidth: 150 }}>
                      <Select label="Per period, take" value={s.reducer ?? (c.kind === 'waterfall' ? 'sum' : 'last')} onChange={(reducer) => setSeries(i, { reducer })} options={REDUCERS} />
                    </div>
                  )}
                  {categoryMode && c.kind !== 'waterfall' && c.kind !== 'candles' && i > 0 && (
                    <div className="field">
                      <span className="field-label">Axis</span>
                      <Segmented value={s.axis ?? 'left'} onChange={(axis) => setSeries(i, { axis })} options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} />
                    </div>
                  )}
                </div>
                {lineLike && !categoryMode && (
                  <div className="row wrap style-toggles">
                    {(
                      [
                        ['smooth', 'Smooth'],
                        ['step', 'Steps'],
                        ['area', 'Fill'],
                      ] as const
                    ).map(([k, label]) => (
                      <label key={k} className="row small" style={{ gap: 8 }}>
                        <Toggle checked={!!s.style?.[k]} onChange={(v) => setSeries(i, { style: { ...s.style, [k]: v } })} label={label} />
                        {label}
                      </label>
                    ))}
                    <Segmented
                      value={s.style?.line ?? 'solid'}
                      onChange={(line) => setSeries(i, { style: { ...s.style, line } })}
                      options={[
                        { value: 'solid', label: '—' },
                        { value: 'dashed', label: '- -' },
                        { value: 'dotted', label: '···' },
                      ]}
                    />
                    <Segmented
                      value={s.style?.points ?? 'auto'}
                      onChange={(points) => setSeries(i, { style: { ...s.style, points } })}
                      options={[
                        { value: 'none', label: 'No dots' },
                        { value: 'auto', label: 'Auto' },
                        { value: 'all', label: 'Dots' },
                      ]}
                    />
                  </div>
                )}
                <details className="series-color">
                  <summary className="small muted">Colour</summary>
                  <ColorPicker value={s.color} onChange={(color) => setSeries(i, { color })} allowNone />
                </details>
              </div>
            ))}
            {c.kind !== 'waterfall' && c.kind !== 'candles' && (
              <button className="btn block" onClick={() => set({ series: [...c.series, { id: sid(), expr: '' }] })}>
                <Plus size={16} /> Add series
              </button>
            )}
          </Section>

          <Section title="Periods">
            <Select
              label="Show"
              value={c.filter ? (c.filter.period === 'each' ? 'each' : c.filter.period === 'latest' ? 'latest' : 'one') : 'all'}
              onChange={(v) => {
                const setId = c.filter?.setId ?? sets[0]?.id;
                if (v === 'all' || !setId) set({ filter: null });
                else if (v === 'one') set({ filter: { setId, period: periods(vault, setId)[0]?.id ?? 'latest' } });
                else set({ filter: { setId, period: v } });
              }}
              options={[
                { value: 'all', label: 'All data' },
                { value: 'each', label: 'One small chart per period' },
                { value: 'latest', label: 'Only the latest period' },
                { value: 'one', label: 'One specific period' },
              ]}
            />
            {c.filter && sets.length > 0 && (
              <div className="row">
                <div className="grow">
                  <Select label="Period set" value={c.filter.setId} onChange={(setId) => set({ filter: { ...c.filter!, setId } })} options={sets.map((s) => ({ value: s.id, label: s.name }))} />
                </div>
                {c.filter.period !== 'each' && c.filter.period !== 'latest' && (
                  <div className="grow">
                    <Select
                      label="Period"
                      value={c.filter.period}
                      onChange={(period) => set({ filter: { ...c.filter!, period } })}
                      options={periods(vault, c.filter.setId).map((p) => ({ value: p.id, label: p.name }))}
                    />
                  </div>
                )}
              </div>
            )}
            {c.x.mode === 'date' && (
              <Select
                label="Shade periods behind the data"
                value={c.bands?.setId ?? ''}
                onChange={(setId) => set({ bands: setId ? { setId } : null })}
                options={[{ value: '', label: 'None' }, ...sets.map((s) => ({ value: s.id, label: s.name }))]}
              />
            )}
          </Section>

          <Section title="View">
            <div className="field">
              <span className="field-label">Opens showing</span>
              <Segmented<ViewPreset>
                value={c.view.preset}
                onChange={(preset) => set({ view: { ...c.view, preset } })}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'year', label: 'Year' },
                  { value: 'quarter', label: 'Quarter' },
                  { value: 'month', label: 'Month' },
                ]}
              />
            </div>
            <div className="field">
              <span className="field-label">A rise is…</span>
              <Segmented
                value={c.better === undefined ? 'auto' : (c.better ?? 'neutral')}
                onChange={(v) => set({ better: v === 'auto' ? undefined : v === 'neutral' ? null : (v as 'up' | 'down') })}
                options={[
                  { value: 'auto', label: 'From metric' },
                  { value: 'up', label: 'Good' },
                  { value: 'neutral', label: 'Neutral' },
                  { value: 'down', label: 'Bad' },
                ]}
              />
            </div>
            <div className="row">
              <NumberBox label="Axis from" value={c.view.yMin ?? null} onChange={(yMin) => set({ view: { ...c.view, yMin } })} />
              <NumberBox label="Axis to" value={c.view.yMax ?? null} onChange={(yMax) => set({ view: { ...c.view, yMax } })} />
            </div>
            <label className="row small" style={{ gap: 10 }}>
              <Toggle checked={!!c.view.yZero} onChange={(yZero) => set({ view: { ...c.view, yZero } })} label="Include zero" /> Always include zero
            </label>
            <div className="row">
              <div className="grow">
                <TextField label="Unit" value={c.unit ?? ''} onChange={(unit) => set({ unit })} placeholder="kg, €, %…" />
              </div>
              <div className="field">
                <span className="field-label">Decimals</span>
                <Segmented value={String(c.decimals ?? 1)} onChange={(d) => set({ decimals: Number(d) })} options={['0', '1', '2'].map((d) => ({ value: d, label: d }))} />
              </div>
            </div>
            <div className="field">
              <span className="field-label">Reference lines</span>
              {(c.refLines ?? []).map((r, i) => (
                <div key={i} className="row">
                  <NumberBox label="" value={r.value} onChange={(value) => set({ refLines: (c.refLines ?? []).map((x, j) => (j === i ? { ...x, value: value ?? 0 } : x)) })} />
                  <input className="input grow" placeholder="Label" value={r.label ?? ''} onChange={(e) => set({ refLines: (c.refLines ?? []).map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                  <button className="icon-btn" onClick={() => set({ refLines: (c.refLines ?? []).filter((_, j) => j !== i) })} aria-label="Remove line">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ refLines: [...(c.refLines ?? []), { value: 0 }] })}>
                <Plus size={14} /> Add line
              </button>
            </div>
          </Section>

          {dashList.length > 0 && (
            <Section title="Dashboards">
              {dashList.map((d) => (
                <label key={d.id} className="spread" style={{ minHeight: 40 }}>
                  <span>{d.name}</span>
                  <Toggle
                    checked={onDash.has(d.id)}
                    onChange={(v) => {
                      const next = new Set(onDash);
                      if (v) next.add(d.id);
                      else next.delete(d.id);
                      setOnDash(next);
                    }}
                    label={d.name}
                  />
                </label>
              ))}
            </Section>
          )}
        </div>
      </div>
      <SaveBar
        onSave={save}
        disabled={!c.series.some((s) => s.expr.trim())}
        saveLabel={isNew ? 'Create chart' : 'Save'}
        onDelete={
          original
            ? async () => {
                if (await confirm({ title: `Delete “${original.title}”?`, body: 'Only the chart is deleted; your data stays.', confirmLabel: 'Delete', danger: true })) {
                  deleteChart(vault, original.id);
                  navigate({ name: 'studio', section: 'charts' }, { replace: true });
                }
              }
            : undefined
        }
      />
    </StudioPage>
  );
}

function NumberBox({ label, value, onChange }: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  const [text, setText] = useState(value === null ? '' : String(value));
  return (
    <div className="field grow">
      {label && <label>{label}</label>}
      <input
        className="input"
        inputMode="decimal"
        placeholder="Auto"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseInput(e.target.value));
        }}
      />
    </div>
  );
}

function move<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const next = [...list];
  const j = i + dir;
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

function defaultX(mode: XAxisSpec['mode'], firstSet?: string): XAxisSpec {
  switch (mode) {
    case 'bucket':
      return { mode: 'bucket', bucket: 'month' };
    case 'periods':
      return { mode: 'periods', setId: firstSet ?? '' };
    case 'elapsed':
      return { mode: 'elapsed' };
    default:
      return { mode: 'date' };
  }
}

/** Picking a kind nudges the axis to something that makes sense for it. */
function adaptKind(c: ChartSpec, kind: ChartKind): Partial<ChartSpec> {
  if (kind === 'waterfall' || kind === 'candles') {
    return {
      kind,
      x: c.x.mode === 'bucket' ? c.x : { mode: 'bucket', bucket: 'month' },
      series: c.series.slice(0, 1).map((s) => ({ ...s, reducer: kind === 'waterfall' ? (s.reducer ?? 'sum') : s.reducer })),
    };
  }
  return { kind };
}
