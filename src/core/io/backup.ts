/**
 * Encrypted backup: every record of the vault in one portable file that
 * opens with the account password or the recovery key, on any device and
 * into any account.
 *
 * The file reuses the wraps of the account's key envelope, so it opens with
 * the password and recovery key that were valid when it was made. It holds
 * the email-derived salt, never the email.
 *
 * Restore: vault.importRecords(await openBackup(bytes, secret)). Records
 * merge by HLC stamp, so the newest version of each one wins.
 */

import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from '../crypto/encoding';
import {
  dekIdOf,
  dekMatches,
  deriveDataKeys,
  derivePasswordKeysWithSalt,
  emailSalt,
  type KeyEnvelope,
  parseRecoveryKey,
  RecoveryKeyFormatError,
  recoveryKek,
  unwrapDek,
} from '../crypto/keys';
import { DecryptError, deflate, inflate, open, seal } from '../crypto/primitives';
import { decodeStamp } from '../vault/hlc';
import type { Rec } from '../vault/records';
import type { Vault } from '../vault/vault';

export interface BackupFile {
  format: 'trazo-backup';
  v: 1;
  /** ISO timestamp. */
  createdAt: string;
  kdf: { alg: 'argon2id'; m: number; t: number; p: number };
  /** Base64url email salt: a hash of the email, not the email. */
  salt: string;
  /** Fingerprint of the data key. */
  dekId: string;
  /** The data key wrapped by the password KEK and by the recovery-key KEK. */
  wrap: { pw: string; rk: string };
  /** Base64url of sealed(deflate(JSON of Rec[])). */
  payload: string;
}

export type BackupErrorCode =
  | 'not-a-backup'
  | 'newer-version'
  | 'corrupt'
  | 'wrong-password'
  | 'wrong-recovery-key'
  /** createBackup: the key passed in does not belong to the envelope. */
  | 'key-mismatch';

/** Backup failures with messages written for people. */
export class BackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

const FORMAT = 'trazo-backup';
const aad = (dekId: string) => `yst/v1/backup|${dekId}`;

/**
 * Builds the backup file (UTF-8 JSON). `envelope` must be the account's
 * current key envelope, `email` its email and `dek` the unlocked data key.
 */
export async function createBackup(vault: Vault, envelope: KeyEnvelope, email: string, dek: Uint8Array): Promise<Uint8Array> {
  if (!(await dekMatches(dek, envelope))) {
    throw new BackupError('key-mismatch', 'This device holds a different key than the account. Log out and in again, then retry.');
  }
  const { dataKey } = await deriveDataKeys(dek);
  const plain = utf8(JSON.stringify(vault.allRecords()));
  const sealed = await seal(dataKey, await deflate(plain), aad(envelope.dekId));
  const file: BackupFile = {
    format: FORMAT,
    v: 1,
    createdAt: new Date().toISOString(),
    kdf: { alg: 'argon2id', m: envelope.kdf.m, t: envelope.kdf.t, p: envelope.kdf.p },
    salt: toBase64Url(await emailSalt(email)),
    dekId: envelope.dekId,
    wrap: { pw: envelope.pw, rk: envelope.rk },
    payload: toBase64Url(sealed),
  };
  return utf8(JSON.stringify(file));
}

/** Checks the file is a backup this app can open and returns what can be read without a secret. */
export function readBackupHeader(bytes: Uint8Array): { createdAt: string; dekId: string } {
  const file = parseFile(bytes);
  return { createdAt: file.createdAt, dekId: file.dekId };
}

/** Decrypts a backup with the password or the recovery key valid when it was made. */
export async function openBackup(bytes: Uint8Array, secret: { password: string } | { recoveryKey: string }): Promise<Rec[]> {
  const file = parseFile(bytes);
  let dek: Uint8Array;
  if ('password' in secret) {
    const { m, t, p } = file.kdf;
    const { kek } = await derivePasswordKeysWithSalt(fromBase64Url(file.salt), secret.password, { m, t, p });
    dek = await unwrapOr(kek, file.wrap.pw, 'pw', () => {
      return new BackupError(
        'wrong-password',
        'That password does not open this backup. Use the password the account had when the backup was made, or the recovery key.',
      );
    });
  } else {
    let rk: Uint8Array;
    try {
      rk = await parseRecoveryKey(secret.recoveryKey);
    } catch (err) {
      if (err instanceof RecoveryKeyFormatError) throw new BackupError('wrong-recovery-key', err.message);
      throw err;
    }
    dek = await unwrapOr(await recoveryKek(rk), file.wrap.rk, 'rk', () => {
      return new BackupError('wrong-recovery-key', 'That recovery key does not open this backup.');
    });
  }
  try {
    if ((await dekIdOf(dek)) !== file.dekId) throw corrupt();
    const { dataKey } = await deriveDataKeys(dek);
    const json = fromUtf8(await inflate(await open(dataKey, fromBase64Url(file.payload), aad(file.dekId))));
    const recs: unknown = JSON.parse(json);
    if (!Array.isArray(recs) || !recs.every(isRec)) throw corrupt();
    return recs;
  } catch (err) {
    throw err instanceof BackupError ? err : corrupt();
  } finally {
    dek.fill(0);
  }
}

async function unwrapOr(kek: CryptoKey, wrapped: string, purpose: 'pw' | 'rk', wrong: () => BackupError): Promise<Uint8Array> {
  try {
    return await unwrapDek(kek, wrapped, purpose);
  } catch (err) {
    throw err instanceof DecryptError ? wrong() : err;
  }
}

function parseFile(bytes: Uint8Array): BackupFile {
  let data: unknown;
  try {
    data = JSON.parse(fromUtf8(bytes));
  } catch {
    throw notABackup();
  }
  if (!isObject(data) || data.format !== FORMAT) throw notABackup();
  if (data.v !== 1) {
    if (typeof data.v === 'number' && data.v > 1) {
      throw new BackupError('newer-version', 'This backup was made by a newer version of the app. Update the app and try again.');
    }
    throw corrupt();
  }
  const { kdf, wrap } = data;
  const ok =
    typeof data.createdAt === 'string' &&
    isBase64Url(data.salt, 32) &&
    isBase64Url(data.dekId) &&
    isBase64Url(data.payload) &&
    isObject(wrap) &&
    isBase64Url(wrap.pw) &&
    isBase64Url(wrap.rk) &&
    isObject(kdf) &&
    kdf.alg === 'argon2id' &&
    // Bounds keep a damaged file from asking for absurd memory or time.
    isInt(kdf.p, 1, 16) &&
    isInt(kdf.t, 1, 64) &&
    isInt(kdf.m, 8 * (kdf.p as number), 1 << 20);
  if (!ok) throw corrupt();
  return data as unknown as BackupFile;
}

function isRec(r: unknown): r is Rec {
  return isObject(r) && typeof r.k === 'string' && typeof r.u === 'string' && decodeStamp(r.u) !== null && (r.x === undefined || r.x === 1);
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isInt(x: unknown, min: number, max: number): boolean {
  return typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
}

function isBase64Url(x: unknown, bytes?: number): x is string {
  if (typeof x !== 'string' || !/^[A-Za-z0-9_-]+$/.test(x) || x.length % 4 === 1) return false;
  return bytes === undefined || fromBase64Url(x).length === bytes;
}

function notABackup(): BackupError {
  return new BackupError('not-a-backup', 'This file is not a Trazo backup.');
}

function corrupt(): BackupError {
  return new BackupError('corrupt', 'This backup file is damaged and cannot be opened.');
}
