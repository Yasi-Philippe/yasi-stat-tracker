import { ArrowLeft, MessageSquare, PencilLine, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTheme, useToday, useVault } from '@/app/hooks';
import { back, navigate } from '@/app/router';
import { deleteEntry, entries, getEntry, metric as getMetric, setEntry } from '@/core/data/repo';
import { type DayNum, fromDayNum, toDayNum, weekStart } from '@/core/model/dates';
import type { ChartSpec, Entry, MetricDef } from '@/core/model/types';
import { ChartBody } from '../charts/ChartCard';
import { useChartData } from '../charts/useChart';
import { confirm } from '../components/Controls';
import { MetricIcon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { toast } from '../components/Toast';
import { fmtDay, fmtValue, parseInput, relativeDay } from '../format';
import './metric.css';

export function MetricScreen({ id }: { id: string }) {
  const { vault, version } = useVault();
  const m = useMemo(() => getMetric(vault, id), [vault, version, id]);
  if (!m) {
    return (
      <div className="empty card">
        <h3>Metric not found</h3>
        <button className="btn" onClick={() => navigate({ name: 'today' })}>
          Back
        </button>
      </div>
    );
  }
  return <MetricView m={m} />;
}

function MetricView({ m }: { m: MetricDef }) {
  const { vault, version } = useVault();
  const today = useToday();
  const theme = useTheme();
  const list = useMemo(() => entries(vault, m.id), [vault, version, m.id]);
  const [editing, setEditing] = useState<{ date: string; value: string; note: string; isNew: boolean } | null>(null);
  const [shown, setShown] = useState(60);

  const spec = useMemo<ChartSpec>(
    () => ({
      id: `metric-${m.id}`,
      title: m.name,
      kind: 'area',
      x: { mode: 'date' },
      series: [{ id: 's', expr: m.slug, label: m.name, color: m.color }],
      view: { preset: 'all' },
      unit: m.unit,
      decimals: m.decimals,
    }),
    [m],
  );
  const { data } = useChartData(spec);

  const latest = list[list.length - 1];
  const streak = useMemo(() => {
    if (m.cadence !== 'daily') return 0;
    const days = new Set(list.map((e) => e.date));
    let n = 0;
    let d = days.has(fromDayNum(today)) ? today : today - 1;
    while (days.has(fromDayNum(d))) {
      n++;
      d--;
    }
    return n;
  }, [list, today, m.cadence]);

  const rows = useMemo(() => {
    const out: Array<{ e: Entry; delta: number | null }> = [];
    for (let i = list.length - 1; i >= 0 && out.length < shown; i--) {
      const e = list[i]!;
      out.push({ e, delta: i > 0 ? e.value - list[i - 1]!.value : null });
    }
    return out;
  }, [list, shown]);

  const openEdit = (date: string) => {
    const e = getEntry(vault, m, date);
    setEditing({ date, value: e ? String(e.value) : '', note: e?.note ?? '', isNew: !e });
  };

  return (
    <div className="metric-screen">
      <div className="chart-top">
        <button className="icon-btn" onClick={() => back()} aria-label="Back">
          <ArrowLeft size={20} />
        </button>
        <button className="icon-btn" onClick={() => navigate({ name: 'studio', section: 'metrics', id: m.id })} title="Edit metric">
          <PencilLine size={18} />
        </button>
      </div>
      <header className="metric-head">
        <span className="metric-badge" style={{ color: m.color || 'var(--accent)' }}>
          <MetricIcon name={m.icon} size={22} />
        </span>
        <div>
          <h1 className="display page-title">{m.name}</h1>
          <p className="muted small">
            {list.length} entries{list[0] ? ` since ${fmtDay(list[0].date, 'medium')}` : ''}
            {streak > 1 ? ` · ${streak}-day streak` : ''}
          </p>
        </div>
      </header>

      {latest && (
        <div className="metric-latest">
          <span className="display">{fmtValue(latest.value, m.unit, m.decimals)}</span>
          <span className="muted small">{relativeDay(toDayNum(latest.date), today)}</span>
        </div>
      )}

      <div className="card chart-stage" style={{ marginBottom: 16 }}>
        <ChartBody data={data} spec={spec} theme={theme.tokens} height={200} />
      </div>

      {m.cadence === 'daily' && <Heatmap list={list} today={today} onPick={(d) => openEdit(fromDayNum(d))} color={m.color || undefined} />}

      <div className="spread" style={{ margin: '22px 0 10px' }}>
        <h2 className="eyebrow">All entries</h2>
        <button className="btn sm" onClick={() => setEditing({ date: fromDayNum(today), value: '', note: '', isNew: true })}>
          <Plus size={15} /> Add
        </button>
      </div>
      <div className="card list">
        {rows.length === 0 && <div className="empty small">Nothing logged yet.</div>}
        {rows.map(({ e, delta }) => {
          const good = delta === null || !m.better || Math.abs(delta) < 1e-9 ? null : (delta > 0) === (m.better === 'up');
          return (
            <button key={e.date} className="list-row" onClick={() => openEdit(e.date)}>
              <div className="grow">
                <div className="title">{fmtDay(e.date, 'medium')}</div>
                <div className="sub">
                  {fmtDay(e.date, 'weekday')}
                  {e.note && (
                    <>
                      {' '}
                      · <MessageSquare size={11} /> {e.note}
                    </>
                  )}
                </div>
              </div>
              <div className="trail">
                {delta !== null && Math.abs(delta) > 1e-9 && (
                  <span className={`small ${good === true ? 'pos' : good === false ? 'neg' : 'muted'}`}>{fmtValue(delta, '', m.decimals, { sign: true })}</span>
                )}
                <b className="num" style={{ color: 'var(--text)' }}>
                  {fmtValue(e.value, m.unit, m.decimals)}
                </b>
              </div>
            </button>
          );
        })}
        {list.length > shown && (
          <button className="list-row" onClick={() => setShown(shown + 120)}>
            <span className="grow center-text muted small">Show more ({list.length - shown} older)</span>
          </button>
        )}
      </div>

      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing?.isNew ? 'Add an entry' : 'Edit entry'}>
        {editing && (
          <div className="stack-16">
            <div className="field">
              <label>Date</label>
              <input className="input" type="date" value={editing.date} max={fromDayNum(today)} disabled={!editing.isNew} onChange={(e) => setEditing({ ...editing, date: e.target.value })} />
            </div>
            <div className="field">
              <label>Value ({m.unit})</label>
              <input className="input display" style={{ fontSize: 30, minHeight: 60, fontStyle: 'italic' }} inputMode="decimal" autoFocus value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
            </div>
            <div className="field">
              <label>Note (optional)</label>
              <input className="input" value={editing.note} maxLength={200} onChange={(e) => setEditing({ ...editing, note: e.target.value })} placeholder="e.g. after holidays" />
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              {!editing.isNew ? (
                <button
                  className="btn danger"
                  onClick={async () => {
                    if (await confirm({ title: 'Delete this entry?', confirmLabel: 'Delete', danger: true })) {
                      deleteEntry(vault, m, editing.date);
                      setEditing(null);
                      toast('Entry deleted');
                    }
                  }}
                >
                  <Trash2 size={16} /> Delete
                </button>
              ) : (
                <span />
              )}
              <button
                className="btn primary"
                disabled={parseInput(editing.value) === null || !editing.date}
                onClick={() => {
                  setEntry(vault, m, editing.date, parseInput(editing.value)!, editing.note.trim() || undefined);
                  setEditing(null);
                  toast('Saved');
                }}
              >
                Save
              </button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}

function Heatmap({ list, today, onPick, color }: { list: Entry[]; today: DayNum; onPick: (d: DayNum) => void; color?: string }) {
  const weeks = 26;
  const start = weekStart(today) - (weeks - 1) * 7;
  const have = useMemo(() => new Set(list.map((e) => e.date)), [list]);
  const cols: DayNum[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: DayNum[] = [];
    for (let d = 0; d < 7; d++) col.push(start + w * 7 + d);
    cols.push(col);
  }
  const logged = cols.flat().filter((d) => d <= today && have.has(fromDayNum(d))).length;
  const total = today - start + 1;
  return (
    <section className="card pad heat-card">
      <div className="spread" style={{ marginBottom: 10 }}>
        <span className="eyebrow">Consistency · 6 months</span>
        <span className="small muted">{Math.round((logged / total) * 100)}% of days</span>
      </div>
      <div className="heatmap" style={{ '--hc': color || 'var(--accent)' } as React.CSSProperties}>
        {cols.map((col, i) => (
          <div key={i} className="heat-col">
            {col.map((d) => (
              <button
                key={d}
                className={`heat-cell${d > today ? ' future' : have.has(fromDayNum(d)) ? ' on' : ''}${d === today ? ' today' : ''}`}
                disabled={d > today}
                title={fmtDay(d, 'medium')}
                onClick={() => onPick(d)}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
