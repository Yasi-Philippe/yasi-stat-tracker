import { CalendarDays, Check, ChevronRight, Flag, Minus, MoreHorizontal, Plus, Square, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSettings, useToday, useVault } from '@/app/hooks';
import { navigate } from '@/app/router';
import { deleteEntry, entries, getEntry, metrics, newId, openPeriod, periods, periodSets, savePeriod, setEntry } from '@/core/data/repo';
import { applyTemplate, TEMPLATES } from '@/core/data/templates';
import { type DayNum, fromDayNum, monthStart, toDayNum } from '@/core/model/dates';
import type { MetricDef, PeriodSet } from '@/core/model/types';
import { platform } from '@/platform';
import { MetricIcon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { Sparkline } from '../components/Sparkline';
import { toast } from '../components/Toast';
import { fmtDay, fmtNum, fmtValue, parseInput, relativeDay, splitNumber } from '../format';
import { PageHeader } from '../shell/AppShell';
import './today.css';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'night';
  if (h < 12) return 'morning';
  if (h < 19) return 'afternoon';
  return 'evening';
}

export function Today() {
  const { vault, version } = useVault();
  const today = useToday();
  const [day, setDay] = useState<DayNum>(today);
  const [pickDate, setPickDate] = useState(false);
  useEffect(() => setDay(today), [today]);

  const list = useMemo(() => metrics(vault), [vault, version]);
  const daily = list.filter((m) => m.cadence === 'daily' && !m.hideFromToday);
  const monthly = list.filter((m) => m.cadence === 'monthly' && !m.hideFromToday);
  const sparse = list.filter((m) => m.cadence === 'sparse' && !m.hideFromToday);
  const campaigns = useMemo(() => periodSets(vault).filter((s) => s.kind === 'campaign'), [vault, version]);

  const iso = fromDayNum(day);
  const doneCount = daily.filter((m) => getEntry(vault, m, iso)).length;

  if (!list.length) return <Onboarding />;

  return (
    <div className="today">
      <PageHeader
        eyebrow={fmtDay(today, 'long')}
        title={
          <>
            Good <em>{greeting()}</em>
          </>
        }
        actions={daily.length > 0 && <Progress done={doneCount} total={daily.length} />}
      />

      <div className="day-picker scroll-x" role="group" aria-label="Day to log">
        {[0, 1, 2].map((ago) => (
          <button key={ago} className="chip" aria-pressed={day === today - ago} onClick={() => setDay(today - ago)}>
            {relativeDay(today - ago, today)}
          </button>
        ))}
        <button className="chip" aria-pressed={day < today - 2} onClick={() => setPickDate(true)}>
          <CalendarDays size={14} /> {day < today - 2 ? fmtDay(day, 'short') : 'Other day'}
        </button>
      </div>

      {daily.length > 0 && (
        <section className="cards">
          {daily.map((m, i) => (
            <MetricCard key={m.id} metric={m} day={day} today={today} index={i} />
          ))}
        </section>
      )}

      {campaigns.map((s) => (
        <CampaignCard key={s.id} set={s} today={today} />
      ))}

      {monthly.length > 0 && (
        <section className="stack-12" style={{ marginTop: 28 }}>
          <div className="section-title">
            <span className="eyebrow">This month · {fmtDay(monthStart(day), 'month')}</span>
          </div>
          <div className="cards">
            {monthly.map((m, i) => (
              <MetricCard key={m.id} metric={m} day={monthStart(day)} today={today} index={i} />
            ))}
          </div>
        </section>
      )}

      {sparse.length > 0 && (
        <section className="stack-12" style={{ marginTop: 28 }}>
          <div className="section-title">
            <span className="eyebrow">Occasional</span>
          </div>
          <div className="cards">
            {sparse.map((m, i) => (
              <MetricCard key={m.id} metric={m} day={day} today={today} index={i} />
            ))}
          </div>
        </section>
      )}

      <Sheet open={pickDate} onClose={() => setPickDate(false)} title="Log for another day">
        <div className="stack-16">
          <input
            type="date"
            className="input"
            max={fromDayNum(today)}
            defaultValue={fromDayNum(day)}
            onChange={(e) => {
              if (e.target.value) {
                setDay(Math.min(toDayNum(e.target.value), today));
                setPickDate(false);
              }
            }}
          />
          <MissedDays metrics={daily} today={today} onPick={(d) => (setDay(d), setPickDate(false))} />
        </div>
      </Sheet>
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const r = 19;
  const c = 2 * Math.PI * r;
  const frac = total ? done / total : 0;
  return (
    <div className="progress" title={`${done} of ${total} logged`}>
      <svg width="50" height="50" viewBox="0 0 50 50">
        <circle cx="25" cy="25" r={r} fill="none" stroke="var(--line)" strokeWidth="5" />
        <circle
          cx="25"
          cy="25"
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          transform="rotate(-90 25 25)"
          style={{ transition: 'stroke-dashoffset 0.6s var(--ease)' }}
        />
      </svg>
      <span className="progress-label num">
        {done === total ? <Check size={16} /> : `${done}/${total}`}
      </span>
    </div>
  );
}

function MissedDays({ metrics: list, today, onPick }: { metrics: MetricDef[]; today: DayNum; onPick: (d: DayNum) => void }) {
  const { vault } = useVault();
  const missed: DayNum[] = [];
  for (let d = today - 1; d >= today - 14 && missed.length < 8; d--) {
    const iso = fromDayNum(d);
    if (list.some((m) => !getEntry(vault, m, iso))) missed.push(d);
  }
  if (!missed.length) return <p className="small muted">Nothing missing in the last two weeks. Nice.</p>;
  return (
    <div className="stack-8">
      <div className="eyebrow">Missing in the last two weeks</div>
      <div className="row wrap">
        {missed.map((d) => (
          <button key={d} className="chip" onClick={() => onPick(d)}>
            {relativeDay(d, today)}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function MetricCard({ metric: m, day, today, index }: { metric: MetricDef; day: DayNum; today: DayNum; index: number }) {
  const { vault, version } = useVault();
  const settings = useSettings();
  const iso = fromDayNum(day);
  const current = getEntry(vault, m, iso);
  const all = useMemo(() => entries(vault, m.id), [vault, version, m.id]);
  const previous = useMemo(() => {
    for (let i = all.length - 1; i >= 0; i--) if (all[i]!.date < iso) return all[i];
    return undefined;
  }, [all, iso]);
  const seed = current?.value ?? previous?.value ?? null;
  const [draft, setDraft] = useState(() => (seed === null ? '' : toPlain(seed, m.decimals)));
  const [menu, setMenu] = useState(false);
  const [revealed, setRevealed] = useState(!settings.discreet);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the draft when the day or the stored value changes.
  useEffect(() => {
    const v = current?.value ?? previous?.value ?? null;
    setDraft(v === null ? '' : toPlain(v, m.decimals));
  }, [iso, current?.value, previous?.value, m.decimals]);

  const parsed = parseInput(draft);
  // Long numbers (balances) shrink so they never collide with the steppers.
  const digits = Math.max(draft.length, 3);
  const valueSize = digits <= 4 ? 66 : digits <= 5 ? 60 : digits <= 6 ? 54 : digits <= 7 ? 46 : digits <= 8 ? 40 : 34;
  const outOfRange = parsed !== null && ((m.min != null && parsed < m.min) || (m.max != null && parsed > m.max));
  const dirty = parsed !== null && (current === undefined || Math.abs(parsed - current.value) > 1e-9);
  const delta = current && previous ? current.value - previous.value : parsed !== null && previous && dirty ? parsed - previous.value : null;
  const prevLabel = previous ? (m.cadence === 'monthly' ? fmtDay(previous.date, 'month') : relativeDay(toDayNum(previous.date), today).toLowerCase()) : '';
  const good = delta === null || !m.better || Math.abs(delta) < 1e-9 ? null : (delta > 0) === (m.better === 'up');

  const spark = useMemo<Array<[number, number]>>(() => {
    const from = toDayNum(iso) - (m.cadence === 'monthly' ? 400 : 45);
    return all.filter((e) => e.date <= iso && toDayNum(e.date) >= from).map((e) => [toDayNum(e.date), e.value]);
  }, [all, iso, m.cadence]);

  const step = (dir: 1 | -1) => {
    const base = parsed ?? previous?.value ?? 0;
    const next = Math.round((base + dir * m.step) * 10 ** m.decimals) / 10 ** m.decimals;
    setDraft(toPlain(next, m.decimals));
    platform().haptic('light');
  };

  const save = () => {
    if (parsed === null || outOfRange) return;
    setEntry(vault, m, iso, parsed);
    platform().haptic('success');
    const d = previous ? parsed - previous.value : null;
    toast(`${m.name} logged${d !== null && Math.abs(d) > 1e-9 ? ` · ${fmtValue(d, m.unit, m.decimals, { sign: true })}` : ''}`);
    inputRef.current?.blur();
  };

  const clear = () => {
    deleteEntry(vault, m, iso);
    setMenu(false);
    toast(`Cleared ${m.name.toLowerCase()} for ${relativeDay(day, today).toLowerCase()}`, {
      action: { label: 'Undo', run: () => current && setEntry(vault, m, iso, current.value, current.note) },
    });
  };

  const label =
    m.cadence === 'monthly' ? fmtDay(day, 'month') : m.cadence === 'sparse' && previous && !current ? `Last: ${fmtDay(previous.date, 'medium')}` : relativeDay(day, today);

  return (
    <article className={`mcard${current ? ' logged' : ''}`} style={{ animationDelay: `${index * 40}ms`, '--mc': m.color || 'var(--accent)' } as React.CSSProperties}>
      <header className="mcard-head">
        <button className="mcard-title" onClick={() => navigate({ name: 'metric', id: m.id })}>
          <span className="mcard-icon">
            <MetricIcon name={m.icon} size={16} />
          </span>
          <span className="grow">
            <span className="mcard-name">{m.name}</span>
            <span className="mcard-when">{label}</span>
          </span>
          <ChevronRight size={16} className="faint" />
        </button>
        <button className="icon-btn" onClick={() => setMenu(true)} aria-label={`${m.name} options`}>
          <MoreHorizontal size={18} />
        </button>
      </header>

      <div className="mcard-body">
        <button className="step-btn" onClick={() => step(-1)} aria-label={`Decrease by ${m.step}`}>
          <Minus size={20} />
        </button>
        <label className={`mcard-value${!revealed ? ' blurred' : ''}`} onClick={() => setRevealed(true)}>
          <input
            ref={inputRef}
            className="display"
            value={draft}
            inputMode="decimal"
            enterKeyHint="done"
            aria-label={`${m.name} value`}
            placeholder={previous ? toPlain(previous.value, m.decimals) : '0'}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            size={Math.max(3, draft.length + 1)}
            style={{ fontSize: `min(${valueSize}px, ${(valueSize / 390) * 100 * 0.98}vw)` }}
          />
          <span className="mcard-unit">{m.unit}</span>
        </label>
        <button className="step-btn" onClick={() => step(1)} aria-label={`Increase by ${m.step}`}>
          <Plus size={20} />
        </button>
      </div>

      {spark.length > 2 && (
        <div className="mcard-trend" aria-hidden>
          <Sparkline points={spark} height={28} width={300} color={m.color || 'var(--accent)'} dot strokeWidth={1.6} />
        </div>
      )}

      <footer className="mcard-foot">
        <span className={`mcard-delta${good === true ? ' pos' : good === false ? ' neg' : ''}`}>
          {outOfRange ? (
            <span className="neg">Outside the allowed range</span>
          ) : delta !== null && previous ? (
            <>
              {fmtValue(delta, m.unit, m.decimals, { sign: true })} <span className="faint">vs {prevLabel}</span>
            </>
          ) : previous ? (
            <span className="faint">
              Last: {fmtValue(previous.value, m.unit, m.decimals)} · {prevLabel}
            </span>
          ) : (
            <span className="faint">First entry</span>
          )}
        </span>
        <button className={`btn ${current && !dirty ? 'logged-btn' : 'primary'}`} disabled={parsed === null || outOfRange || (!!current && !dirty)} onClick={save}>
          {current && !dirty ? (
            <>
              <Check size={17} /> Logged
            </>
          ) : current ? (
            'Update'
          ) : (
            'Log'
          )}
        </button>
      </footer>

      <Sheet open={menu} onClose={() => setMenu(false)} title={m.name}>
        <div className="list card flat">
          <button className="list-row" onClick={() => navigate({ name: 'metric', id: m.id })}>
            <span className="grow title">History and corrections</span>
            <ChevronRight size={16} />
          </button>
          <button className="list-row" onClick={() => navigate({ name: 'studio', section: 'metrics', id: m.id })}>
            <span className="grow title">Edit this metric</span>
            <ChevronRight size={16} />
          </button>
          {current && (
            <button className="list-row" onClick={clear}>
              <Trash2 size={16} className="neg" />
              <span className="grow title neg">Clear {relativeDay(day, today).toLowerCase()}'s value</span>
            </button>
          )}
        </div>
      </Sheet>
    </article>
  );
}

function toPlain(v: number, decimals: number): string {
  const s = fmtNum(v, decimals).replace(/−/g, '-');
  // Keep the locale decimal separator but drop thousands separators.
  const { int, frac } = splitNumber(s);
  return int.replace(/[^\d-]/g, '') + frac;
}

// ---------------------------------------------------------------------------

function CampaignCard({ set, today }: { set: PeriodSet; today: DayNum }) {
  const { vault, version } = useVault();
  const open = useMemo(() => openPeriod(vault, set.id), [vault, version, set.id]);
  const count = useMemo(() => periods(vault, set.id).length, [vault, version, set.id]);
  const [starting, setStarting] = useState(false);
  const [name, setName] = useState('');
  const [start, setStart] = useState(fromDayNum(today));

  const days = open ? today - toDayNum(open.start) + 1 : 0;
  return (
    <section className={`campaign card${open ? ' running' : ''}`}>
      <div className="campaign-icon">
        <Flag size={18} />
      </div>
      <div className="grow">
        <div className="eyebrow">{set.name}</div>
        {open ? (
          <div className="campaign-title">
            <b>{open.name}</b> <span className="muted">· day {days}</span>
          </div>
        ) : (
          <div className="campaign-title muted">Nothing running</div>
        )}
      </div>
      {open ? (
        <button
          className="btn sm"
          onClick={() => {
            savePeriod(vault, { ...open, end: fromDayNum(Math.max(today, toDayNum(open.start))) });
            toast(`${open.name} finished after ${days} days`);
          }}
        >
          <Square size={13} /> Stop
        </button>
      ) : (
        <button
          className="btn sm primary"
          onClick={() => {
            setName(`${set.name.replace(/s$/, '')} ${count + 1}`);
            setStart(fromDayNum(today));
            setStarting(true);
          }}
        >
          Start
        </button>
      )}
      <Sheet open={starting} onClose={() => setStarting(false)} title={`Start: ${set.name}`}>
        <div className="stack-16">
          <div className="field">
            <label>Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label>Starting</label>
            <input className="input" type="date" value={start} max={fromDayNum(today)} onChange={(e) => setStart(e.target.value)} />
          </div>
          <button
            className="btn primary lg block"
            disabled={!name.trim() || !start}
            onClick={() => {
              savePeriod(vault, { id: newId(), setId: set.id, name: name.trim(), start, end: null });
              setStarting(false);
              toast(`${name.trim()} started`);
            }}
          >
            Start now
          </button>
        </div>
      </Sheet>
    </section>
  );
}

// ---------------------------------------------------------------------------

function Onboarding() {
  const { vault } = useVault();
  const [picked, setPicked] = useState<Set<string>>(new Set(['body']));
  return (
    <div className="onboarding">
      <PageHeader
        eyebrow="Your sandbox is empty"
        title={
          <>
            What will you <em>track?</em>
          </>
        }
        sub="Pick starter packs — every metric, formula and chart they create is yours to edit, rename or delete."
      />
      <div className="template-grid">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            className="template card"
            aria-pressed={picked.has(t.id)}
            onClick={() => {
              const next = new Set(picked);
              if (next.has(t.id)) next.delete(t.id);
              else next.add(t.id);
              setPicked(next);
            }}
          >
            <span className="template-icon">
              <MetricIcon name={t.icon} size={22} />
            </span>
            <span className="template-name">{t.name}</span>
            <span className="small muted">{t.description}</span>
            <span className="template-check">
              <Check size={14} />
            </span>
          </button>
        ))}
      </div>
      <div className="row wrap" style={{ marginTop: 20 }}>
        <button
          className="btn primary lg"
          disabled={!picked.size}
          onClick={() => {
            for (const id of TEMPLATES.map((t) => t.id)) if (picked.has(id)) applyTemplate(vault, id);
            toast('Your sandbox is ready');
          }}
        >
          Add {picked.size || ''} {picked.size === 1 ? 'pack' : 'packs'}
        </button>
        <button className="btn ghost lg" onClick={() => navigate({ name: 'studio', section: 'metrics', id: 'new' })}>
          Start from scratch
        </button>
      </div>
    </div>
  );
}
