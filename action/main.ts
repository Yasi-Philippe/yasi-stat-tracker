/**
 * Email action page (password reset, email verification, email recovery).
 *
 * Firebase's default page would store the new password as typed. Trazo never
 * gives Firebase the real password: it derives a login secret from it with
 * Argon2id, exactly like the app does, so this page must do the same.
 */

import { initializeApp } from 'firebase/app';
import { applyActionCode, type Auth, checkActionCode, confirmPasswordReset, connectAuthEmulator, getAuth, verifyPasswordResetCode } from 'firebase/auth';
import { passwordProblem, passwordScore } from '../src/core/account/password';
import { deriveLoginSecret } from '../src/core/crypto/keys';
import { installFonts } from '../src/styles/fonts';
import './action.css';

installFonts();

const params = new URLSearchParams(location.search);
const mode = params.get('mode');
const oobCode = params.get('oobCode') ?? '';
const apiKey = params.get('apiKey') ?? (import.meta.env.VITE_FIREBASE_API_KEY as string | undefined) ?? '';
const view = document.getElementById('view')!;

// Firebase starts only when a link actually needs it, so a missing key can
// never leave the page stuck on "Checking your link…".
let authInstance: Auth | null = null;
function firebaseAuth(): Auth {
  if (!authInstance) {
    authInstance = getAuth(initializeApp({ apiKey }));
    const emulator = import.meta.env.VITE_FIREBASE_EMULATOR_HOST as string | undefined;
    if (emulator) connectAuthEmulator(authInstance, `http://${emulator}:9099`, { disableWarnings: true });
  }
  return authInstance;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function show(html: string): void {
  view.innerHTML = html;
}

function done(title: string, body: string): void {
  show(`<h1 class="display">${title}</h1><p class="muted">${body}</p><p class="tiny faint">You can close this page.</p>`);
}

function failed(err: unknown): void {
  const code = (err as { code?: string })?.code ?? '';
  const expired = code === 'auth/expired-action-code' || code === 'auth/invalid-action-code';
  show(
    `<h1 class="display">This link <em>didn't work</em></h1><p class="muted">${
      expired
        ? 'It has expired or was already used. Ask Trazo for a new one: “I forgot my password” on the login screen, or “Resend the email”.'
        : 'Something went wrong. Check your connection and open the link again.'
    }</p>`,
  );
}

async function resetPassword(): Promise<void> {
  let email: string;
  try {
    email = await verifyPasswordResetCode(firebaseAuth(), oobCode);
  } catch (err) {
    failed(err);
    return;
  }
  show(`
    <h1 class="display">Choose a <em>new password</em></h1>
    <p class="muted">For <b>${esc(email)}</b>.</p>
    <form id="f" novalidate>
      <label>New password<input id="p1" type="password" autocomplete="new-password" required /></label>
      <div class="meter" id="meter"><span></span><span></span><span></span><span></span></div>
      <label>Repeat it<input id="p2" type="password" autocomplete="new-password" required /></label>
      <p class="error" id="err" role="alert"></p>
      <button class="btn" id="go" type="submit">Set new password</button>
    </form>
    <p class="tiny faint">Your data is end-to-end encrypted. After logging in with this password, it unlocks by itself on any device that still has it, or with your recovery key.</p>
  `);
  const f = document.getElementById('f') as HTMLFormElement;
  const p1 = document.getElementById('p1') as HTMLInputElement;
  const p2 = document.getElementById('p2') as HTMLInputElement;
  const err = document.getElementById('err')!;
  const go = document.getElementById('go') as HTMLButtonElement;
  const meter = document.getElementById('meter')!;
  p1.focus();
  p1.addEventListener('input', () => {
    meter.dataset.score = String(passwordScore(p1.value));
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const problem = passwordProblem(p1.value);
    err.textContent = problem ?? (p1.value !== p2.value ? 'The passwords do not match.' : '');
    if (err.textContent) return;
    go.disabled = true;
    go.textContent = 'Sealing…';
    try {
      const secret = await deriveLoginSecret(email, p1.value);
      await confirmPasswordReset(firebaseAuth(), oobCode, secret);
      done(
        'Password <em>changed</em>',
        'Go back to Trazo and log in with your new password. Your data unlocks as soon as a device that still has it logs in too, or with your recovery key.',
      );
    } catch (e2) {
      go.disabled = false;
      go.textContent = 'Set new password';
      err.textContent = (e2 as { code?: string })?.code === 'auth/weak-password' ? 'Choose a longer password.' : 'Could not change the password. The link may have expired.';
    }
  });
}

async function verifyEmail(): Promise<void> {
  try {
    await applyActionCode(firebaseAuth(), oobCode);
    done('Email <em>verified</em>', 'Go back to Trazo — it moves on by itself.');
  } catch (err) {
    failed(err);
  }
}

async function recoverEmail(): Promise<void> {
  try {
    const info = await checkActionCode(firebaseAuth(), oobCode);
    await applyActionCode(firebaseAuth(), oobCode);
    done('Email <em>restored</em>', `Your account email is back to <b>${esc(info.data.email ?? '')}</b>. Consider changing your password in Trazo.`);
  } catch (err) {
    failed(err);
  }
}

if (!oobCode || !apiKey) {
  show('<h1 class="display">Nothing to do <em>here</em></h1><p class="muted">Open this page from a link in a Trazo email.</p>');
} else if (mode === 'resetPassword') {
  void resetPassword();
} else if (mode === 'verifyEmail') {
  void verifyEmail();
} else if (mode === 'recoverEmail') {
  void recoverEmail();
} else {
  show('<h1 class="display">Unknown <em>link</em></h1><p class="muted">This link is not something Trazo understands.</p>');
}
