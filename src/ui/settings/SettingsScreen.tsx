import { Bell, Cloud, Download, FileSpreadsheet, KeyRound, LogOut, Mail, Palette, RefreshCw, Shield, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { allThemes, useSession, useSettings, useVault } from '@/app/hooks';
import { navigate } from '@/app/router';
import { session } from '@/app/session';
import { passwordProblem } from '@/core/account/password';
import { saveSettings } from '@/core/data/repo';
import { platform } from '@/platform';
import { confirm, Select, TextField, ToggleRow } from '../components/Controls';
import { Sheet } from '../components/Sheet';
import { toast, toastError } from '../components/Toast';
import { timeAgo } from '../format';
import { PageHeader, SyncBadge } from '../shell/AppShell';
import { BackupActions } from './BackupActions';
import './settings.css';

const LOCALES = [
  { value: '', label: 'Same as the system' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'es-ES', label: 'Español' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'it-IT', label: 'Italiano' },
  { value: 'pt-PT', label: 'Português' },
  { value: 'de-DE', label: 'Deutsch' },
];

export function SettingsScreen({ section }: { section?: string }) {
  void section;
  const s = useSession();
  const { vault, version } = useVault();
  const settings = useSettings();
  const themes = useMemo(() => allThemes(vault), [vault, version]);
  const [pwOpen, setPwOpen] = useState(false);
  const [rk, setRk] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const protection = platform().secrets.protection;

  return (
    <div className="settings">
      <PageHeader eyebrow={s.mode === 'demo' ? 'Demo' : 'Account'} title={<em>You</em>} />

      <section className="card pad account-card">
        <div className="row">
          <span className="badge">
            <Cloud size={18} />
          </span>
          <div className="grow">
            <div className="title">{s.mode === 'demo' ? 'Demo mode' : s.email}</div>
            <SyncBadge />
          </div>
          {s.mode === 'account' && (
            <button className="btn sm" onClick={() => void session.syncNow()}>
              <RefreshCw size={14} /> Sync
            </button>
          )}
        </div>
        {s.sync?.error && s.sync.state === 'error' && <p className="small neg">{s.sync.error}</p>}
        <div className="account-facts">
          <Fact icon={<Shield size={15} />} text="End-to-end encrypted: data is sealed on this device before it travels." />
          <Fact
            icon={<KeyRound size={15} />}
            text={
              protection === 'hardware'
                ? 'This device keeps its key in the Android Keystore.'
                : protection === 'os-keyring'
                  ? 'This device keeps its key in the system keyring.'
                  : 'This device keeps its key in browser storage.'
            }
          />
          {s.sync?.lastSyncAt && <Fact icon={<RefreshCw size={15} />} text={`Last synced ${timeAgo(s.sync.lastSyncAt)}${s.sync.pending ? ` · ${s.sync.pending} waiting` : ''}.`} />}
        </div>
      </section>

      {s.mode === 'account' && (
        <Group title="Security">
          <Row icon={<KeyRound size={18} />} title="Change password" sub="Re-seals your key; other devices are signed out." onClick={() => setPwOpen(true)} />
          <Row
            icon={<Shield size={18} />}
            title="New recovery key"
            sub="Replaces the old one, which stops working."
            onClick={async () => {
              if (!(await confirm({ title: 'Create a new recovery key?', body: 'The current recovery key stops working immediately.', confirmLabel: 'Create new key' }))) return;
              try {
                setRk(await session.newRecoveryKey());
              } catch (err) {
                toastError(err);
              }
            }}
          />
          <Row icon={<Mail size={18} />} title="Forgot your password?" sub="Log out, then use “I forgot my password” on the login screen." />
        </Group>
      )}

      <Group title="Reminders">
        <RemindersRow />
      </Group>

      <Group title="Appearance">
        <div className="theme-chips scroll-x">
          {themes.map((t) => (
            <button
              key={t.id}
              className="theme-chip"
              aria-pressed={t.id === settings.themeId}
              onClick={() => saveSettings(vault, { themeId: t.id })}
              style={{ background: t.tokens.bg, color: t.tokens.text, borderColor: t.id === settings.themeId ? t.tokens.accent : t.tokens.line }}
            >
              <span className="theme-chip-dot" style={{ background: `linear-gradient(135deg, ${t.tokens.accent2}, ${t.tokens.accent})` }} />
              {t.name}
            </button>
          ))}
        </div>
        <Row icon={<Palette size={18} />} title="Theme studio" sub="Make your own colours, fonts and chart style." onClick={() => navigate({ name: 'studio', section: 'themes' })} />
        <div className="pad-row">
          <Select label="Numbers and dates" value={settings.locale ?? ''} onChange={(locale) => saveSettings(vault, { locale })} options={LOCALES} />
        </div>
        <div className="pad-row">
          <ToggleRow title="Discreet mode" sub="Blur values on Today until you tap them." checked={!!settings.discreet} onChange={(discreet) => saveSettings(vault, { discreet })} />
        </div>
      </Group>

      <Group title="Your data">
        <BackupActions />
        <Row icon={<FileSpreadsheet size={18} />} title="Import from CSV or Excel" sub="Bring your history in." onClick={() => navigate({ name: 'studio', section: 'import' })} />
      </Group>

      <Group title="Leave">
        {s.mode === 'demo' ? (
          <Row
            icon={<LogOut size={18} />}
            title="Leave the demo"
            sub="Deletes the made-up data from this device."
            onClick={async () => {
              if (await confirm({ title: 'Leave the demo?', confirmLabel: 'Leave', danger: true })) await session.logout();
            }}
          />
        ) : (
          <>
            <Row
              icon={<LogOut size={18} />}
              title="Log out on this device"
              sub="Removes the data from this device. It stays in your encrypted cloud."
              onClick={async () => {
                const pending = s.sync?.pending ?? 0;
                if (
                  await confirm({
                    title: 'Log out?',
                    body: pending ? `${pending} change(s) haven't reached the cloud yet. We'll try to sync first.` : 'You can log in again any time.',
                    confirmLabel: 'Log out',
                    danger: true,
                  })
                )
                  await session.logout();
              }}
            />
            <Row icon={<Trash2 size={18} />} title="Delete my account" sub="Erases your cloud data and login for good." danger onClick={() => setDeleting(true)} />
          </>
        )}
      </Group>

      <p className="tiny faint center-text" style={{ marginTop: 18 }}>
        Trazo {__APP_VERSION__} · your numbers, sealed on your devices.
      </p>

      <Sheet open={pwOpen} onClose={() => setPwOpen(false)} title="Change password">
        <ChangePassword onDone={() => setPwOpen(false)} />
      </Sheet>
      <Sheet open={!!rk} onClose={() => setRk(null)} title="Your new recovery key">
        {rk && (
          <div className="stack-16">
            <p className="muted small">Store it somewhere safe. The old key no longer works.</p>
            <div className="rk-grid num">
              {rk.split('-').map((g, i) => (
                <span key={i}>{g}</span>
              ))}
            </div>
            <div className="row">
              <button
                className="btn"
                onClick={() =>
                  void navigator.clipboard.writeText(rk).then(
                    () => toast('Copied'),
                    () => toast('Copy failed', { kind: 'error' }),
                  )
                }
              >
                Copy
              </button>
              <button className="btn" onClick={() => void platform().files.save('trazo-recovery-key.txt', 'text/plain', `Trazo recovery key\n\n${rk}\n`)}>
                <Download size={15} /> Save as file
              </button>
              <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => setRk(null)}>
                Done
              </button>
            </div>
          </div>
        )}
      </Sheet>
      <Sheet open={deleting} onClose={() => setDeleting(false)} title="Delete account">
        <DeleteAccount onDone={() => setDeleting(false)} />
      </Sheet>
    </div>
  );
}

function Fact({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="fact">
      {icon}
      <span>{text}</span>
    </div>
  );
}

export function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="settings-group">
      <h2 className="eyebrow">{title}</h2>
      <div className="card list">{children}</div>
    </section>
  );
}

export function Row({ icon, title, sub, onClick, danger }: { icon: React.ReactNode; title: string; sub?: string; onClick?: () => void; danger?: boolean }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`list-row${danger ? ' danger-row' : ''}`} onClick={onClick}>
      <span className="row-icon">{icon}</span>
      <span className="grow">
        <span className="title" style={{ display: 'block' }}>
          {title}
        </span>
        {sub && <span className="sub">{sub}</span>}
      </span>
    </Tag>
  );
}

function RemindersRow() {
  const notifier = platform().notifier;
  const [perm, setPerm] = useState<string>('…');
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    void notifier.permission().then(setPerm);
  }, [notifier]);
  if (!notifier.canSchedule) {
    return <Row icon={<Bell size={18} />} title="Reminders live in the Android app" sub="Set them per metric in the Studio; your phone will nudge you." />;
  }
  return (
    <>
      <Row
        icon={<Bell size={18} />}
        title={perm === 'granted' ? 'Notifications allowed' : 'Allow notifications'}
        sub={perm === 'granted' ? (count !== null ? `${count} reminders scheduled for the next weeks.` : 'Reminders are set per metric in the Studio.') : 'Needed for reminders.'}
        onClick={async () => {
          if (perm !== 'granted') {
            const ok = await notifier.requestPermission();
            setPerm(ok ? 'granted' : 'denied');
            if (!ok) toast('Notifications are blocked in system settings.', { kind: 'error' });
          }
          setCount(await session.scheduleReminders());
        }}
      />
    </>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [oldPw, setOld] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const problem = pw ? passwordProblem(pw) : null;
  return (
    <form
      className="stack-16"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await session.changePassword(oldPw, pw);
          toast('Password changed');
          onDone();
        } catch (err) {
          toastError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <TextField label="Current password" type="password" value={oldPw} onChange={setOld} autoComplete="current-password" autoFocus />
      <TextField label="New password" type="password" value={pw} onChange={setPw} autoComplete="new-password" error={pw.length > 3 ? (problem ?? undefined) : undefined} />
      <TextField label="Repeat new password" type="password" value={pw2} onChange={setPw2} autoComplete="new-password" error={pw2 && pw !== pw2 ? 'Passwords do not match.' : undefined} />
      <button className="btn primary lg block" disabled={!oldPw || !!passwordProblem(pw) || pw !== pw2 || busy}>
        {busy && <span className="spinner" />} Change password
      </button>
    </form>
  );
}

function DeleteAccount({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack-16">
      <div className="callout warn">
        <Trash2 size={18} />
        <span>This erases all your encrypted data from the cloud and deletes your login. Devices keep nothing. It cannot be undone.</span>
      </div>
      <BackupHint />
      <TextField label="Password" type="password" value={pw} onChange={setPw} autoComplete="current-password" />
      <button
        className="btn danger lg block"
        disabled={!pw || busy}
        onClick={async () => {
          if (!(await confirm({ title: 'Really delete everything?', confirmLabel: 'Delete my account', danger: true, typeToConfirm: 'DELETE' }))) return;
          setBusy(true);
          try {
            await session.deleteAccount(pw);
            onDone();
          } catch (err) {
            toastError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy && <span className="spinner" />} Delete account
      </button>
    </div>
  );
}

function BackupHint() {
  return <p className="small muted">Tip: export an encrypted backup first if you might want this data again.</p>;
}
