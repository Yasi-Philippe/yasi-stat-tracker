import { lazy, Suspense, useEffect } from 'react';
import { Booting, Fatal, Locked, RecoveryKeyScreen, Restoring, VerifyEmail, Welcome } from '@/ui/auth/AuthScreens';
import { Toasts } from '@/ui/components/Toast';
import { setLocale } from '@/ui/format';
import { AppShell } from '@/ui/shell/AppShell';
import { applyTheme } from '@/ui/theme/applyTheme';
import { Today } from '@/ui/today/Today';
import { useSession, useSettings, useTheme } from './hooks';
import { useRoute } from './router';

const Dashboards = lazy(() => import('@/ui/charts/Dashboards').then((m) => ({ default: m.Dashboards })));
const ChartScreen = lazy(() => import('@/ui/charts/ChartScreen').then((m) => ({ default: m.ChartScreen })));
const MetricScreen = lazy(() => import('@/ui/metric/MetricScreen').then((m) => ({ default: m.MetricScreen })));
const Studio = lazy(() => import('@/ui/studio/Studio').then((m) => ({ default: m.Studio })));
const SettingsScreen = lazy(() => import('@/ui/settings/SettingsScreen').then((m) => ({ default: m.SettingsScreen })));

export function App() {
  const s = useSession();
  let screen;
  switch (s.phase.name) {
    case 'booting':
      screen = <Booting />;
      break;
    case 'welcome':
      screen = <Welcome />;
      break;
    case 'recovery-key':
      screen = <RecoveryKeyScreen recoveryKey={s.phase.recoveryKey} />;
      break;
    case 'verify-email':
      screen = <VerifyEmail />;
      break;
    case 'locked':
      screen = <Locked />;
      break;
    case 'restoring':
      screen = <Restoring received={s.phase.received} />;
      break;
    case 'fatal':
      screen = <Fatal message={s.phase.message} />;
      break;
    case 'ready':
      screen = <Ready />;
      break;
  }
  return (
    <>
      <div className="ambience" aria-hidden>
        <div className="grain" />
      </div>
      {screen}
      <Toasts />
    </>
  );
}

function Ready() {
  const theme = useTheme();
  const settings = useSettings();
  const route = useRoute();

  useEffect(() => {
    applyTheme(theme.tokens);
    try {
      localStorage.setItem('trazo.theme', JSON.stringify(theme.tokens));
    } catch {
      // Storage full or blocked: the theme just won't preload next time.
    }
  }, [theme]);

  useEffect(() => setLocale(settings.locale), [settings.locale]);

  let page;
  switch (route.name) {
    case 'today':
      page = <Today />;
      break;
    case 'charts':
      page = <Dashboards dashboardId={route.dashboardId} />;
      break;
    case 'chart':
      page = <ChartScreen id={route.id} />;
      break;
    case 'metric':
      page = <MetricScreen id={route.id} />;
      break;
    case 'studio':
      page = <Studio section={route.section} id={route.id} />;
      break;
    case 'settings':
      page = <SettingsScreen section={route.section} />;
      break;
  }
  return (
    <AppShell>
      <Suspense fallback={<div className="skeleton" style={{ height: 240, marginTop: 40 }} />}>
        <div key={route.name} className="page-enter">
          {page}
        </div>
      </Suspense>
    </AppShell>
  );
}
