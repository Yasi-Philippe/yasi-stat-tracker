/**
 * Account flows on top of the key hierarchy (see crypto/keys.ts): register,
 * log in on a device, recover after a forgotten password, change password,
 * rotate the recovery key, start over. The server never sees the password or
 * any key that can decrypt data.
 */

import {
  createEnvelope,
  dekMatches,
  derivePasswordKeys,
  generateDek,
  generateRecoveryKey,
  type KeyEnvelope,
  normalizeEmail,
  parseRecoveryKey,
  recoveryKek,
  unwrapDek,
  wrapDek,
} from '../crypto/keys';
import { ARGON2_DEFAULT, type Argon2Params, DecryptError } from '../crypto/primitives';
import type { AccountBackend, AuthUser } from './backend';
import { AccountError } from './errors';
import { passwordProblem } from './password';

export { MIN_PASSWORD_LENGTH, passwordProblem } from './password';

export interface Unlocked {
  user: AuthUser;
  dek: Uint8Array;
  /** True when this device re-sealed the key after a password reset. */
  rewrapped?: boolean;
}

/** Logged in, but the password cannot open the data key (it was reset by email). */
export interface Locked {
  user: AuthUser;
  kek: CryptoKey;
  envelope: KeyEnvelope;
}

export type LoginResult =
  | ({ status: 'ok' } & Unlocked)
  | ({ status: 'locked' } & Locked)
  /** Account exists but its key was never created (sign-up was interrupted). */
  | { status: 'no-keys'; user: AuthUser; kek: CryptoKey };

export class AccountService {
  constructor(
    readonly backend: AccountBackend,
    private readonly kdf: Argon2Params = ARGON2_DEFAULT,
  ) {}

  /** Creates the account and its keys. Returns the recovery key to show once. */
  async register(email: string, password: string): Promise<Unlocked & { recoveryKey: string }> {
    const problem = passwordProblem(password);
    if (problem) throw new AccountError('weak-password', problem);
    const keys = await derivePasswordKeys(email, password, this.kdf);
    const user = await this.backend.createUser(email, keys.loginSecret);
    const { dek, recoveryKey } = await this.createKeys(user.uid, keys.kek, 'create');
    // Not fatal: the user can resend from the verification screen.
    await this.backend.sendVerification().catch(() => undefined);
    return { user, dek, recoveryKey };
  }

  /**
   * Logs in on this device. `localDek` returns a key this device already
   * holds for the account, which lets it re-seal the data key after a
   * password reset without the recovery key.
   */
  async login(email: string, password: string, localDek?: (uid: string) => Promise<Uint8Array | null>): Promise<LoginResult> {
    const keys = await derivePasswordKeys(email, password, this.kdf);
    const user = await this.backend.signIn(email, keys.loginSecret);
    return this.unlock(user, keys, localDek);
  }

  /**
   * Finishes a "forgot password" done on Firebase's own reset page. That page
   * stores the password exactly as typed, so Firebase has seen it: it is only
   * used once, as a temporary password, and is replaced straight away by a
   * login secret derived from a new password Firebase never sees. The data
   * key is then sealed under the new password (by this device if it holds
   * the key, otherwise by another device or the recovery key, as after any
   * reset).
   */
  async loginWithResetPassword(
    email: string,
    temporaryPassword: string,
    newPassword: string,
    localDek?: (uid: string) => Promise<Uint8Array | null>,
  ): Promise<LoginResult> {
    const problem = passwordProblem(newPassword);
    if (problem) throw new AccountError('weak-password', problem);
    if (newPassword === temporaryPassword) {
      throw new AccountError('weak-password', 'Choose a password different from the temporary one: the temporary one passed through Firebase’s page.');
    }
    const user = await this.backend.signIn(email, temporaryPassword);
    const keys = await derivePasswordKeys(email, newPassword, this.kdf);
    await this.backend.changeLoginSecret(email, temporaryPassword, keys.loginSecret);
    return this.unlock(user, keys, localDek);
  }

  private async unlock(user: AuthUser, keys: { kek: CryptoKey }, localDek?: (uid: string) => Promise<Uint8Array | null>): Promise<LoginResult> {
    const envelope = await this.backend.getEnvelope(user.uid);
    if (!envelope) return { status: 'no-keys', user, kek: keys.kek };
    try {
      const dek = await unwrapDek(keys.kek, envelope.pw, 'pw');
      return { status: 'ok', user, dek };
    } catch (err) {
      if (!(err instanceof DecryptError)) throw err;
    }
    // The password changed through "forgot password". Any device that still
    // holds the data key can seal it under the new password.
    const local = localDek ? await localDek(user.uid) : null;
    if (local && (await dekMatches(local, envelope))) {
      await this.backend.updateEnvelope(user.uid, { ...envelope, pw: await wrapDek(keys.kek, local, 'pw') });
      return { status: 'ok', user, dek: local, rewrapped: true };
    }
    return { status: 'locked', user, kek: keys.kek, envelope };
  }

  /** Opens a locked account with the recovery key and seals it under the current password. */
  async unlockWithRecoveryKey(locked: Locked, recoveryKeyText: string): Promise<Unlocked> {
    const bytes = await parseRecoveryKey(recoveryKeyText).catch((e: Error) => {
      throw new AccountError('wrong-recovery-key', e.message);
    });
    let dek: Uint8Array;
    try {
      dek = await unwrapDek(await recoveryKek(bytes), locked.envelope.rk, 'rk');
    } catch {
      throw new AccountError('wrong-recovery-key', 'That recovery key does not belong to this account.');
    }
    await this.backend.updateEnvelope(locked.user.uid, { ...locked.envelope, pw: await wrapDek(locked.kek, dek, 'pw') });
    return { user: locked.user, dek, rewrapped: true };
  }

  /** Tries again after another device may have re-sealed the key for the new password. */
  async retryUnlock(locked: Locked): Promise<Unlocked | null> {
    const envelope = await this.backend.getEnvelope(locked.user.uid);
    if (!envelope) return null;
    try {
      const dek = await unwrapDek(locked.kek, envelope.pw, 'pw');
      return { user: locked.user, dek };
    } catch (err) {
      if (!(err instanceof DecryptError)) throw err;
      locked.envelope = envelope;
      return null;
    }
  }

  /** For an account whose keys were never created: creates them now. */
  async completeSetup(user: AuthUser, kek: CryptoKey): Promise<Unlocked & { recoveryKey: string }> {
    const { dek, recoveryKey } = await this.createKeys(user.uid, kek, 'create');
    return { user, dek, recoveryKey };
  }

  /**
   * Abandons the old data key (when no device and no recovery key can open
   * it) and creates a new empty one. The caller purges old cloud chunks.
   */
  async startOver(locked: Locked): Promise<Unlocked & { recoveryKey: string }> {
    const { dek, recoveryKey } = await this.createKeys(locked.user.uid, locked.kek, 'update');
    return { user: locked.user, dek, recoveryKey };
  }

  private async createKeys(uid: string, kek: CryptoKey, mode: 'create' | 'update') {
    const dek = generateDek();
    const rk = await generateRecoveryKey();
    const env = await createEnvelope(dek, kek, rk.bytes, this.kdf);
    if (mode === 'create') await this.backend.createEnvelope(uid, env);
    else await this.backend.updateEnvelope(uid, env);
    return { dek, recoveryKey: rk.display };
  }

  async changePassword(email: string, oldPassword: string, newPassword: string, dek: Uint8Array): Promise<void> {
    const problem = passwordProblem(newPassword);
    if (problem) throw new AccountError('weak-password', problem);
    const user = this.backend.currentUser();
    if (!user) throw new AccountError('signed-out', 'You are signed out.');
    const [oldK, newK] = await Promise.all([
      derivePasswordKeys(email, oldPassword, this.kdf),
      derivePasswordKeys(email, newPassword, this.kdf),
    ]);
    const envelope = await this.backend.getEnvelope(user.uid);
    if (!envelope || !(await dekMatches(dek, envelope))) {
      throw new AccountError('corrupt', 'This device holds a different key than the account. Log out and in again.');
    }
    // Password first: if sealing fails afterwards, this device still holds the
    // key and re-seals it at the next login.
    await this.backend.changeLoginSecret(email, oldK.loginSecret, newK.loginSecret);
    await this.backend.updateEnvelope(user.uid, { ...envelope, pw: await wrapDek(newK.kek, dek, 'pw') });
  }

  /** Replaces the recovery key; the old one stops working. */
  async regenerateRecoveryKey(dek: Uint8Array): Promise<string> {
    const user = this.backend.currentUser();
    if (!user) throw new AccountError('signed-out', 'You are signed out.');
    const envelope = await this.backend.getEnvelope(user.uid);
    if (!envelope || !(await dekMatches(dek, envelope))) {
      throw new AccountError('corrupt', 'This device holds a different key than the account.');
    }
    const rk = await generateRecoveryKey();
    await this.backend.updateEnvelope(user.uid, { ...envelope, rk: await wrapDek(await recoveryKek(rk.bytes), dek, 'rk') });
    return rk.display;
  }

  /** Checks whether the key this device holds is still the account's key. */
  async keyStillValid(uid: string, dek: Uint8Array): Promise<'valid' | 'changed' | 'missing'> {
    const envelope = await this.backend.getEnvelope(uid);
    if (!envelope) return 'missing';
    return (await dekMatches(dek, envelope)) ? 'valid' : 'changed';
  }

  sendPasswordReset(email: string): Promise<void> {
    return this.backend.sendPasswordReset(normalizeEmail(email));
  }
}
