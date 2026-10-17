import { describe, expect, it } from 'vitest';
import { fromUtf8, utf8 } from '../crypto/encoding';
import {
  createEnvelope,
  deriveDataKeys,
  derivePasswordKeys,
  generateDek,
  generateRecoveryKey,
  type KeyEnvelope,
} from '../crypto/keys';
import { entries, getEntry, metric, newId, saveMetric, setEntry } from '../data/repo';
import type { MetricDef } from '../model/types';
import { LocalStore } from '../vault/localStore';
import type { Rec } from '../vault/records';
import { Vault } from '../vault/vault';
import { BackupError, type BackupFile, createBackup, openBackup, readBackupHeader } from './backup';

/** Cheap Argon2 settings so the suite stays fast; production uses 64 MiB. */
const FAST = { m: 256, t: 1, p: 1 };
const EMAIL = 'Someone@Example.com';
const PASSWORD = 'correct horse battery';

let dbCounter = 0;
async function openVault(dek: Uint8Array, name = `io-backup-${++dbCounter}-${Math.random()}`): Promise<Vault> {
  return Vault.open(new LocalStore(name), await deriveDataKeys(dek), { persistDelayMs: 5 });
}

async function account() {
  const dek = generateDek();
  const rk = await generateRecoveryKey();
  const pw = await derivePasswordKeys(EMAIL, PASSWORD, FAST);
  const envelope: KeyEnvelope = await createEnvelope(dek, pw.kek, rk.bytes, FAST);
  const vault = await openVault(dek);
  const m: MetricDef = { id: newId(), slug: 'weight', name: 'Weight', unit: 'kg', cadence: 'daily', fill: 'none', decimals: 3, step: 0.001, order: 1 };
  saveMetric(vault, m);
  setEntry(vault, m, '2024-01-01', 80.123, 'after holidays');
  setEntry(vault, m, '2024-01-02', 79.877);
  setEntry(vault, m, '2024-01-03', 1);
  vault.del(`e/${m.id}/2024-01-03`); // a tombstone travels too
  return { dek, rk, envelope, vault, m };
}

const sortRecs = (recs: Rec[]) => [...recs].sort((a, b) => (a.k < b.k ? -1 : 1));

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof BackupError ? err.code : `other: ${String(err)}`;
  }
}

describe('encrypted backup', () => {
  it('round-trips with the password and with the recovery key', async () => {
    const { rk, envelope, vault, dek } = await account();
    const file = await createBackup(vault, envelope, EMAIL, dek);
    const header = readBackupHeader(file);
    expect(header.dekId).toBe(envelope.dekId);
    expect(Date.parse(header.createdAt)).not.toBeNaN();
    const expected = sortRecs(vault.allRecords());
    expect(expected.some((r) => r.x === 1)).toBe(true);
    expect(sortRecs(await openBackup(file, { password: PASSWORD }))).toEqual(expected);
    const typed = ` ${rk.display.toLowerCase().replace(/-/g, ' ')} `;
    expect(sortRecs(await openBackup(file, { recoveryKey: typed }))).toEqual(expected);
  });

  it('reveals neither values, names, notes nor the email', async () => {
    const { envelope, vault, dek } = await account();
    const text = fromUtf8(await createBackup(vault, envelope, EMAIL, dek));
    for (const secret of ['Weight', 'weight', '80.123', '79.877', 'holidays', 'Someone', 'someone', 'example', '2024-01']) {
      expect(text).not.toContain(secret);
    }
    const file = JSON.parse(text) as BackupFile;
    expect(Object.keys(file).sort()).toEqual(['createdAt', 'dekId', 'format', 'kdf', 'payload', 'salt', 'v', 'wrap']);
    expect(file).toMatchObject({ format: 'trazo-backup', v: 1, kdf: { alg: 'argon2id', ...FAST } });
  });

  it('refuses wrong secrets with clear errors', async () => {
    const { envelope, vault, dek } = await account();
    const file = await createBackup(vault, envelope, EMAIL, dek);
    expect(await codeOf(openBackup(file, { password: 'wrong horse' }))).toBe('wrong-password');
    const other = await generateRecoveryKey();
    expect(await codeOf(openBackup(file, { recoveryKey: other.display }))).toBe('wrong-recovery-key');
    expect(await codeOf(openBackup(file, { recoveryKey: 'not-a-key' }))).toBe('wrong-recovery-key');
  });

  it('detects damaged and foreign files', async () => {
    const { envelope, vault, dek } = await account();
    const file = JSON.parse(fromUtf8(await createBackup(vault, envelope, EMAIL, dek))) as BackupFile;
    const bytes = (f: object) => utf8(JSON.stringify(f));
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);

    expect(await codeOf(openBackup(bytes({ ...file, payload: flip(file.payload, 40) }), { password: PASSWORD }))).toBe('corrupt');
    expect(await codeOf(openBackup(bytes({ ...file, dekId: flip(file.dekId, 3) }), { password: PASSWORD }))).toBe('corrupt');
    expect(await codeOf(openBackup(bytes({ ...file, payload: '!!' }), { password: PASSWORD }))).toBe('corrupt');
    expect(await codeOf(openBackup(bytes({ ...file, kdf: { ...file.kdf, m: 1 << 30 } }), { password: PASSWORD }))).toBe('corrupt');
    // A changed wrap no longer opens: it is indistinguishable from a wrong secret.
    expect(await codeOf(openBackup(bytes({ ...file, wrap: { ...file.wrap, pw: flip(file.wrap.pw, 30) } }), { password: PASSWORD }))).toBe(
      'wrong-password',
    );
    expect(await codeOf(openBackup(bytes({ ...file, v: 2 }), { password: PASSWORD }))).toBe('newer-version');
    expect(() => readBackupHeader(utf8('date,weight\n2024-01-01,80\n'))).toThrow(BackupError);
    expect(() => readBackupHeader(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow(/not a Trazo backup/);
    expect(() => readBackupHeader(bytes({ format: 'other' }))).toThrow(BackupError);
  });

  it('restores into a vault with a different key, keeping newer local edits', async () => {
    const { envelope, vault, dek, m } = await account();
    const file = await createBackup(vault, envelope, EMAIL, dek);

    const otherDek = generateDek();
    const name = `io-backup-restore-${Math.random()}`;
    const target = await openVault(otherDek, name);
    saveMetric(target, { ...m, name: 'Weight', unit: 'kg' });
    setEntry(target, m, '2024-01-02', 75); // edited after the backup was made: must survive
    expect(target.importRecords(await openBackup(file, { password: PASSWORD }))).toBeGreaterThan(0);
    expect(getEntry(target, m, '2024-01-01')).toMatchObject({ value: 80.123, note: 'after holidays' });
    expect(getEntry(target, m, '2024-01-02')?.value).toBe(75);
    expect(getEntry(target, m, '2024-01-03')).toBeUndefined();
    await target.close();

    // Persisted under the target's own key.
    const reopened = await openVault(otherDek, name);
    expect(metric(reopened, m.id)?.name).toBe('Weight');
    expect(entries(reopened, m.id).map((e) => e.value)).toEqual([80.123, 75]);
  });

  it('refuses to back up with a key that does not match the envelope', async () => {
    const { envelope, vault } = await account();
    expect(await codeOf(createBackup(vault, envelope, EMAIL, generateDek()))).toBe('key-mismatch');
  });
});
