import { BarChart3, CircleUser, FlaskConical, PenLine } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useSession } from '@/app/hooks';
import { navigate, type Route, useRoute } from '@/app/router';
import { session } from '@/app/session';
import { KeyRescue, SignedOutBanner } from '../auth/AuthScreens';
import { confirm } from '../components/Controls';
import { Mark } from '../components/Logo';
import { timeAgo } from '../format';
import './shell.css';

const NAV: Array<{ route: Route; label: string; icon: typeof PenLine; match: Route['name'][] }> = [
  { route: { name: 'today' }, label: 'Today', icon: PenLine, match: ['today', 'metric'] },
  { route: { name: 'charts' }, label: 'Charts', icon: BarChart3, match: ['charts', 'chart'] },
  { route: { name: 'studio' }, label: 'Studio', icon: FlaskConical, match: ['studio'] },
  { route: { name: 'settings' }, label: 'You', icon: CircleUser, match: ['settings'] },
];

export function AppShell({ children }: { children: ReactNode }) {
  const route = useRoute();
  const s = useSession();
  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-brand">
          <Mark size={30} />
          <span className="display">
            <em>trazo</em>
          </span>
        </div>
        <nav className="rail-nav">
          {NAV.map((n) => (
            <button key={n.label} className="rail-item" aria-current={n.match.includes(route.name) ? 'page' : undefined} onClick={() => navigate(n.route)}>
              <n.icon size={19} strokeWidth={2.1} />
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          <SyncBadge />
          {s.email && <div className="tiny faint rail-email">{s.email}</div>}
        </div>
      </aside>

      <main className="main">
        <Banners />
        {children}
      </main>

      <nav className="tabbar" aria-label="Main">
        {NAV.map((n) => {
          const active = n.match.includes(route.name);
          return (
            <button key={n.label} className="tab" aria-current={active ? 'page' : undefined} onClick={() => navigate(n.route)}>
              <span className="tab-icon">
                <n.icon size={21} strokeWidth={active ? 2.4 : 2} />
              </span>
              <span className="tab-label">{n.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function Banners() {
  const s = useSession();
  return (
    <div className="banners">
      {s.mode === 'demo' && (
        <div className="banner demo">
          <span className="chip accent">Demo</span>
          <span className="grow small">Made-up data, kept only on this device.</span>
          {s.cloud && (
            <button
              className="link-btn small"
              onClick={async () => {
                if (await confirm({ title: 'Leave the demo?', body: 'The demo data is deleted from this device.', confirmLabel: 'Leave demo' })) {
                  await session.logout();
                }
              }}
            >
              Create my account
            </button>
          )}
        </div>
      )}
      {s.mode === 'account' && s.phase.name === 'ready' && !s.signedIn && s.cloud && <SignedOutBanner />}
      {s.keyMismatch && <KeyChangedBanner />}
      {s.sync?.state === 'error' && s.sync.errorKind === 'denied' && (
        <div className="banner warn">
          <span className="grow small">The cloud refused access. Check that your email is verified, then log in again.</span>
        </div>
      )}
    </div>
  );
}

function KeyChangedBanner() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="banner warn" onClick={() => setOpen(true)}>
        <span className="grow small">
          Your account’s key was replaced on another device. This device’s data is safe — <b>tap to bring it into the account</b>.
        </span>
      </button>
      <KeyRescue open={open} onClose={() => setOpen(false)} reason="key-changed" />
    </>
  );
}

export function SyncBadge({ compact }: { compact?: boolean }) {
  const s = useSession();
  if (s.mode === 'demo') return <span className="sync-badge"><span className="sync-dot demo" /> {!compact && 'Demo · on this device'}</span>;
  const st = s.sync;
  let cls = 'idle';
  let text = 'Not synced yet';
  if (!s.signedIn && s.mode === 'account') {
    cls = 'off';
    text = 'Sync paused';
  } else if (st) {
    switch (st.state) {
      case 'syncing':
        cls = 'busy';
        text = 'Syncing…';
        break;
      case 'offline':
        cls = 'off';
        text = st.pending ? `Offline · ${st.pending} waiting` : 'Offline';
        break;
      case 'error':
        cls = 'err';
        text = st.errorKind === 'quota' ? 'Cloud quota reached' : 'Sync problem';
        break;
      case 'stopped':
        cls = 'off';
        text = 'Sync stopped';
        break;
      default:
        cls = 'idle';
        text = st.lastSyncAt ? `Synced ${timeAgo(st.lastSyncAt)}` : 'Synced';
    }
  }
  return (
    <button
      className="sync-badge"
      title={st?.error ?? text}
      onClick={() => void session.syncNow()}
      aria-label={`${text}. Sync now`}
    >
      <span className={`sync-dot ${cls}`} />
      {!compact && <span>{text}</span>}
    </button>
  );
}

/** Standard page header: big serif title with optional eyebrow and actions. */
export function PageHeader({ eyebrow, title, actions, sub }: { eyebrow?: ReactNode; title: ReactNode; actions?: ReactNode; sub?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="grow">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1 className="display page-title">{title}</h1>
        {sub && <div className="muted small page-sub">{sub}</div>}
      </div>
      {actions && <div className="row page-actions">{actions}</div>}
    </header>
  );
}
