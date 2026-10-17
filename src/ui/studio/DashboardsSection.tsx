import { ArrowDown, ArrowUp, ChevronRight, LayoutGrid, Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useVault } from '@/app/hooks';
import { navigate } from '@/app/router';
import { charts, dashboards, deleteDashboard, newId, nextOrder, saveDashboard } from '@/core/data/repo';
import type { Dashboard } from '@/core/model/types';
import { confirm, Segmented, TextField } from '../components/Controls';
import { METRIC_ICONS, MetricIcon } from '../components/Icon';
import { toast } from '../components/Toast';
import { AddButton, SaveBar, Section, StudioPage } from './common';

export function DashboardsSection({ id }: { id?: string }) {
  if (id) return <DashboardEditor id={id} />;
  return <DashboardList />;
}

function DashboardList() {
  const { vault, version } = useVault();
  const list = useMemo(() => dashboards(vault), [vault, version]);
  return (
    <StudioPage title={<em>Dashboards</em>} actions={<AddButton label="New dashboard" onClick={() => navigate({ name: 'studio', section: 'dashboards', id: 'new' })} />}>
      {list.length === 0 ? (
        <div className="empty card">
          <LayoutGrid size={26} />
          <h3>No dashboards yet</h3>
        </div>
      ) : (
        <div className="card list">
          {list.map((d, i) => (
            <div key={d.id} className="list-row">
              <span className="badge">
                <MetricIcon name={d.icon ?? undefined} />
              </span>
              <button className="grow" style={{ textAlign: 'left' }} onClick={() => navigate({ name: 'studio', section: 'dashboards', id: d.id })}>
                <span className="title">{d.name}</span>
                <span className="sub" style={{ display: 'block' }}>
                  {d.items.length} charts
                </span>
              </button>
              <div className="row" style={{ gap: 2 }}>
                <button
                  className="icon-btn"
                  disabled={i === 0}
                  aria-label="Move up"
                  onClick={() => {
                    const prev = list[i - 1]!;
                    vault.batch(() => {
                      saveDashboard(vault, { ...d, order: prev.order });
                      saveDashboard(vault, { ...prev, order: d.order });
                    });
                  }}
                >
                  <ArrowUp size={16} />
                </button>
                <button className="icon-btn" onClick={() => navigate({ name: 'studio', section: 'dashboards', id: d.id })} aria-label="Edit">
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </StudioPage>
  );
}

function DashboardEditor({ id }: { id: string }) {
  const { vault, version } = useVault();
  const isNew = id === 'new';
  const original = useMemo(() => (isNew ? undefined : dashboards(vault).find((d) => d.id === id)), [vault, id, isNew]);
  const [d, setD] = useState<Dashboard>(() => original ?? { id: newId(), name: '', icon: 'sparkles', items: [], order: nextOrder(dashboards(vault)) });
  const all = useMemo(() => charts(vault), [vault, version]);
  const byId = new Map(all.map((c) => [c.id, c]));
  const available = all.filter((c) => !d.items.some((i) => i.chartId === c.id));

  if (!isNew && !original) {
    return (
      <StudioPage title="Not found" back={{ section: 'dashboards' }}>
        <p className="muted">This dashboard no longer exists.</p>
      </StudioPage>
    );
  }

  const move = (i: number, dir: -1 | 1) => {
    const items = [...d.items];
    [items[i], items[i + dir]] = [items[i + dir]!, items[i]!];
    setD({ ...d, items });
  };

  return (
    <StudioPage title={isNew ? <em>New dashboard</em> : <em>{original!.name}</em>} back={{ section: 'dashboards' }} eyebrow="Dashboard">
      <div className="studio-form">
        <Section title="Name">
          <TextField label="Name" value={d.name} onChange={(name) => setD({ ...d, name })} placeholder="e.g. Body" autoFocus={isNew} />
          <div className="icon-grid">
            {Object.keys(METRIC_ICONS).map((name) => (
              <button key={name} type="button" aria-pressed={d.icon === name} onClick={() => setD({ ...d, icon: name })} title={name}>
                <MetricIcon name={name} size={18} />
              </button>
            ))}
          </div>
        </Section>
        <Section title="Charts, in order">
          {d.items.length === 0 && <p className="small muted">No charts yet — add some below.</p>}
          <div className="list">
            {d.items.map((item, i) => (
              <div key={item.chartId} className="list-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
                <span className="grow">
                  <span className="title">{byId.get(item.chartId)?.title ?? 'Missing chart'}</span>
                </span>
                <Segmented
                  value={item.size}
                  onChange={(size) => setD({ ...d, items: d.items.map((x, j) => (j === i ? { ...x, size } : x)) })}
                  options={[
                    { value: 'full', label: 'Wide' },
                    { value: 'half', label: 'Half' },
                  ]}
                />
                <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                  <ArrowUp size={16} />
                </button>
                <button className="icon-btn" disabled={i === d.items.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                  <ArrowDown size={16} />
                </button>
                <button className="icon-btn" onClick={() => setD({ ...d, items: d.items.filter((_, j) => j !== i) })} aria-label="Remove">
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
          {available.length > 0 && (
            <div className="field">
              <span className="field-label">Add</span>
              <div className="row wrap">
                {available.map((c) => (
                  <button key={c.id} className="chip" onClick={() => setD({ ...d, items: [...d.items, { chartId: c.id, size: 'full' }] })}>
                    <Plus size={13} /> {c.title}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Section>
      </div>
      <SaveBar
        disabled={!d.name.trim()}
        saveLabel={isNew ? 'Create dashboard' : 'Save'}
        onSave={() => {
          saveDashboard(vault, { ...d, name: d.name.trim() });
          toast('Saved');
          navigate({ name: 'charts', dashboardId: d.id }, { replace: true });
        }}
        onDelete={
          original
            ? async () => {
                if (await confirm({ title: `Delete ${original.name}?`, body: 'The charts themselves are kept.', confirmLabel: 'Delete', danger: true })) {
                  deleteDashboard(vault, original.id);
                  navigate({ name: 'studio', section: 'dashboards' }, { replace: true });
                }
              }
            : undefined
        }
      />
    </StudioPage>
  );
}
