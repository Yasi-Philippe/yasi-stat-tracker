import { LayoutGrid, Plus, Settings2 } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useVault } from '@/app/hooks';
import { navigate } from '@/app/router';
import { charts, dashboards } from '@/core/data/repo';
import { MetricIcon } from '../components/Icon';
import { PageHeader } from '../shell/AppShell';
import { ChartCard } from './ChartCard';
import './charts.css';

const LAST_DASHBOARD = 'trazo.lastDashboard';

export function Dashboards({ dashboardId }: { dashboardId?: string }) {
  const { vault, version } = useVault();
  const list = useMemo(() => dashboards(vault), [vault, version]);
  const all = useMemo(() => new Map(charts(vault).map((c) => [c.id, c])), [vault, version]);
  const remembered = (() => {
    try {
      return localStorage.getItem(LAST_DASHBOARD);
    } catch {
      return null;
    }
  })();
  const current = list.find((d) => d.id === dashboardId) ?? list.find((d) => d.id === remembered) ?? list[0];

  useEffect(() => {
    if (current)
      try {
        localStorage.setItem(LAST_DASHBOARD, current.id);
      } catch {
        // ignore
      }
  }, [current]);

  if (!current) {
    return (
      <div>
        <PageHeader title={<em>Charts</em>} />
        <div className="empty card">
          <h3>No dashboards yet</h3>
          <p className="small">Add a starter pack or build a chart in the Studio.</p>
          <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
            <button className="btn primary" onClick={() => navigate({ name: 'studio', section: 'charts', id: 'new' })}>
              <Plus size={16} /> New chart
            </button>
          </div>
        </div>
      </div>
    );
  }

  const items = current.items.map((i) => ({ ...i, spec: all.get(i.chartId) })).filter((i) => i.spec);

  return (
    <div className="dashboards">
      <PageHeader
        eyebrow="Charts"
        title={<em>{current.name}</em>}
        actions={
          <>
            <button className="icon-btn" title="Edit dashboard" onClick={() => navigate({ name: 'studio', section: 'dashboards', id: current.id })}>
              <Settings2 size={19} />
            </button>
            <button className="icon-btn" title="New chart" onClick={() => navigate({ name: 'studio', section: 'charts', id: 'new' })}>
              <Plus size={20} />
            </button>
          </>
        }
      />
      {list.length > 1 && (
        <div className="dash-tabs scroll-x" role="tablist">
          {list.map((d) => (
            <button key={d.id} role="tab" className="dash-tab" aria-selected={d.id === current.id} onClick={() => navigate({ name: 'charts', dashboardId: d.id }, { replace: true })}>
              <MetricIcon name={d.icon ?? undefined} size={15} />
              {d.name}
            </button>
          ))}
        </div>
      )}
      {items.length === 0 ? (
        <div className="empty card">
          <LayoutGrid size={28} />
          <h3>This dashboard is empty</h3>
          <p className="small">Add charts to it from the Studio.</p>
        </div>
      ) : (
        <div className="chart-grid">
          {items.map((i, n) => (
            <ChartCard key={i.chartId} spec={i.spec!} size={i.size} index={n} />
          ))}
        </div>
      )}
    </div>
  );
}
