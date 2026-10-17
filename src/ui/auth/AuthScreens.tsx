import { ArrowLeft, Cloud, Copy, Download, KeyRound, Lock, Mail, ShieldCheck, Sparkles, WifiOff } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { useSession } from '@/app/hooks';
import { session } from '@/app/session';
import { passwordProblem, passwordScore } from '@/core/account/password';
import { platform } from '@/platform';
import { confirm, TextField } from '../components/Controls';
import { Sheet } from '../components/Sheet';
import { Mark } from '../components/Logo';
import { toast, toastError } from '../components/Toast';
import './auth.css';

function Frame({ children, onBack }: { children: ReactNode; onBack?: () => void }) {
  return (
    <div className="auth">
      <div className="auth-inner rise">
        {onBack && (
          <button className="icon-btn auth-back" onClick={onBack} aria-label="Back">
            <ArrowLeft size={20} />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return [busy, run] as const;
}

// ---------------------------------------------------------------------------

export function Welcome() {
  const { cloud } = useSession();
  const [mode, setMode] = useState<'home' | 'register' | 'login' | 'forgot' | 'after-reset'>('home');
  const [resetEmail, setResetEmail] = useState('');
  const [busy, run] = useBusy();

  if (mode === 'register') return <Register onBack={() => setMode('home')} onLogin={() => setMode('login')} />;
  if (mode === 'login') return <Login onBack={() => setMode('home')} onForgot={() => setMode('forgot')} onAfterReset={() => setMode('after-reset')} />;
  if (mode === 'forgot')
    return (
      <Forgot
        onBack={() => setMode('login')}
        onSent={setResetEmail}
        onAfterReset={() => setMode('after-reset')}
      />
    );
  if (mode === 'after-reset') return <AfterReset initialEmail={resetEmail} onBack={() => setMode('login')} />;

  return (
    <div className="auth welcome">
      <div className="welcome-art" aria-hidden>
        <svg viewBox="0 0 1200 600" preserveAspectRatio="none">
          <defs>
            <linearGradient id="wa" x1="0" x2="1">
              <stop offset="0" stopColor="var(--accent-2)" stopOpacity="0" />
              <stop offset="0.4" stopColor="var(--accent-2)" />
              <stop offset="1" stopColor="var(--accent)" />
            </linearGradient>
          </defs>
          <path
            className="welcome-line"
            d="M-20 470 C 120 470, 170 360, 300 380 S 470 520, 600 430 S 760 240, 880 300 S 1060 330, 1220 110"
            fill="none"
            stroke="url(#wa)"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <circle className="welcome-dot" cx="1180" cy="150" r="9" fill="var(--accent)" />
        </svg>
      </div>
      <div className="auth-inner welcome-inner">
        <div className="welcome-brand">
          <Mark size={46} animated />
          <h1 className="display welcome-title">
            <em>trazo</em>
          </h1>
        </div>
        <p className="welcome-tag display">Track anything. Own every number.</p>
        <ul className="welcome-points">
          <li>
            <ShieldCheck size={18} /> End-to-end encrypted. Not even the server can read it.
          </li>
          <li>
            <Cloud size={18} /> Works offline, syncs between your phone and computer.
          </li>
          <li>
            <Sparkles size={18} /> Your metrics, your formulas, your charts, your colours.
          </li>
        </ul>
        <div className="col welcome-actions">
          {cloud ? (
            <>
              <button className="btn primary lg block" onClick={() => setMode('register')}>
                Create account
              </button>
              <button className="btn lg block" onClick={() => setMode('login')}>
                Log in
              </button>
            </>
          ) : (
            <div className="callout">
              <WifiOff size={18} />
              <span>This build has no cloud configured, so accounts are off. You can still explore the demo.</span>
            </div>
          )}
          <button className="btn ghost block" disabled={busy} onClick={() => run(() => session.startDemo())}>
            {busy ? <span className="spinner" /> : null} Explore with demo data
          </button>
        </div>
      </div>
    </div>
  );
}

function PasswordMeter({ value }: { value: string }) {
  const score = passwordScore(value);
  const label = ['Too short', 'Weak', 'Okay', 'Good', 'Strong'][score];
  return (
    <div className="pw-meter" data-score={score}>
      <div className="bars">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={i < score ? 'on' : ''} />
        ))}
      </div>
      <span className="tiny muted">{value ? label : 'At least 10 characters. A few random words work well.'}</span>
    </div>
  );
}

function Register({ onBack, onLogin }: { onBack: () => void; onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, run] = useBusy();
  const problem = pw ? passwordProblem(pw) : null;
  const mismatch = pw2 && pw !== pw2 ? 'Passwords do not match.' : null;
  const ok = /.+@.+\..+/.test(email) && !passwordProblem(pw) && pw === pw2;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ok) void run(() => session.register(email.trim(), pw));
  };

  return (
    <Frame onBack={onBack}>
      <h1 className="display auth-title">
        Create your <em>account</em>
      </h1>
      <p className="muted auth-lede">
        Your password also locks your data. It never leaves this device — the cloud only ever stores sealed boxes.
      </p>
      <form className="stack-16" onSubmit={submit}>
        <TextField label="Email" value={email} onChange={setEmail} type="email" inputMode="email" autoComplete="email" autoFocus />
        <div className="field">
          <TextField label="Password" value={pw} onChange={setPw} type="password" autoComplete="new-password" error={problem && pw.length > 3 ? problem : undefined} />
          <PasswordMeter value={pw} />
        </div>
        <TextField label="Repeat password" value={pw2} onChange={setPw2} type="password" autoComplete="new-password" error={mismatch ?? undefined} />
        <button className="btn primary lg block" disabled={!ok || busy}>
          {busy ? (
            <>
              <span className="spinner" /> Sealing your keys…
            </>
          ) : (
            'Create account'
          )}
        </button>
        <p className="small muted center-text">
          Already have one?{' '}
          <button type="button" className="link-btn" onClick={onLogin}>
            Log in
          </button>
        </p>
      </form>
    </Frame>
  );
}

/**
 * Firebase only lets some projects point reset emails at Trazo's own page. When
 * it is set up (VITE_TRAZO_RESET_PAGE=1) the new password is chosen there;
 * otherwise Firebase's page is used with a one-time temporary password.
 */
const OWN_RESET_PAGE = import.meta.env.VITE_TRAZO_RESET_PAGE === '1';

function Login({ onBack, onForgot, onAfterReset }: { onBack: () => void; onForgot: () => void; onAfterReset: () => void }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, run] = useBusy();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email && pw) void run(() => session.login(email.trim(), pw));
  };
  return (
    <Frame onBack={onBack}>
      <h1 className="display auth-title">
        Welcome <em>back</em>
      </h1>
      <p className="muted auth-lede">Log in once on this device. Your data is downloaded sealed and opened here.</p>
      <form className="stack-16" onSubmit={submit}>
        <TextField label="Email" value={email} onChange={setEmail} type="email" inputMode="email" autoComplete="email" autoFocus />
        <TextField label="Password" value={pw} onChange={setPw} type="password" autoComplete="current-password" />
        <button className="btn primary lg block" disabled={!email || !pw || busy}>
          {busy ? (
            <>
              <span className="spinner" /> Unlocking…
            </>
          ) : (
            'Log in'
          )}
        </button>
        <p className="small center-text">
          <button type="button" className="link-btn" onClick={onForgot}>
            I forgot my password
          </button>
        </p>
        {!OWN_RESET_PAGE && (
          <p className="small center-text">
            <button type="button" className="link-btn muted" onClick={onAfterReset}>
              I already used a reset link
            </button>
          </p>
        )}
      </form>
    </Frame>
  );
}

function Forgot({ onBack, onSent, onAfterReset }: { onBack: () => void; onSent: (email: string) => void; onAfterReset: () => void }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, run] = useBusy();
  return (
    <Frame onBack={onBack}>
      <h1 className="display auth-title">
        Forgot your <em>password?</em>
      </h1>
      {sent ? (
        <div className="stack-16">
          <div className="callout">
            <Mail size={18} />
            <span>
              If an account exists for <b>{email}</b>, a reset link is on its way.
            </span>
          </div>
          {OWN_RESET_PAGE ? (
            <ol className="steps">
              <li>Open the link in the email and choose a new password.</li>
              <li>Come back here and log in with it.</li>
              <li>
                Your data unlocks by itself as soon as you also log in on <b>another device that still has it</b>. No other
                device? Keep your <b>recovery key</b> at hand.
              </li>
            </ol>
          ) : (
            <ol className="steps">
              <li>
                Open the link in the email. On the page that opens, type a <b>temporary password</b> — anything, it is only used
                once.
              </li>
              <li>
                Come back here and tap <b>I've set it</b>. You'll log in with the temporary password and choose your real new
                password, which never leaves this device.
              </li>
              <li>
                Your data unlocks by itself if this device or <b>another device still has it</b>. Otherwise keep your{' '}
                <b>recovery key</b> at hand.
              </li>
            </ol>
          )}
          {OWN_RESET_PAGE ? (
            <button className="btn primary lg block" onClick={onBack}>
              Back to log in
            </button>
          ) : (
            <button className="btn primary lg block" onClick={onAfterReset}>
              I've set it
            </button>
          )}
        </div>
      ) : (
        <form
          className="stack-16"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await session.sendPasswordReset(email.trim());
              onSent(email.trim());
              setSent(true);
            });
          }}
        >
          <p className="muted auth-lede">We'll email you a link to set a new password.</p>
          <TextField label="Email" value={email} onChange={setEmail} type="email" inputMode="email" autoComplete="email" autoFocus />
          <button className="btn primary lg block" disabled={!/.+@.+/.test(email) || busy}>
            {busy && <span className="spinner" />} Send reset link
          </button>
        </form>
      )}
    </Frame>
  );
}

function AfterReset({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [temp, setTemp] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, run] = useBusy();
  const problem = pw ? passwordProblem(pw) : null;
  const sameAsTemp = !!pw && pw === temp;
  const ok = /.+@.+\..+/.test(email) && !!temp && !passwordProblem(pw) && pw === pw2 && !sameAsTemp;
  return (
    <Frame onBack={onBack}>
      <h1 className="display auth-title">
        Finish your <em>reset</em>
      </h1>
      <p className="muted auth-lede">
        Log in with the temporary password you typed on the reset page, then choose your real one. Only the real one protects your data, and it never
        leaves this device.
      </p>
      <form
        className="stack-16"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) void run(() => session.loginAfterReset(email.trim(), temp, pw));
        }}
      >
        <TextField label="Email" value={email} onChange={setEmail} type="email" inputMode="email" autoComplete="email" autoFocus={!initialEmail} />
        <TextField label="Temporary password (from the reset page)" value={temp} onChange={setTemp} type="password" autoComplete="off" autoFocus={!!initialEmail} />
        <div className="field">
          <TextField
            label="New password"
            value={pw}
            onChange={setPw}
            type="password"
            autoComplete="new-password"
            error={sameAsTemp ? 'Choose something different from the temporary password.' : problem && pw.length > 3 ? problem : undefined}
          />
          <PasswordMeter value={pw} />
        </div>
        <TextField label="Repeat new password" value={pw2} onChange={setPw2} type="password" autoComplete="new-password" error={pw2 && pw !== pw2 ? 'Passwords do not match.' : undefined} />
        <button className="btn primary lg block" disabled={!ok || busy}>
          {busy ? (
            <>
              <span className="spinner" /> Sealing your keys…
            </>
          ) : (
            'Set new password and log in'
          )}
        </button>
      </form>
    </Frame>
  );
}

// ---------------------------------------------------------------------------

export function RecoveryKeyScreen({ recoveryKey }: { recoveryKey: string }) {
  const [saved, setSaved] = useState(false);
  const [busy, run] = useBusy();
  const groups = recoveryKey.split('-');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      toast('Recovery key copied');
    } catch {
      toast('Copy failed — write it down instead', { kind: 'error' });
    }
  };
  const download = () =>
    void platform().files.save(
      'trazo-recovery-key.txt',
      'text/plain',
      `Trazo recovery key\n\n${recoveryKey}\n\nKeep this somewhere safe and offline. It is the only way to open your data if you forget your password and have no other device logged in.\n`,
    );
  return (
    <Frame>
      <div className="badge-lg">
        <KeyRound size={26} />
      </div>
      <h1 className="display auth-title">
        Your <em>recovery key</em>
      </h1>
      <p className="muted auth-lede">
        If you forget your password and have no other device logged in, this key is the only way back into your data. Nobody else can
        recover it for you.
      </p>
      <div className="rk-grid num" aria-label="Recovery key">
        {groups.map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </div>
      <div className="row" style={{ justifyContent: 'center' }}>
        <button className="btn sm" onClick={copy}>
          <Copy size={15} /> Copy
        </button>
        <button className="btn sm" onClick={download}>
          <Download size={15} /> Save as file
        </button>
      </div>
      <label className="rk-confirm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I've stored my recovery key somewhere safe (a password manager, or on paper).</span>
      </label>
      <button className="btn primary lg block" disabled={!saved || busy} onClick={() => run(() => session.confirmRecoveryKeySaved())}>
        {busy && <span className="spinner" />} Continue
      </button>
    </Frame>
  );
}

export function VerifyEmail() {
  const { email } = useSession();
  const [busy, run] = useBusy();
  useEffect(() => {
    const t = setInterval(() => void session.continueSetup().catch(() => undefined), 6000);
    return () => clearInterval(t);
  }, []);
  return (
    <Frame>
      <div className="badge-lg">
        <Mail size={26} />
      </div>
      <h1 className="display auth-title">
        Check your <em>inbox</em>
      </h1>
      <p className="muted auth-lede">
        We sent a verification link to <b className="text">{email}</b>. Open it, then come back — this screen moves on by itself.
      </p>
      <div className="col">
        <button className="btn primary lg block" disabled={busy} onClick={() => run(() => session.continueSetup())}>
          {busy && <span className="spinner" />} I've verified it
        </button>
        <button
          className="btn block"
          onClick={() =>
            run(async () => {
              await session.resendVerification();
              toast('Sent again');
            })
          }
        >
          Resend the email
        </button>
        <button className="btn ghost block" onClick={() => run(() => session.abandonSetup())}>
          Use a different account
        </button>
      </div>
    </Frame>
  );
}

export function Locked() {
  const { email } = useSession();
  const [rk, setRk] = useState('');
  const [busy, run] = useBusy();
  return (
    <Frame>
      <div className="badge-lg">
        <KeyRound size={26} />
      </div>
      <h1 className="display auth-title">
        Unlock your <em>data</em>
      </h1>
      <p className="muted auth-lede">
        Your password for <b className="text">{email}</b> was reset, so it can't open your sealed data yet. Use one of these:
      </p>
      <div className="unlock-option card pad">
        <h3>Another device</h3>
        <p className="small muted">
          Log in with your new password on a phone or computer where Trazo still has your data. It re-seals your key automatically.
        </p>
        <button className="btn block" disabled={busy} onClick={() => run(() => session.retryUnlock())}>
          {busy && <span className="spinner" />} I did — try again
        </button>
      </div>
      <form
        className="unlock-option card pad stack-12"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => session.unlockWithRecoveryKey(rk));
        }}
      >
        <h3>Recovery key</h3>
        <input className="input mono-input" value={rk} onChange={(e) => setRk(e.target.value)} placeholder="XXXX-XXXX-XXXX-…" autoCapitalize="characters" spellCheck={false} />
        <button className="btn primary block" disabled={rk.replace(/[^0-9a-z]/gi, '').length < 36 || busy}>
          Unlock
        </button>
      </form>
      <div className="col" style={{ marginTop: 6 }}>
        <button
          className="btn ghost block danger-text"
          onClick={async () => {
            const ok = await confirm({
              title: 'Start over?',
              body: 'Your old encrypted data stays unreadable forever and will be deleted from the cloud. You get a new, empty account with the same email.',
              confirmLabel: 'Delete and start over',
              danger: true,
              typeToConfirm: 'DELETE',
            });
            if (ok) await run(() => session.startOver());
          }}
        >
          I have neither — start over
        </button>
        <button className="btn ghost block" onClick={() => run(() => session.abandonSetup())}>
          Cancel
        </button>
      </div>
    </Frame>
  );
}

export function Restoring({ received }: { received: number }) {
  return (
    <div className="auth">
      <div className="auth-inner center-text rise">
        <div className="restore-mark">
          <Mark size={64} animated />
        </div>
        <h1 className="display auth-title">
          Bringing your <em>data</em> home
        </h1>
        <p className="muted">
          Downloading and unsealing{received ? ` · ${received} pieces so far` : '…'}
        </p>
      </div>
    </div>
  );
}

export function Fatal({ message }: { message: string }) {
  return (
    <Frame>
      <h1 className="display auth-title">
        Something <em>broke</em>
      </h1>
      <p className="muted">{message}</p>
      <button className="btn block" onClick={() => location.reload()}>
        Reload
      </button>
      <button
        className="btn ghost block"
        onClick={async () => {
          if (await confirm({ title: 'Reset this device?', body: 'Removes Trazo data from this device only. Cloud data is untouched.', danger: true, confirmLabel: 'Reset' })) {
            await session.logout();
          }
        }}
      >
        Reset this device
      </button>
    </Frame>
  );
}

export function Booting() {
  return (
    <div className="auth">
      <div className="center" style={{ minHeight: '60vh' }}>
        <Mark size={54} animated />
      </div>
    </div>
  );
}

export function SignedOutBanner() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="banner" onClick={() => setOpen(true)}>
        <Lock size={16} /> Sync paused — log in again to keep this device in sync
      </button>
      <KeyRescue open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * Logs this device back in without losing anything it holds. Used when the
 * session expired and when the account's key changed on another device.
 */
export function KeyRescue({ open, onClose, reason }: { open: boolean; onClose: () => void; reason?: 'key-changed' }) {
  const [step, setStep] = useState<'password' | 'locked'>('password');
  const [pw, setPw] = useState('');
  const [rk, setRk] = useState('');
  const [busy, run] = useBusy();
  const close = () => {
    setStep('password');
    setPw('');
    setRk('');
    onClose();
  };
  return (
    <Sheet open={open} onClose={close} title={step === 'password' ? 'Log in again' : 'Keep this device’s data'}>
      {step === 'password' ? (
        <form
          className="stack-16"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await session.reauthenticate(pw);
              if (r === 'locked') {
                setStep('locked');
                return;
              }
              toast(r === 'merged' ? 'This device’s data is now in your account' : 'Syncing again');
              close();
            });
          }}
        >
          <p className="small muted">
            {reason === 'key-changed'
              ? 'Your account’s encryption key was replaced on another device. Log in and this device’s data moves into the new key — nothing here is deleted.'
              : 'Your session ended, maybe because the password changed. Your data on this device is safe; log in to sync again.'}
          </p>
          <TextField label="Password" type="password" value={pw} onChange={setPw} autoComplete="current-password" autoFocus />
          <button className="btn primary lg block" disabled={!pw || busy}>
            {busy && <span className="spinner" />} Log in
          </button>
        </form>
      ) : (
        <div className="stack-16">
          <p className="small muted">
            Your account is now sealed with a key this device doesn’t have, so the two can’t be merged with your password alone. Your data on this device is
            still here.
          </p>
          <form
            className="unlock-option card pad stack-12"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await session.rescueWithRecoveryKey(rk);
                toast('This device’s data is now in your account');
                close();
              });
            }}
          >
            <h3>I have the account’s current recovery key</h3>
            <input className="input mono-input" value={rk} onChange={(e) => setRk(e.target.value)} placeholder="XXXX-XXXX-XXXX-…" autoCapitalize="characters" spellCheck={false} />
            <button className="btn primary block" disabled={rk.replace(/[^0-9a-z]/gi, '').length < 36 || busy}>
              Unlock and merge
            </button>
          </form>
          <div className="unlock-option card pad stack-12">
            <h3>Make this device’s data the account’s data</h3>
            <p className="small muted">The account gets a new key and a new recovery key. Anything in the cloud sealed with the other key is erased.</p>
            <button
              className="btn danger block"
              disabled={busy}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Replace the account’s key?',
                  body: 'Cloud data sealed with the other key is erased and replaced by this device’s data.',
                  confirmLabel: 'Replace',
                  danger: true,
                  typeToConfirm: 'REPLACE',
                });
                if (ok) await run(() => session.rescueByReplacingKey());
              }}
            >
              Use this device’s data
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
