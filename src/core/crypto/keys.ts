/**
 * Key hierarchy.
 *
 *   password ──Argon2id(salt = H(email))──▶ master
 *   master ──HKDF "auth"──▶ login secret   (sent to Firebase as the "password")
 *   master ──HKDF "kek"───▶ password KEK   (never leaves the device)
 *   recovery key ──HKDF "recovery-kek"──▶ recovery KEK
 *
 *   DEK (random 32 bytes) is wrapped once by each KEK and stored in the cloud.
 *   DEK ──HKDF──▶ data key (AES-GCM, chunks) · id key (HMAC, chunk ids) · DEK id
 *
 * The salt is derived from the email so a fresh device can derive the login
 * secret before it has talked to the server. The info strings are protocol
 * constants: changing them makes every existing account unreadable.
 */

import { constantTimeEqual, fromBase32, fromBase64Url, toBase32, toBase64Url, utf8 } from './encoding';
import {
  ARGON2_DEFAULT,
  type Argon2Params,
  argon2,
  hkdf,
  hmac,
  importAesKey,
  importHmacKey,
  open,
  randomBytes,
  seal,
  sha256,
} from './primitives';

const NS = 'yst/v1';

export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}

export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

export async function emailSalt(email: string): Promise<Uint8Array> {
  return sha256(utf8(`${NS}/salt|${normalizeEmail(email)}`));
}

export interface PasswordKeys {
  /** What Firebase Auth receives instead of the real password. */
  loginSecret: string;
  /** Wraps the DEK. */
  kek: CryptoKey;
}

/**
 * Prefix so the login secret satisfies any password policy (upper, lower,
 * digit, symbol) even if one is switched on in the Firebase console.
 */
const LOGIN_PREFIX = 'Yst1!';

export async function derivePasswordKeys(
  email: string,
  password: string,
  params: Argon2Params = ARGON2_DEFAULT,
): Promise<PasswordKeys> {
  return derivePasswordKeysWithSalt(await emailSalt(email), password, params);
}

export async function derivePasswordKeysWithSalt(
  salt: Uint8Array,
  password: string,
  params: Argon2Params = ARGON2_DEFAULT,
): Promise<PasswordKeys> {
  const master = await argon2(utf8(normalizePassword(password)), salt, params);
  try {
    const [auth, kek] = await Promise.all([hkdf(master, `${NS}/auth`), hkdf(master, `${NS}/kek`)]);
    return { loginSecret: LOGIN_PREFIX + toBase64Url(auth), kek: await importAesKey(kek) };
  } finally {
    master.fill(0);
  }
}

/** Only the login secret, e.g. for the password-reset page. */
export async function deriveLoginSecret(email: string, password: string, params?: Argon2Params): Promise<string> {
  return (await derivePasswordKeys(email, password, params)).loginSecret;
}

// ---------------------------------------------------------------------------
// Data encryption key
// ---------------------------------------------------------------------------

export interface DataKeys {
  /** Encrypts chunks. */
  dataKey: CryptoKey;
  /** Turns logical chunk names into opaque ids. */
  idKey: CryptoKey;
  /** Public fingerprint of the DEK, to tell key generations apart. */
  dekId: string;
}

export function generateDek(): Uint8Array {
  return randomBytes(32);
}

export async function deriveDataKeys(dek: Uint8Array): Promise<DataKeys> {
  if (dek.length !== 32) throw new Error('DEK must be 32 bytes');
  const [data, id, fp] = await Promise.all([
    hkdf(dek, `${NS}/data`),
    hkdf(dek, `${NS}/chunk-id`),
    hkdf(dek, `${NS}/dek-id`, 12),
  ]);
  return { dataKey: await importAesKey(data), idKey: await importHmacKey(id), dekId: toBase64Url(fp) };
}

export async function dekIdOf(dek: Uint8Array): Promise<string> {
  return toBase64Url(await hkdf(dek, `${NS}/dek-id`, 12));
}

export type WrapPurpose = 'pw' | 'rk';

export async function wrapDek(kek: CryptoKey, dek: Uint8Array, purpose: WrapPurpose): Promise<string> {
  return toBase64Url(await seal(kek, dek, `${NS}/wrap/${purpose}`));
}

/** Throws DecryptError if the KEK is wrong. */
export async function unwrapDek(kek: CryptoKey, wrapped: string, purpose: WrapPurpose): Promise<Uint8Array> {
  return open(kek, fromBase64Url(wrapped), `${NS}/wrap/${purpose}`);
}

/** Opaque, stable id for a logical chunk name. Reveals nothing about the name. */
export async function chunkIdFor(idKey: CryptoKey, chunkKey: string): Promise<string> {
  return toBase64Url((await hmac(idKey, utf8(chunkKey))).subarray(0, 18));
}

// ---------------------------------------------------------------------------
// Recovery key: 160 random bits + 20-bit checksum, 36 Crockford base32 chars,
// shown as nine groups of four.
// ---------------------------------------------------------------------------

const RK_BYTES = 20;

export interface RecoveryKey {
  /** Human form, e.g. "7KQ2-…-M3XA". */
  display: string;
  bytes: Uint8Array;
}

async function rkChecksum(bytes: Uint8Array): Promise<string> {
  const h = await sha256(utf8(`${NS}/rk-check|${toBase64Url(bytes)}`));
  return toBase32(h.subarray(0, 3)).slice(0, 4);
}

export async function generateRecoveryKey(): Promise<RecoveryKey> {
  const bytes = randomBytes(RK_BYTES);
  const body = toBase32(bytes) + (await rkChecksum(bytes));
  return { bytes, display: body.match(/.{4}/g)!.join('-') };
}

export class RecoveryKeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryKeyFormatError';
  }
}

/** Parses what the user typed. Forgives case, spaces, dashes, I/L/O. */
export async function parseRecoveryKey(input: string): Promise<Uint8Array> {
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (clean.length !== 36) throw new RecoveryKeyFormatError('A recovery key has 36 characters.');
  let bytes: Uint8Array;
  try {
    bytes = fromBase32(clean.slice(0, 32), RK_BYTES);
  } catch {
    throw new RecoveryKeyFormatError('The recovery key contains characters that are not allowed.');
  }
  const expected = utf8(await rkChecksum(bytes));
  if (!constantTimeEqual(expected, utf8(clean.slice(32)))) {
    throw new RecoveryKeyFormatError('That recovery key has a typo. Check each group again.');
  }
  return bytes;
}

export async function recoveryKek(recoveryBytes: Uint8Array): Promise<CryptoKey> {
  return importAesKey(await hkdf(recoveryBytes, `${NS}/recovery-kek`));
}

// ---------------------------------------------------------------------------
// Key envelope: what the cloud stores per account. Contains no secrets in
// the clear.
// ---------------------------------------------------------------------------

export interface KeyEnvelope {
  v: 1;
  kdf: { alg: 'argon2id' } & Argon2Params;
  dekId: string;
  /** DEK wrapped by the password KEK. */
  pw: string;
  /** DEK wrapped by the recovery KEK. */
  rk: string;
}

export async function createEnvelope(
  dek: Uint8Array,
  kek: CryptoKey,
  recovery: Uint8Array,
  params: Argon2Params = ARGON2_DEFAULT,
): Promise<KeyEnvelope> {
  return {
    v: 1,
    kdf: { alg: 'argon2id', ...params },
    dekId: await dekIdOf(dek),
    pw: await wrapDek(kek, dek, 'pw'),
    rk: await wrapDek(await recoveryKek(recovery), dek, 'rk'),
  };
}

export function isKeyEnvelope(x: unknown): x is KeyEnvelope {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  const kdf = e.kdf as Record<string, unknown> | undefined;
  return (
    e.v === 1 &&
    typeof e.dekId === 'string' &&
    typeof e.pw === 'string' &&
    typeof e.rk === 'string' &&
    !!kdf &&
    kdf.alg === 'argon2id' &&
    typeof kdf.m === 'number' &&
    typeof kdf.t === 'number' &&
    typeof kdf.p === 'number'
  );
}

/** Verifies a DEK really belongs to an envelope (after unwrapping or from local storage). */
export async function dekMatches(dek: Uint8Array, envelope: KeyEnvelope): Promise<boolean> {
  return (await dekIdOf(dek)) === envelope.dekId;
}
