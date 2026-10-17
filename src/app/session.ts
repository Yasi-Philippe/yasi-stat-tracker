/**
 * The app session: which screen of the account flow we are on, the open
 * vault, sync, reminders. A small observable the React tree subscribes to.
 */

import { AccountService, type Locked, type LoginResult } from '@/core/account/account';
import { type AccountBackend, FirebaseAccountBackend } from '@/core/account/backend';
import { AccountError, toAccountError } from '@/core/account/errors';
import { deriveDataKeys, dekIdOf, generateDek } from '@/core/crypto/keys';
import { seedDemo } from '@/core/data/demo';
import { entrySeries, metrics } from '@/core/data/repo';
import { firebase, readFirebaseEnv } from '@/core/firebase/client';
import { todayDayNum } from '@/core/model/dates';
import { planReminders } from '@/core/reminders';
import { FirestoreRemote } from '@/core/sync/firestoreRemote';
import { SyncEngine, type SyncStatus } from '@/core/sync/syncEngine';
import { LocalStore } from '@/core/vault/localStore';
import { Vault } from '@/core/vault/vault';
import { platform } from '@/platform';
import { deleteUser } from 'firebase/auth';
import { deleteDoc, doc, type Firestore } from 'firebase/firestore';

export type Phase =
  | { name: 'booting' }
  | { name: 'welcome' }
  | { name: 'recovery-key'; recoveryKey: string }
  | { name: 'verify-email' }
  | { name: 'locked' }
  | { name: 'restoring'; received: number }
  | { name: 'ready' }
  | { name: 'fatal'; message: string };

interface Profile {
  mode: 'account' | 'demo';
  uid?: string;
  email?: string;
  /** 'setup' until the email is verified. */
  stage?: 'setup' | 'active';
}

const PROFILE_KEY = 'trazo.profile';
const DEMO_DB = 'trazo-demo';

function loadProfile(): Profile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as Profile) : null;
  } catch {
    return null;
  }
}

function saveProfile(p: Profile | null): void {
  if (p) localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
  else localStorage.removeItem(PROFILE_KEY);
}

export interface SessionSnapshot {
  phase: Phase;
  mode: 'account' | 'demo' | null;
  email: string | null;
  uid: string | null;
  /** Firebase is configured in this build. */
  cloud: boolean;
  /** For account mode: whether Firebase currently has us signed in. */
  signedIn: boolean;
  sync: SyncStatus | null;
  /** The account's key no longer matches this device (reset elsewhere). */
  keyMismatch: boolean;
}

export class Session {
  private listeners = new Set<() => void>();
  private snap: SessionSnapshot;
  vault: Vault | null = null;
  readonly account: AccountService | null;
  private readonly backend: AccountBackend | null;
  private readonly db: Firestore | null;
  private sync: SyncEngine | null = null;
  private profile: Profile | null = null;
  private dek: Uint8Array | null = null;
  private locked: Locked | null = null;
  /** Set when re-authentication found the account sealed with a key this device can't open. */
  private rescueLocked: Locked | null = null;
  private afterRecoveryKey: (() => Promise<void>) | null = null;
  private stopAuth: (() => void) | null = null;
  private stopSyncStatus: (() => void) | null = null;
  private stopReminders: (() => void) | null = null;

  constructor() {
    const env = readFirebaseEnv();
    if (env) {
      const h = firebase(env);
      this.backend = new FirebaseAccountBackend(h.auth, h.db);
      this.account = new AccountService(this.backend);
      this.db = h.db;
    } else {
      this.backend = null;
      this.account = null;
      this.db = null;
    }
    this.snap = {
      phase: { name: 'booting' },
      mode: null,
      email: null,
      uid: null,
      cloud: !!env,
      signedIn: false,
      sync: null,
      keyMismatch: false,
    };
  }

  // -------------------------------------------------------------------------
  // Observable
  // -------------------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): SessionSnapshot => this.snap;

  private patch(p: Partial<SessionSnapshot>): void {
    this.snap = { ...this.snap, ...p };
    for (const l of this.listeners) l();
  }

  private go(phase: Phase): void {
    this.patch({ phase });
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async boot(): Promise<void> {
    try {
      const profile = loadProfile();
      const secrets = platform().secrets;
      if (profile?.mode === 'demo') {
        const dek = await secrets.get('dek:demo');
        if (dek) {
          this.profile = profile;
          await this.openVault(DEMO_DB, dek);
          this.patch({ mode: 'demo', email: null });
          this.go({ name: 'ready' });
          this.startReminders();
          return;
        }
      }
      if (profile?.mode === 'account' && profile.uid && this.backend) {
        const dek = await secrets.get(`dek:${profile.uid}`);
        if (dek) {
          this.profile = profile;
          await this.openVault(this.dbName(profile.uid), dek);
          this.patch({ mode: 'account', email: profile.email ?? null, uid: profile.uid });
          this.watchAuth();
          if (profile.stage === 'active') {
            this.go({ name: 'ready' });
            this.startReminders();
          } else {
            await this.continueSetup();
          }
          return;
        }
      }
      saveProfile(null);
      this.go({ name: 'welcome' });
    } catch (err) {
      this.go({ name: 'fatal', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private dbName(uid: string): string {
    return `trazo-${uid}`;
  }

  private async openVault(name: string, dek: Uint8Array): Promise<void> {
    if (this.vault) await this.vault.close();
    this.dek = dek;
    this.vault = await Vault.open(new LocalStore(name), await deriveDataKeys(dek));
  }

  private requireAccount(): AccountService {
    if (!this.account) throw new AccountError('not-configured', 'Cloud accounts are not configured in this build.');
    return this.account;
  }

  // -------------------------------------------------------------------------
  // Account flows
  // -------------------------------------------------------------------------

  async register(email: string, password: string): Promise<void> {
    const r = await this.requireAccount().register(email, password);
    await this.adopt(r.user.uid, r.user.email || email, r.dek, 'setup');
    this.afterRecoveryKey = () => this.continueSetup();
    this.go({ name: 'recovery-key', recoveryKey: r.recoveryKey });
  }

  async login(email: string, password: string): Promise<void> {
    const secrets = platform().secrets;
    const r = await this.requireAccount().login(email, password, (uid) => secrets.get(`dek:${uid}`));
    await this.afterLogin(r, email);
  }

  /** Logs in with the temporary password set on Firebase's reset page and switches to a new one. */
  async loginAfterReset(email: string, temporaryPassword: string, newPassword: string): Promise<void> {
    const secrets = platform().secrets;
    const r = await this.requireAccount().loginWithResetPassword(email, temporaryPassword, newPassword, (uid) => secrets.get(`dek:${uid}`));
    await this.afterLogin(r, email);
  }

  private async afterLogin(r: LoginResult, email: string): Promise<void> {
    const account = this.requireAccount();
    if (r.status === 'ok') {
      await this.adopt(r.user.uid, r.user.email || email, r.dek, 'setup');
      await this.continueSetup();
    } else if (r.status === 'locked') {
      this.locked = r;
      this.patch({ email: r.user.email || email, uid: r.user.uid });
      this.go({ name: 'locked' });
    } else {
      const s = await account.completeSetup(r.user, r.kek);
      await this.adopt(r.user.uid, r.user.email || email, s.dek, 'setup');
      this.afterRecoveryKey = () => this.continueSetup();
      this.go({ name: 'recovery-key', recoveryKey: s.recoveryKey });
    }
  }

  /** Stores the key on this device and opens the account's local vault. */
  private async adopt(uid: string, email: string, dek: Uint8Array, stage: Profile['stage']): Promise<void> {
    await platform().secrets.set(`dek:${uid}`, dek);
    this.profile = { mode: 'account', uid, email, stage };
    saveProfile(this.profile);
    await this.openVault(this.dbName(uid), dek);
    this.patch({ mode: 'account', email, uid });
    this.watchAuth();
  }

  async confirmRecoveryKeySaved(): Promise<void> {
    const next = this.afterRecoveryKey;
    this.afterRecoveryKey = null;
    if (next) await next();
    else this.go({ name: 'ready' });
  }

  /** Verification → first sync → ready. */
  async continueSetup(): Promise<void> {
    if (!this.backend || !this.profile?.uid) return;
    let user = this.backend.currentUser();
    try {
      user = (await this.backend.refreshUser()) ?? user;
    } catch {
      // Offline: fall through with what we know.
    }
    if (!user) {
      // Session gone (e.g. app restarted offline before setup finished).
      this.go({ name: 'verify-email' });
      return;
    }
    if (!user.emailVerified) {
      this.go({ name: 'verify-email' });
      return;
    }
    this.profile = { ...this.profile, stage: 'active' };
    saveProfile(this.profile);
    await this.firstSync();
  }

  async resendVerification(): Promise<void> {
    await this.backend?.sendVerification();
  }

  private async firstSync(): Promise<void> {
    const vault = this.vault!;
    const fresh = vault.size === 0;
    if (fresh) this.go({ name: 'restoring', received: 0 });
    const sync = this.ensureSync();
    const unsub = sync.subscribe((s) => {
      if (fresh && s.progress !== null) this.go({ name: 'restoring', received: s.progress });
    });
    await sync.syncNow();
    unsub();
    sync.start();
    this.go({ name: 'ready' });
    this.startReminders();
  }

  private ensureSync(): SyncEngine {
    if (this.sync) return this.sync;
    const sync = new SyncEngine(this.vault!, new FirestoreRemote(this.db!, this.profile!.uid!));
    this.sync = sync;
    this.stopSyncStatus = sync.subscribe((s) => this.patch({ sync: s }));
    this.patch({ sync: sync.getStatus() });
    return sync;
  }

  private watchAuth(): void {
    if (this.stopAuth || !this.backend) return;
    this.stopAuth = this.backend.onAuthChange((user) => {
      const mine = !!user && user.uid === this.profile?.uid;
      this.patch({ signedIn: mine });
      if (!mine) {
        this.sync?.stop();
        return;
      }
      if (this.profile?.stage === 'active' && this.snap.phase.name === 'ready') {
        void this.checkKeyThenSync();
      }
    });
  }

  private async checkKeyThenSync(): Promise<void> {
    try {
      const state = await this.requireAccount().keyStillValid(this.profile!.uid!, this.dek!);
      if (state === 'changed') {
        this.patch({ keyMismatch: true });
        return;
      }
    } catch {
      // Offline: sync will report it.
    }
    this.ensureSync().start();
  }

  /** Signs in again on this device after the session expired (e.g. password changed elsewhere). */
  /**
   * Signs in again on this device (session expired, password changed, or the
   * account's key replaced elsewhere) without ever dropping local data:
   * - same key: sync resumes;
   * - the account has a new key this password opens: local data moves into it;
   * - the account's key can't be opened: 'locked', and the UI offers the
   *   recovery key or making this device's key the account's key.
   */
  async reauthenticate(password: string): Promise<'resumed' | 'merged' | 'locked'> {
    const account = this.requireAccount();
    const p = this.profile!;
    const r = await account.login(p.email!, password, async () => this.dek);
    if (r.user.uid !== p.uid) throw new AccountError('other', 'That is a different account.');
    if (r.status === 'ok') {
      if ((await dekIdOf(r.dek)) === this.vault!.keys.dekId) {
        this.patch({ keyMismatch: false });
        void this.checkKeyThenSync();
        return 'resumed';
      }
      await this.moveIntoKey(r.dek);
      return 'merged';
    }
    if (r.status === 'no-keys') {
      const s = await account.completeSetup(r.user, r.kek);
      await this.moveIntoKey(s.dek, s.recoveryKey);
      return 'merged';
    }
    this.rescueLocked = r;
    return 'locked';
  }

  /** After reauthenticate() said 'locked': open the account's current key with its recovery key. */
  async rescueWithRecoveryKey(text: string): Promise<void> {
    if (!this.rescueLocked) throw new AccountError('other', 'Log in again first.');
    const r = await this.requireAccount().unlockWithRecoveryKey(this.rescueLocked, text);
    this.rescueLocked = null;
    await this.moveIntoKey(r.dek);
  }

  /**
   * After reauthenticate() said 'locked': give the account a fresh key and
   * this device's data. Cloud data sealed with the unreachable key is erased.
   */
  async rescueByReplacingKey(): Promise<void> {
    if (!this.rescueLocked) throw new AccountError('other', 'Log in again first.');
    const s = await this.requireAccount().startOver(this.rescueLocked);
    this.rescueLocked = null;
    await new FirestoreRemote(this.db!, s.user.uid).purgeForeign((await deriveDataKeys(s.dek)).dekId).catch(() => 0);
    await this.moveIntoKey(s.dek, s.recoveryKey);
  }

  /**
   * Re-encrypts everything this device holds under another data key, in an
   * order that survives a crash at any point: the new copy is written next to
   * the old one, the stored key switches only once that copy is on disk, and
   * the old chunks go last.
   */
  private async moveIntoKey(newDek: Uint8Array, recoveryKey?: string): Promise<void> {
    const p = this.profile!;
    const old = this.vault!;
    const records = old.allRecords();
    await old.flush();
    this.sync?.stop();
    this.stopSyncStatus?.();
    this.sync = null;
    this.stopReminders?.();
    const store = new LocalStore(this.dbName(p.uid!));
    const next = await Vault.open(store, await deriveDataKeys(newDek), { keepForeign: true });
    next.importRecords(records);
    await next.flush();
    await store.setMeta('sync.cursor', 0);
    await platform().secrets.set(`dek:${p.uid}`, newDek);
    await store.deleteForeign(next.keys.dekId);
    await old.close();
    this.vault = next;
    this.dek = newDek;
    this.patch({ keyMismatch: false });
    if (recoveryKey) {
      this.afterRecoveryKey = () => this.firstSync();
      this.go({ name: 'recovery-key', recoveryKey });
    } else {
      this.go({ name: 'restoring', received: 0 });
      await this.firstSync();
    }
  }

  async retryUnlock(): Promise<void> {
    if (!this.locked) throw new AccountError('other', 'Nothing to unlock.');
    const r = await this.requireAccount().retryUnlock(this.locked);
    if (!r) throw new AccountError('other', 'Still locked. Log in on your other device first, or use your recovery key.');
    this.locked = null;
    await this.adopt(r.user.uid, r.user.email || this.snap.email || '', r.dek, 'setup');
    await this.continueSetup();
  }

  async unlockWithRecoveryKey(text: string): Promise<void> {
    if (!this.locked) throw new AccountError('other', 'Nothing to unlock.');
    const r = await this.requireAccount().unlockWithRecoveryKey(this.locked, text);
    this.locked = null;
    await this.adopt(r.user.uid, r.user.email || this.snap.email || '', r.dek, 'setup');
    await this.continueSetup();
  }

  /** Abandons unrecoverable cloud data and starts with a fresh key. */
  async startOver(): Promise<void> {
    if (!this.locked) throw new AccountError('other', 'Nothing to reset.');
    const r = await this.requireAccount().startOver(this.locked);
    this.locked = null;
    await new FirestoreRemote(this.db!, r.user.uid).purgeForeign((await deriveDataKeys(r.dek)).dekId).catch(() => 0);
    await new LocalStore(this.dbName(r.user.uid)).destroy().catch(() => undefined);
    await this.adopt(r.user.uid, r.user.email || this.snap.email || '', r.dek, 'setup');
    this.afterRecoveryKey = () => this.continueSetup();
    this.go({ name: 'recovery-key', recoveryKey: r.recoveryKey });
  }

  async sendPasswordReset(email: string): Promise<void> {
    await this.requireAccount().sendPasswordReset(email);
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.requireAccount().changePassword(this.profile!.email!, oldPassword, newPassword, this.dek!);
  }

  async newRecoveryKey(): Promise<string> {
    return this.requireAccount().regenerateRecoveryKey(this.dek!);
  }

  async syncNow(): Promise<void> {
    await this.sync?.syncNow();
  }

  /**
   * Deletes the account: every encrypted chunk, the key envelope and the
   * login, then this device's copy. Other devices lose sync access.
   */
  async deleteAccount(password: string): Promise<void> {
    const account = this.requireAccount();
    const p = this.profile;
    if (!p?.uid || !p.email || !this.db) throw new AccountError('signed-out', 'You are signed out.');
    // Re-authenticate first: deleting a login requires a recent sign-in.
    const r = await account.login(p.email, password, async () => this.dek);
    if (r.status !== 'ok' || r.user.uid !== p.uid) throw new AccountError('wrong-credentials', 'Password is incorrect.');
    this.sync?.stop();
    await new FirestoreRemote(this.db, p.uid).purgeForeign('__none__');
    await deleteDoc(doc(this.db, 'users', p.uid));
    const fbUser = firebaseCurrentUser();
    if (fbUser) await deleteUser(fbUser);
    await this.logout();
  }

  /** Data needed to write an encrypted backup file. */
  async backupMaterial() {
    if (!this.backend || !this.profile?.uid || !this.dek) return null;
    const envelope = await this.backend.getEnvelope(this.profile.uid);
    return envelope ? { envelope, email: this.profile.email!, dek: this.dek } : null;
  }

  // -------------------------------------------------------------------------
  // Demo
  // -------------------------------------------------------------------------

  async startDemo(): Promise<void> {
    const dek = generateDek();
    await platform().secrets.set('dek:demo', dek);
    await new LocalStore(DEMO_DB).destroy().catch(() => undefined);
    this.profile = { mode: 'demo' };
    saveProfile(this.profile);
    await this.openVault(DEMO_DB, dek);
    seedDemo(this.vault!, todayDayNum());
    await this.vault!.flush();
    this.patch({ mode: 'demo', email: null });
    this.go({ name: 'ready' });
  }

  // -------------------------------------------------------------------------
  // Leaving
  // -------------------------------------------------------------------------

  /** Removes everything from this device. Cloud data stays (for accounts). */
  async logout(): Promise<void> {
    const p = this.profile;
    try {
      if (this.sync && this.snap.signedIn) await this.sync.syncNow();
    } catch {
      // Best effort.
    }
    this.sync?.stop();
    this.stopSyncStatus?.();
    this.stopReminders?.();
    this.stopAuth?.();
    this.sync = null;
    this.stopAuth = null;
    await this.vault?.close();
    this.vault = null;
    this.dek = null;
    const name = p?.mode === 'demo' ? DEMO_DB : p?.uid ? this.dbName(p.uid) : null;
    if (name) await new LocalStore(name).destroy().catch(() => undefined);
    const secret = p?.mode === 'demo' ? 'dek:demo' : p?.uid ? `dek:${p.uid}` : null;
    if (secret) await platform().secrets.delete(secret).catch(() => undefined);
    await platform().notifier.replaceAll([]).catch(() => undefined);
    if (p?.mode === 'account') await this.backend?.signOut().catch(() => undefined);
    this.profile = null;
    saveProfile(null);
    this.patch({ mode: null, email: null, uid: null, signedIn: false, sync: null, keyMismatch: false });
    this.go({ name: 'welcome' });
  }

  /** Cancels an unfinished sign-up or login on this device. */
  async abandonSetup(): Promise<void> {
    await this.logout();
  }

  // -------------------------------------------------------------------------
  // Reminders
  // -------------------------------------------------------------------------

  private startReminders(): void {
    if (this.stopReminders || !this.vault) return;
    const vault = this.vault;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      timer = null;
      void this.scheduleReminders(vault);
    };
    const unsub = vault.subscribe(() => {
      if (!timer) timer = setTimeout(run, 2000);
    });
    run();
    this.stopReminders = () => {
      unsub();
      if (timer) clearTimeout(timer);
      this.stopReminders = null;
    };
  }

  async scheduleReminders(vault: Vault | null = this.vault): Promise<number> {
    if (!vault) return 0;
    const notifier = platform().notifier;
    if (!notifier.canSchedule) return 0;
    const list = metrics(vault);
    const plan = planReminders(list, (m, day) => {
      const s = entrySeries(vault, m.id);
      return s.t.length > 0 && s.t[s.t.length - 1] === day;
    });
    if (plan.length && (await notifier.permission()) !== 'granted') return 0;
    await notifier.replaceAll(plan).catch(() => undefined);
    return plan.length;
  }
}

export { toAccountError };

function firebaseCurrentUser() {
  const env = readFirebaseEnv();
  return env ? firebase(env).auth.currentUser : null;
}

export const session = new Session();
