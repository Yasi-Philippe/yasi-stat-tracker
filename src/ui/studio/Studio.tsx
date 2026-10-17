import { ChevronRight, Flag, LayoutGrid, LineChart, Package, Palette, Ruler, Sigma, Upload } from 'lucide-react';
import { useMemo } from 'react';
import { useVault } from '@/app/hooks';
import { navigate, type StudioSection } from '@/app/router';
import { charts, customThemes, dashboards, formulas, metrics, periodSets } from '@/core/data/repo';
import { PageHeader } from '../shell/AppShell';
import { ChartsSection } from './ChartsSection';
import { DashboardsSection } from './DashboardsSection';
import { FormulasSection } from './FormulasSection';
import { ImportSection } from './ImportSection';
import { MetricsSection } from './MetricsSection';
import { PeriodsSection } from './PeriodsSection';
import { TemplatesSection } from './TemplatesSection';
import { ThemesSection } from './ThemesSection';
import './studio.css';

export function Studio({ section, id }: { section?: StudioSection; id?: string }) {
  switch (section) {
    case 'metrics':
      return <MetricsSection id={id} />;
    case 'formulas':
      return <FormulasSection id={id} />;
    case 'periods':
      return <PeriodsSection id={id} />;
    case 'charts':
      return <ChartsSection id={id} />;
    case 'dashboards':
      return <DashboardsSection id={id} />;
    case 'themes':
      return <ThemesSection id={id} />;
    case 'templates':
      return <TemplatesSection />;
    case 'import':
      return <ImportSection />;
    default:
      return <StudioHome />;
  }
}

function StudioHome() {
  const { vault, version } = useVault();
  const counts = useMemo(
    () => ({
      metrics: metrics(vault, { includeArchived: true }).length,
      formulas: formulas(vault).length,
      periods: periodSets(vault).length,
      charts: charts(vault).length,
      dashboards: dashboards(vault).length,
      themes: customThemes(vault).length + 6,
    }),
    [vault, version],
  );
  const tiles: Array<{ section: StudioSection; title: string; sub: string; icon: typeof Ruler; count?: number }> = [
    { section: 'metrics', title: 'Metrics', sub: 'What you measure by hand', icon: Ruler, count: counts.metrics },
    { section: 'formulas', title: 'Formulas', sub: 'Values computed from others', icon: Sigma, count: counts.formulas },
    { section: 'periods', title: 'Periods', sub: 'Campaigns and chapters of life', icon: Flag, count: counts.periods },
    { section: 'charts', title: 'Charts', sub: 'How each view is drawn', icon: LineChart, count: counts.charts },
    { section: 'dashboards', title: 'Dashboards', sub: 'Which charts go together', icon: LayoutGrid, count: counts.dashboards },
    { section: 'themes', title: 'Themes', sub: 'Colours, fonts, chart style', icon: Palette, count: counts.themes },
    { section: 'templates', title: 'Starter packs', sub: 'Ready-made sets to build on', icon: Package },
    { section: 'import', title: 'Import', sub: 'Bring history from CSV or Excel', icon: Upload },
  ];
  return (
    <div>
      <PageHeader
        eyebrow="Your sandbox"
        title={
          <>
            The <em>Studio</em>
          </>
        }
        sub="Everything here is yours to shape: what you track, how it is computed and how it looks."
      />
      <div className="studio-grid">
        {tiles.map((t, i) => (
          <button key={t.section} className="studio-tile card" style={{ animationDelay: `${i * 35}ms` }} onClick={() => navigate({ name: 'studio', section: t.section })}>
            <span className="studio-tile-icon">
              <t.icon size={20} />
            </span>
            <span className="grow">
              <span className="studio-tile-title">
                {t.title}
                {t.count !== undefined && <span className="studio-count num">{t.count}</span>}
              </span>
              <span className="small muted">{t.sub}</span>
            </span>
            <ChevronRight size={18} className="faint" />
          </button>
        ))}
      </div>
    </div>
  );
}
