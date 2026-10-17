/**
 * End-to-end account lifecycle against the local Firebase emulators
 * (Auth + Firestore with the real security rules). Run: npm run test:emulator
 */

import { applyActionCode, confirmPasswordReset } from 'firebase/auth';
import { collection, doc, getDoc, getDocsFromServer, setDoc } from 'firebase/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import { AccountService, type Locked } from '@/core/account/account';
import { FirebaseAccountBackend } from '@/core/account/backend';
import { deriveDataKeys, deriveLoginSecret } from '@/core/crypto/keys';
import { firebase, type FirebaseEnv } from '@/core/firebase/client';
import { FirestoreRemote } from '@/core/sync/firestoreRemote';
import { SyncEngine } from '@/core/sync/syncEngine';
import { LocalStore } from '@/core/vault/localStore';
import { entryKey } from '@/core/vault/records';
import { Vault } from '@/core/vault/vault';

const HOST = '127.0.0.1';
const PROJECT = 'demo-trazo';
const env: FirebaseEnv = { options: { apiKey: 'demo-key', projectId: PROJECT, authDomain: 'localhost' }, emulatorHost: HOST };
const FAST = { m: 256, t: 1, p: 1 };

const EMAIL = 'owner@example.com';
const PW1 = 'first password 123';
const PW2 = 'second password 456';
const PW3 = 'third password 789';

function makeDevice(name: string) {
  const h = firebase(env, { name, persistence: 'memory' });
  const backend = new FirebaseAccountBackend(h.auth, h.db);
  return { name, h, backend, account: new AccountService(backend, FAST) };
}

async function openVault(dek: Uint8Array) {
  return Vault.open(new LocalStore(`emu-${Math.random()}`), await deriveDataKeys(dek), { persistDelayMs: 5 });
}

async function oobCode(email: string, type: 'VERIFY_EMAIL' | 'PASSWORD_RESET'): Promise<string> {
  const res = await fetch(`http://${HOST}:9099/emulator/v1/projects/${PROJECT}/oobCodes`);
  const { oobCodes } = (await res.json()) as { oobCodes: Array<{ email: string; requestType: string; oobCode: string }> };
  const codes = oobCodes.filter((c) => c.email === email && c.requestType === type);
  return codes[codes.length - 1]!.oobCode;
}

beforeAll(async () => {
  await fetch(`http://${HOST}:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fetch(`http://${HOST}:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
});

describe('account lifecycle', () => {
  const phone = makeDevice('phone');
  const laptop = makeDevice('laptop');
  let uid = '';
  let dek: Uint8Array;
  let recoveryKey = '';

  it('registers: creates the account and an envelope with no secrets in it', async () => {
    const r = await phone.account.register(EMAIL, PW1);
    uid = r.user.uid;
    dek = r.dek;
    recoveryKey = r.recoveryKey;
    expect(r.user.emailVerified).toBe(false);
    const env = await phone.backend.getEnvelope(uid);
    expect(env!.dekId).toBeTruthy();
    expect(JSON.stringify(env)).not.toContain(PW1);
  });

  it('refuses weak passwords before contacting the server', async () => {
    await expect(phone.account.register('x@example.com', 'short')).rejects.toMatchObject({ code: 'weak-password' });
  });

  it('blocks cloud data until the email is verified, then anyone verified can sync', async () => {
    const vault = await openVault(dek);
    vault.put('m/w', { name: 'Weight' });
    const sync = new SyncEngine(vault, new FirestoreRemote(phone.h.db, uid));
    await sync.syncNow();
    expect(sync.getStatus().errorKind).toBe('denied');

    await applyActionCode(phone.h.auth, await oobCode(EMAIL, 'VERIFY_EMAIL'));
    expect((await phone.backend.refreshUser())!.emailVerified).toBe(true);

    for (let d = 1; d <= 20; d++) vault.put(entryKey('w', `2024-05-${String(d).padStart(2, '0')}`), { v: 70 + d / 10 });
    await sync.syncNow();
    expect(sync.getStatus().state).toBe('idle');
    expect(vault.hasPendingChanges).toBe(false);
    await vault.close();
  });

  it('logs in on a second device and restores everything', async () => {
    const r = await laptop.account.login(EMAIL, PW1);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const vault = await openVault(r.dek);
    await new SyncEngine(vault, new FirestoreRemote(laptop.h.db, uid)).syncNow();
    expect(vault.get('m/w')).toEqual({ name: 'Weight' });
    expect(vault.list('e/w/')).toHaveLength(20);
    await vault.close();
  });

  it('rejects a wrong password', async () => {
    await expect(laptop.account.login(EMAIL, 'not the password')).rejects.toMatchObject({ code: 'wrong-credentials' });
  });

  it('forgot password: the reset link sets a new login, and a device holding the key re-seals it', async () => {
    await phone.account.sendPasswordReset(EMAIL);
    // What the reset page does: derive the login secret from the new password.
    await confirmPasswordReset(laptop.h.auth, await oobCode(EMAIL, 'PASSWORD_RESET'), await deriveLoginSecret(EMAIL, PW2, FAST));

    await expect(laptop.account.login(EMAIL, PW1)).rejects.toMatchObject({ code: 'wrong-credentials' });
    const lockedLogin = await laptop.account.login(EMAIL, PW2);
    expect(lockedLogin.status).toBe('locked');

    // The phone still holds the data key locally: logging in there fixes it for everyone.
    const phoneLogin = await phone.account.login(EMAIL, PW2, async (id) => (id === uid ? dek : null));
    expect(phoneLogin.status).toBe('ok');
    expect(phoneLogin.status === 'ok' && phoneLogin.rewrapped).toBe(true);

    const again = await laptop.account.login(EMAIL, PW2);
    expect(again.status).toBe('ok');
  });

  it('forgot password with no other device: the recovery key unlocks', async () => {
    await phone.account.sendPasswordReset(EMAIL);
    await confirmPasswordReset(laptop.h.auth, await oobCode(EMAIL, 'PASSWORD_RESET'), await deriveLoginSecret(EMAIL, PW3, FAST));
    const r = await laptop.account.login(EMAIL, PW3);
    expect(r.status).toBe('locked');
    const locked = r as { status: 'locked' } & Locked;
    await expect(laptop.account.unlockWithRecoveryKey(locked, 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA')).rejects.toMatchObject({
      code: 'wrong-recovery-key',
    });
    const unlocked = await laptop.account.unlockWithRecoveryKey(locked, recoveryKey.toLowerCase());
    expect(unlocked.dek).toEqual(dek);
    expect((await laptop.account.login(EMAIL, PW3)).status).toBe('ok');
  });

  it('changes the password while logged in and rotates the recovery key', async () => {
    await laptop.account.changePassword(EMAIL, PW3, PW1, dek);
    await expect(laptop.account.login(EMAIL, PW3)).rejects.toMatchObject({ code: 'wrong-credentials' });
    expect((await laptop.account.login(EMAIL, PW1)).status).toBe('ok');

    const newRk = await laptop.account.regenerateRecoveryKey(dek);
    expect(newRk).not.toBe(recoveryKey);
    recoveryKey = newRk;
  });

  it('keeps other users out of this account, and closes everything else', async () => {
    const stranger = makeDevice('stranger');
    const st = await stranger.account.register('stranger@example.com', 'stranger password 1');
    await applyActionCode(stranger.h.auth, await oobCode('stranger@example.com', 'VERIFY_EMAIL'));
    await stranger.backend.refreshUser();

    // A verified stranger has a working space of their own…
    const own = await Vault.open(new LocalStore(`emu-${Math.random()}`), await deriveDataKeys(st.dek), { persistDelayMs: 5 });
    own.put('m/sleep', { name: 'Sleep' });
    const ownSync = new SyncEngine(own, new FirestoreRemote(stranger.h.db, st.user.uid));
    await ownSync.syncNow();
    expect(ownSync.getStatus().state).toBe('idle');
    await own.close();

    // …but cannot read or write anyone else's.
    await expect(getDoc(doc(stranger.h.db, 'users', uid))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(getDocsFromServer(collection(stranger.h.db, 'users', uid, 'chunks'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    // Nothing outside users/{uid} can be written by anyone.
    await expect(setDoc(doc(stranger.h.db, 'anything', 'x'), { a: 1 })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('rejects malformed or out-of-order chunk writes', async () => {
    const { Bytes, serverTimestamp } = await import('firebase/firestore');
    const ref = doc(phone.h.db, 'users', uid, 'chunks', 'manual-test-chunk');
    await expect(setDoc(ref, { c: Bytes.fromUint8Array(new Uint8Array(4)), r: 5, t: serverTimestamp(), k: 'x' })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(setDoc(ref, { c: 'plaintext', r: 1, t: serverTimestamp(), k: 'x' })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await setDoc(ref, { c: Bytes.fromUint8Array(new Uint8Array(4)), r: 1, t: serverTimestamp(), k: 'x' });
  });

  it("forgot password on Firebase's own page: a temporary password, then a new one Firebase never sees", async () => {
    const TEMP = 'temporary 1234';
    const PW4 = 'fourth password 012';
    await phone.account.sendPasswordReset(EMAIL);
    // Firebase's default page stores whatever is typed there, as is.
    await confirmPasswordReset(laptop.h.auth, await oobCode(EMAIL, 'PASSWORD_RESET'), TEMP);

    await expect(laptop.account.login(EMAIL, TEMP)).rejects.toMatchObject({ code: 'wrong-credentials' });
    await expect(laptop.account.loginWithResetPassword(EMAIL, TEMP, TEMP)).rejects.toMatchObject({ code: 'weak-password' });

    const r = await laptop.account.loginWithResetPassword(EMAIL, TEMP, PW4);
    expect(r.status).toBe('locked'); // this device holds no key; the data key is still sealed under the old password
    // The temporary password is gone; only the derived secret of the new one logs in.
    await expect(laptop.account.loginWithResetPassword(EMAIL, TEMP, 'something else 99')).rejects.toMatchObject({ code: 'wrong-credentials' });

    // A device that still holds the key re-seals it under the new password…
    const phoneLogin = await phone.account.login(EMAIL, PW4, async (id) => (id === uid ? dek : null));
    expect(phoneLogin.status === 'ok' && phoneLogin.rewrapped).toBe(true);
    // …and everyone logs in normally from then on.
    const again = await laptop.account.login(EMAIL, PW4);
    expect(again.status).toBe('ok');
    if (again.status === 'ok') expect(again.dek).toEqual(dek);
  });
});
