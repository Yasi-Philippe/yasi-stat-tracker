import { ChevronRight, Flag, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useToday, useVault } from '@/app/hooks';
import { navigate } from '@/app/router';
import { slugProblem } from '@/core/data/refs';
import { deletePeriod, deletePeriodSet, newId, nextOrder, periods, periodSets, savePeriod, savePeriodSet, slugify, usedSlugs } from '@/core/data/repo';
import { fromDayNum, toDayNum } from '@/core/model/dates';
import type { Period, PeriodSet } from '@/core/model/types';
import { ColorPicker, confirm, Segmented, TextField } from '../components/Controls';
import { Sheet } from '../components/Sheet';
import { toast } from '../components/Toast';
import { fmtDay } from '../format';
import { AddButton, SaveBar, Section, StudioPage } from './common';

export function PeriodsSection({ id }: { id?: string }) {
  if (id) return <SetEditor id={id} />;
  return <SetList />;
}

function SetList() {
  const { vault, version } = useVault();
  const sets = useMemo(() => periodSets(vault), [vault, version]);
  const all = useMemo(() => periods(vault), [vault, version]);
  return (
    <StudioPage title={<em>Periods</em>} actions={<AddButton label="New set" onClick={() => navigate({ name: 'studio', section: 'periods', id: 'new' })} />}>
      <p className="muted small" style={{ marginTop: -8, marginBottom: 16 }}>
        Named stretches of time. <b>Campaigns</b> start and stop with a button (a diet, a training block). <b>Chapters</b> split your life into parts (places
        you lived, jobs). Charts can show one chart per period, compare periods, or shade them.
      </p>
      {sets.length === 0 ? (
        <div className="empty card">
          <Flag size={26} />
          <h3>No period sets yet</h3>
        </div>
      ) : (
        <div className="card list">
          {sets.map((s) => {
            const n = all.filter((p) => p.setId === s.id).length;
            return (
              <button key={s.id} className="list-row" onClick={() => navigate({ name: 'studio', section: 'periods', id: s.id })}>
                <span className="badge" style={{ color: s.color || 'var(--accent-2)' }}>
                  <Flag size={18} />
                </span>
                <span className="grow">
                  <span className="title">{s.name}</span>
                  <span className="sub">
                    {s.kind === 'campaign' ? 'Campaigns' : 'Chapters'} · {n} {n === 1 ? 'period' : 'periods'}
                  </span>
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

function SetEditor({ id }: { id: string }) {
  const { vault, version } = useVault();
  const today = useToday();
  const isNew = id === 'new';
  const original = useMemo(() => (isNew ? undefined : periodSets(vault).find((s) => s.id === id)), [vault, id, isNew]);
  const [s, setS] = useState<PeriodSet>(() => original ?? { id: newId(), slug: '', name: '', kind: 'campaign', order: nextOrder(periodSets(vault)) });
  const list = useMemo(() => (original ? periods(vault, original.id) : []), [vault, version, original]);
  const [editing, setEditing] = useState<Period | null>(null);
  const used = useMemo(() => usedSlugs(vault, original?.id), [vault, original?.id]);
  const slug = original ? s.slug : slugify(s.name || 'periods');
  const slugErr = s.name ? slugProblem(slug, used) : null;

  if (!isNew && !original) {
    return (
      <StudioPage title="Not found" back={{ section: 'periods' }}>
        <p className="muted">This set no longer exists.</p>
      </StudioPage>
    );
  }

  const save = () => {
    savePeriodSet(vault, { ...s, slug, name: s.name.trim() });
    toast(isNew ? 'Created' : 'Saved');
    if (isNew) navigate({ name: 'studio', section: 'periods', id: s.id }, { replace: true });
  };

  return (
    <StudioPage title={isNew ? <em>New period set</em> : <em>{original!.name}</em>} back={{ section: 'periods' }} eyebrow="Periods">
      <div className="studio-form">
        <Section title="Set">
          <TextField label="Name" value={s.name} onChange={(name) => setS({ ...s, name })} placeholder="e.g. Weight-loss campaigns" error={slugErr ?? undefined} autoFocus={isNew} />
          <div className="field">
            <span className="field-label">Kind</span>
            <Segmented
              block
              value={s.kind}
              onChange={(kind) => setS({ ...s, kind })}
              options={[
                { value: 'campaign', label: 'Campaigns' },
                { value: 'segment', label: 'Chapters' },
              ]}
            />
            <span className="hint">{s.kind === 'campaign' ? 'Started and stopped from the Today screen.' : 'Consecutive parts of your life, edited here.'}</span>
          </div>
          <div className="field">
            <span className="field-label">Shade colour</span>
            <ColorPicker value={s.color} onChange={(color) => setS({ ...s, color })} allowNone />
          </div>
        </Section>

        {!isNew && (
          <Section title="Periods">
            {list.length === 0 && <p className="small muted">None yet.</p>}
            <div className="list">
              {list.map((p) => (
                <button key={p.id} className="list-row" style={{ paddingLeft: 0, paddingRight: 0 }} onClick={() => setEditing(p)}>
                  <span className="swatch" style={{ background: p.color || s.color || 'var(--accent-2)' }} />
                  <span className="grow">
                    <span className="title">{p.name}</span>
                    <span className="sub">
                      {fmtDay(p.start, 'medium')} → {p.end ? fmtDay(p.end, 'medium') : 'ongoing'} · {(p.end ? toDayNum(p.end) : today) - toDayNum(p.start) + 1} days
                    </span>
                  </span>
                  <ChevronRight size={16} className="faint" />
                </button>
              ))}
            </div>
            <button
              className="btn block"
              onClick={() => {
                const last = list[list.length - 1];
                const start = last?.end ? fromDayNum(toDayNum(last.end) + 1) : fromDayNum(today);
                setEditing({ id: newId(), setId: s.id, name: '', start, end: s.kind === 'segment' ? null : null });
              }}
            >
              <Plus size={16} /> Add a period
            </button>
          </Section>
        )}
      </div>
      <SaveBar
        onSave={save}
        disabled={!s.name.trim() || !!slugErr}
        saveLabel={isNew ? 'Create set' : 'Save'}
        onDelete={
          original
            ? async () => {
                if (await confirm({ title: `Delete ${original.name}?`, body: `Its ${list.length} periods are removed too. Charts using this set will show an error.`, confirmLabel: 'Delete', danger: true })) {
                  deletePeriodSet(vault, original.id);
                  navigate({ name: 'studio', section: 'periods' }, { replace: true });
                }
              }
            : undefined
        }
      />
      <Sheet open={!!editing} onClose={() => setEditing(null)} title={editing && list.some((p) => p.id === editing.id) ? 'Edit period' : 'New period'}>
        {editing && <PeriodForm p={editing} onDone={() => setEditing(null)} existing={list.some((x) => x.id === editing.id)} />}
      </Sheet>
    </StudioPage>
  );
}

function PeriodForm({ p, onDone, existing }: { p: Period; onDone: () => void; existing: boolean }) {
  const { vault } = useVault();
  const [d, setD] = useState(p);
  const valid = d.name.trim() && d.start && (!d.end || d.end >= d.start);
  return (
    <div className="stack-16">
      <TextField label="Name" value={d.name} onChange={(name) => setD({ ...d, name })} autoFocus placeholder="e.g. Spring cut, Berlin" />
      <div className="row">
        <div className="field grow">
          <label>Start</label>
          <input className="input" type="date" value={d.start} onChange={(e) => setD({ ...d, start: e.target.value })} />
        </div>
        <div className="field grow">
          <label>End</label>
          <input className="input" type="date" value={d.end ?? ''} min={d.start} onChange={(e) => setD({ ...d, end: e.target.value || null })} />
        </div>
      </div>
      <p className="tiny faint">Leave the end empty while it is still going on.</p>
      <div className="field">
        <span className="field-label">Colour</span>
        <ColorPicker value={d.color} onChange={(color) => setD({ ...d, color })} allowNone />
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        {existing ? (
          <button
            className="btn danger"
            onClick={() => {
              deletePeriod(vault, p.id);
              onDone();
            }}
          >
            <Trash2 size={15} /> Delete
          </button>
        ) : (
          <span />
        )}
        <button
          className="btn primary"
          disabled={!valid}
          onClick={() => {
            savePeriod(vault, { ...d, name: d.name.trim() });
            onDone();
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
