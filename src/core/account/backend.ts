/**
 * The identity + key-envelope backend the account service relies on.
 * Production uses Firebase Auth and Firestore; tests can use a fake.
 */

import {
  type Auth,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
} from 'firebase/auth';
import { doc, type Firestore, getDocFromServer, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { isKeyEnvelope, type KeyEnvelope, normalizeEmail } from '../crypto/keys';
import { guard } from '../sync/firestoreRemote';
import { AccountError, toAccountError } from './errors';

export interface AuthUser {
  uid: string;
  email: string;
  emailVerified: boolean;
}

export interface AccountBackend {
  currentUser(): AuthUser | null;
  onAuthChange(cb: (user: AuthUser | null) => void): () => void;
  createUser(email: string, loginSecret: string): Promise<AuthUser>;
  signIn(email: string, loginSecret: string): Promise<AuthUser>;
  signOut(): Promise<void>;
  sendVerification(): Promise<void>;
  /** Re-reads the user from the server (e.g. to see a fresh verification). */
  refreshUser(): Promise<AuthUser | null>;
  sendPasswordReset(email: string): Promise<void>;
  /** Re-authenticates with the old secret, then sets the new one. */
  changeLoginSecret(email: string, oldSecret: string, newSecret: string): Promise<void>;
  getEnvelope(uid: string): Promise<KeyEnvelope | null>;
  createEnvelope(uid: string, env: KeyEnvelope): Promise<void>;
  updateEnvelope(uid: string, env: KeyEnvelope): Promise<void>;
}

export class FirebaseAccountBackend implements AccountBackend {
  constructor(
    private readonly auth: Auth,
    private readonly db: Firestore,
  ) {}

  private toUser(): AuthUser | null {
    const u = this.auth.currentUser;
    return u ? { uid: u.uid, email: u.email ?? '', emailVerified: u.emailVerified } : null;
  }

  currentUser(): AuthUser | null {
    return this.toUser();
  }

  onAuthChange(cb: (user: AuthUser | null) => void): () => void {
    return onAuthStateChanged(this.auth, () => cb(this.toUser()));
  }

  async createUser(email: string, loginSecret: string): Promise<AuthUser> {
    await wrap(() => createUserWithEmailAndPassword(this.auth, normalizeEmail(email), loginSecret));
    return this.toUser()!;
  }

  async signIn(email: string, loginSecret: string): Promise<AuthUser> {
    await wrap(() => signInWithEmailAndPassword(this.auth, normalizeEmail(email), loginSecret));
    return this.toUser()!;
  }

  async signOut(): Promise<void> {
    await signOut(this.auth);
  }

  async sendVerification(): Promise<void> {
    const u = this.auth.currentUser;
    if (u) await wrap(() => sendEmailVerification(u));
  }

  async refreshUser(): Promise<AuthUser | null> {
    const u = this.auth.currentUser;
    if (!u) return null;
    await wrap(() => reload(u));
    // A fresh ID token carries the new email_verified claim to Firestore rules.
    await wrap(() => u.getIdToken(true));
    return this.toUser();
  }

  async sendPasswordReset(email: string): Promise<void> {
    await wrap(() => sendPasswordResetEmail(this.auth, normalizeEmail(email)));
  }

  async changeLoginSecret(email: string, oldSecret: string, newSecret: string): Promise<void> {
    const u = this.auth.currentUser;
    if (!u) throw new AccountError('signed-out', 'You are signed out.');
    await wrap(() => reauthenticateWithCredential(u, EmailAuthProvider.credential(normalizeEmail(email), oldSecret)));
    await wrap(() => updatePassword(u, newSecret));
  }

  async getEnvelope(uid: string): Promise<KeyEnvelope | null> {
    const snap = await wrap(() => guard(() => getDocFromServer(doc(this.db, 'users', uid))));
    if (!snap.exists()) return null;
    const { createdAt: _c, updatedAt: _u, ...rest } = snap.data();
    if (!isKeyEnvelope(rest)) throw new AccountError('corrupt', 'The account key record is damaged.');
    return rest;
  }

  async createEnvelope(uid: string, env: KeyEnvelope): Promise<void> {
    await wrap(() =>
      guard(() => setDoc(doc(this.db, 'users', uid), { ...env, createdAt: serverTimestamp(), updatedAt: serverTimestamp() })),
    );
  }

  async updateEnvelope(uid: string, env: KeyEnvelope): Promise<void> {
    await wrap(() =>
      guard(() =>
        updateDoc(doc(this.db, 'users', uid), {
          v: env.v,
          kdf: env.kdf,
          dekId: env.dekId,
          pw: env.pw,
          rk: env.rk,
          updatedAt: serverTimestamp(),
        }),
      ),
    );
  }
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toAccountError(err);
  }
}
