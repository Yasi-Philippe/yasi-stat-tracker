import { AlertTriangle, Archive, Bell, ChevronRight, GitMerge } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useVault } from '@/app/hooks';
import { navigate } from '@/app/router';
import { session } from '@/app/session';
import { duplicateSlugs, mergeMetricInto, renameSlugEverywhere, slugProblem, slugUsages } from '@/core/data/refs';
import { deleteMetric, entries, metric as getMetric, metrics, newId, nextOrder, saveMetric, slugify, usedSlugs } from '@/core/data/repo';
import type { Cadence, MetricDef } from '@/core/model/types';
import { platform } from '@/platform';
import { ColorPicker, confirm, Segmented, TextField, ToggleRow } from '../components/Controls';
import { METRIC_ICONS, MetricIcon } from '../components/Icon';
import { toast } from '../components/Toast';
import { parseInput } from '../format';
import { AddButton, SaveBar, Section, StudioPage } from './common';

export function MetricsSection({ id }: { id?: string }) {
  if (id) return <MetricEditor id={id} />;
  return <MetricList />;
}

function MetricList() {
  const { vault, version } = useVault();
  const list = useMemo(() => metrics(vault, { includeArchived: true }), [vault, version]);
  const groups = useMemo(() => {
    const map = new Map<string, MetricDef[]>();
    for (const m of list) {
      const g = m.archived ? 'Archived' : m.group || 'Other';
      map.set(g, [...(map.get(g) ?? []), m]);
    }
    return [...map.entries()].sort((a, b) => (a[0] === 'Archived' ? 1 : b[0] === 'Archived' ? -1 : 0));
  }, [list]);
  const dupes = useMemo(() => duplicateSlugs(vault), [vault, version]);
  return (
    <StudioPage title={<em>Metrics</em>} actions={<AddButton label="New metric" onClick={() => navigate({ name: 'studio', section: 'metrics', id: 'new' })} />}>
      {dupes.length > 0 && (
        <div className="callout warn" style={{ marginBottom: 14 }}>
          <AlertTriangle size={18} />
          <span>
            Two items share the formula name <b>{dupes.join(', ')}</b> (this can happen after merging data from two devices). Open one and use{' '}
            <b>Merge into…</b>, or rename it.
          </span>
        </div>
      )}
      {list.length === 0 && (
        <div className="empty card">
          <h3>No metrics yet</h3>
          <p className="small">A metric is anything you write down: weight, a balance, hours of sleep…</p>
        </div>
      )}
      {groups.map(([g, ms]) => (
        <section key={g} className="studio-section">
          <h2 className="eyebrow studio-section-head">{g}</h2>
          <div className="card list">
            {ms.map((m) => (
              <button key={m.id} className="list-row" onClick={() => navigate({ name: 'studio', section: 'metrics', id: m.id })}>
                <span className="badge" style={{ color: m.color || 'var(--accent)' }}>
                  <MetricIcon name={m.icon} />
                </span>
                <span className="grow">
                  <span className="title">{m.name}</span>
                  <span className="sub">
                    <code className="num">{m.slug}</code> · {m.unit || 'no unit'} · {cadenceLabel(m.cadence)}
                    {m.fill === 'step' ? ' · holds' : ''}
                  </span>
                </span>
                <span className="trail">
                  {m.reminder?.enabled && <Bell size={14} />}
                  {m.archived && <Archive size={14} />}
                  <ChevronRight size={16} />
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </StudioPage>
  );
}

function MergeInto({ from }: { from: MetricDef }) {
  const { vault } = useVault();
  const others = useMemo(() => metrics(vault, { includeArchived: true }).filter((x) => x.id !== from.id), [vault, from.id]);
  const [target, setTarget] = useState('');
  if (!others.length) return null;
  return (
    <div className="field">
      <span className="field-label">Merge into another metric</span>
      <div className="row">
        <select className="select grow" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose…</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} ({o.slug})
            </option>
          ))}
        </select>
        <button
          className="btn"
          disabled={!target}
          onClick={async () => {
            const into = others.find((o) => o.id === target)!;
            const ok = await confirm({
              title: `Merge ${from.name} into ${into.name}?`,
              body: `Its entries move to ${into.name}; on days that already have a value, ${into.name}'s value is kept. Then ${from.name} is deleted.`,
              confirmLabel: 'Merge',
            });
            if (!ok) return;
            const r = mergeMetricInto(vault, from.id, into.id);
            toast(`Moved ${r.moved} entries${r.kept ? `, kept ${r.kept} existing` : ''}`);
            navigate({ name: 'studio', section: 'metrics' }, { replace: true });
          }}
        >
          <GitMerge size={15} /> Merge
        </button>
      </div>
      <span className="hint">Useful when the same thing ended up tracked twice.</span>
    </div>
  );
}

function cadenceLabel(c: Cadence): string {
  return c === 'daily' ? 'daily' : c === 'monthly' ? 'monthly' : 'occasional';
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function blankMetric(order: number): MetricDef {
  return {
    id: newId(),
    slug: '',
    name: '',
    unit: '',
    cadence: 'daily',
    fill: 'none',
    decimals: 1,
    step: 0.1,
    order,
    better: null,
    reminder: { enabled: false, time: '08:00' },
  };
}

function MetricEditor({ id }: { id: string }) {
  const { vault } = useVault();
  const isNew = id === 'new';
  const original = useMemo(() => (isNew ? undefined : getMetric(vault, id)), [vault, id, isNew]);
  const [m, setM] = useState<MetricDef>(() => original ?? blankMetric(nextOrder(metrics(vault, { includeArchived: true }))));
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const [step, setStep] = useState(String(m.step));
  const [min, setMin] = useState(m.min == null ? '' : String(m.min));
  const [max, setMax] = useState(m.max == null ? '' : String(m.max));
  const used = useMemo(() => usedSlugs(vault, original?.id), [vault, original?.id]);
  const set = (patch: Partial<MetricDef>) => setM((prev) => ({ ...prev, ...patch }));
  const slug = slugTouched ? m.slug : slugify(m.name || 'metric');
  const slugErr = m.name ? slugProblem(slug, used) : null;
  const entryCount = useMemo(() => (original ? entries(vault, original.id).length : 0), [vault, original]);

  if (!isNew && !original) {
    return (
      <StudioPage title="Not found" back={{ section: 'metrics' }}>
        <p className="muted">This metric no longer exists.</p>
      </StudioPage>
    );
  }

  const save = async () => {
    const next: MetricDef = {
      ...m,
      slug,
      name: m.name.trim(),
      unit: m.unit.trim(),
      step: parseInput(step) ?? 1,
      min: parseInput(min),
      max: parseInput(max),
    };
    if (original && original.slug !== slug) {
      const usages = slugUsages(vault, original.slug);
      if (usages.length && !(await confirm({ title: 'Rename everywhere?', body: `“${original.slug}” is used by ${usages.length} formula(s)/chart(s). They will be updated to “${slug}”.`, confirmLabel: 'Rename' }))) return;
      renameSlugEverywhere(vault, original.slug, slug);
    }
    if (next.reminder?.enabled && (!original?.reminder?.enabled || original.reminder.time !== next.reminder.time)) {
      const notifier = platform().notifier;
      if (!notifier.canSchedule) toast('Reminders work in the Android app; saved anyway.');
      else if ((await notifier.permission()) !== 'granted' && !(await notifier.requestPermission())) toast('Notifications are blocked in system settings.', { kind: 'error' });
    }
    saveMetric(vault, next);
    void session.scheduleReminders();
    toast(isNew ? `${next.name} created` : 'Saved');
    navigate({ name: 'studio', section: 'metrics' }, { replace: true });
  };

  const remove = async () => {
    if (!original) return;
    const usages = slugUsages(vault, original.slug);
    const ok = await confirm({
      title: `Delete ${original.name}?`,
      body: (
        <>
          This deletes the metric and its {entryCount} entries on every device.
          {usages.length > 0 && <> It is used by: {usages.map((u) => u.name).join(', ')}.</>} Consider archiving instead.
        </>
      ),
      confirmLabel: 'Delete forever',
      danger: true,
      typeToConfirm: entryCount > 0 ? 'DELETE' : undefined,
    });
    if (!ok) return;
    deleteMetric(vault, original.id);
    toast(`${original.name} deleted`);
    navigate({ name: 'studio', section: 'metrics' }, { replace: true });
  };

  const reminder = m.reminder ?? { enabled: false, time: '08:00' };

  return (
    <StudioPage title={isNew ? <em>New metric</em> : <em>{original!.name}</em>} back={{ section: 'metrics' }} eyebrow="Metric">
      <div className="studio-form">
        <Section title="Basics">
          <TextField label="Name" value={m.name} onChange={(name) => set({ name })} placeholder="e.g. Weight" autoFocus={isNew} />
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div className="grow">
              <TextField label="Unit" value={m.unit} onChange={(unit) => set({ unit })} placeholder="kg, €, h, steps…" />
            </div>
            <div className="grow">
              <TextField
                label="Name in formulas"
                value={slug}
                mono
                onChange={(v) => {
                  setSlugTouched(true);
                  set({ slug: v.toLowerCase().replace(/[^a-z0-9_]/g, '_') });
                }}
                error={slugErr ?? undefined}
              />
            </div>
          </div>
          <div className="field">
            <span className="field-label">How often</span>
            <Segmented<Cadence>
              block
              value={m.cadence}
              onChange={(cadence) => set({ cadence, fill: cadence === 'sparse' ? 'step' : m.fill, hideFromToday: cadence === 'sparse' ? true : m.hideFromToday })}
              options={[
                { value: 'daily', label: 'Daily' },
                { value: 'monthly', label: 'Monthly' },
                { value: 'sparse', label: 'Occasional' },
              ]}
            />
            <span className="hint">
              {m.cadence === 'daily'
                ? 'One value per day.'
                : m.cadence === 'monthly'
                  ? 'One value per month, like a monthly total.'
                  : 'Changes now and then, like your height or a monthly budget.'}
            </span>
          </div>
          <ToggleRow
            title="Holds its value between entries"
            sub="For balances and parameters: the last value stays true until the next one. Off for things like weight, where a missing day is just missing."
            checked={m.fill === 'step'}
            onChange={(v) => set({ fill: v ? 'step' : 'none' })}
          />
        </Section>

        <Section title="Numbers">
          <div className="field">
            <span className="field-label">Decimals</span>
            <Segmented
              value={String(m.decimals)}
              onChange={(d) => {
                const decimals = Number(d);
                set({ decimals });
                if (!slugTouched || isNew) setStep(String(decimals ? 10 ** -decimals : 1));
              }}
              options={['0', '1', '2', '3'].map((d) => ({ value: d, label: d }))}
            />
          </div>
          <div className="row">
            <div className="field grow">
              <label>+/− step</label>
              <input className="input" inputMode="decimal" value={step} onChange={(e) => setStep(e.target.value)} />
            </div>
            <div className="field grow">
              <label>Minimum</label>
              <input className="input" inputMode="decimal" placeholder="None" value={min} onChange={(e) => setMin(e.target.value)} />
            </div>
            <div className="field grow">
              <label>Maximum</label>
              <input className="input" inputMode="decimal" placeholder="None" value={max} onChange={(e) => setMax(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <span className="field-label">A rise is…</span>
            <Segmented
              value={m.better ?? 'neutral'}
              onChange={(v) => set({ better: v === 'neutral' ? null : (v as 'up' | 'down') })}
              options={[
                { value: 'up', label: 'Good' },
                { value: 'neutral', label: 'Neutral' },
                { value: 'down', label: 'Bad' },
              ]}
            />
            <span className="hint">Colours changes green or red.</span>
          </div>
        </Section>

        <Section title="Look">
          <TextField label="Group" value={m.group ?? ''} onChange={(group) => set({ group })} placeholder="e.g. Body, Money" />
          <div className="field">
            <span className="field-label">Icon</span>
            <div className="icon-grid">
              {Object.keys(METRIC_ICONS).map((name) => (
                <button key={name} type="button" aria-pressed={m.icon === name} onClick={() => set({ icon: name })} title={name}>
                  <MetricIcon name={name} size={18} />
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">Colour</span>
            <ColorPicker value={m.color} onChange={(color) => set({ color })} allowNone />
          </div>
          <ToggleRow title="Show on Today" sub="Off for parameters you only update now and then." checked={!m.hideFromToday} onChange={(v) => set({ hideFromToday: !v })} />
        </Section>

        {m.cadence === 'daily' && (
          <Section title="Reminder" hint={platform().notifier.canSchedule ? undefined : 'Android app only'}>
            <ToggleRow
              title="Remind me if I forget"
              sub="Skipped automatically on days you've already logged it."
              checked={reminder.enabled}
              onChange={(enabled) => set({ reminder: { ...reminder, enabled } })}
            />
            {reminder.enabled && (
              <div className="row wrap">
                <input className="input" type="time" style={{ width: 130 }} value={reminder.time} onChange={(e) => set({ reminder: { ...reminder, time: e.target.value } })} />
                <div className="row" style={{ gap: 4 }}>
                  {WEEKDAYS.map((d, i) => {
                    const on = !reminder.weekdays?.length || reminder.weekdays.includes(i);
                    return (
                      <button
                        key={i}
                        type="button"
                        className="chip"
                        aria-pressed={on}
                        style={{ width: 34, justifyContent: 'center', padding: 0 }}
                        onClick={() => {
                          const all = reminder.weekdays?.length ? reminder.weekdays : [0, 1, 2, 3, 4, 5, 6];
                          const next = on ? all.filter((x) => x !== i) : [...all, i].sort();
                          set({ reminder: { ...reminder, weekdays: next.length === 7 ? [] : next } });
                        }}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </Section>
        )}

        {!isNew && (
          <Section title="Keep or remove">
            <ToggleRow title="Archived" sub="Hidden everywhere, data kept. Formulas can still use it." checked={!!m.archived} onChange={(archived) => set({ archived })} />
            <MergeInto from={original!} />
          </Section>
        )}
      </div>
      <SaveBar onSave={() => void save()} onDelete={original ? () => void remove() : undefined} disabled={!m.name.trim() || !!slugErr} saveLabel={isNew ? 'Create metric' : 'Save'} />
    </StudioPage>
  );
}
