/**
 * Thin wrappers over WebCrypto (AES-256-GCM, HKDF-SHA256, HMAC-SHA256,
 * SHA-256) plus Argon2id from hash-wasm. Nothing here invents crypto.
 */

import { argon2id } from 'hash-wasm';
import { concatBytes, utf8 } from './encoding';

const subtle = globalThis.crypto.subtle;

/** WebCrypto wants BufferSource backed by a plain ArrayBuffer. */
function buf(b: Uint8Array): Uint8Array<ArrayBuffer> {
  return b as Uint8Array<ArrayBuffer>;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', buf(data)));
}

export interface Argon2Params {
  /** Memory in KiB. */
  m: number;
  /** Iterations. */
  t: number;
  /** Parallelism. */
  p: number;
}

/** Production parameters: 64 MiB, 3 passes. About a second on a mid-range phone. */
export const ARGON2_DEFAULT: Argon2Params = { m: 65536, t: 3, p: 1 };

export async function argon2(password: Uint8Array, salt: Uint8Array, params: Argon2Params): Promise<Uint8Array> {
  return argon2id({
    password,
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: 32,
    outputType: 'binary',
  });
}

/** HKDF-SHA256 with an empty salt (the input is already uniformly random). */
export async function hkdf(ikm: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: buf(utf8(info)) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('AES key must be 32 bytes');
  return subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey('raw', buf(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmac(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.sign('HMAC', key, buf(data)));
}

const SEALED_VERSION = 1;
const IV_BYTES = 12;

/**
 * AES-256-GCM. Output layout: [version:1][iv:12][ciphertext+tag]. The
 * associated data binds the ciphertext to its purpose and slot, so a blob
 * cannot be moved to a different place and still decrypt.
 */
export async function seal(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: buf(iv), additionalData: buf(utf8(aad)), tagLength: 128 },
    key,
    buf(plaintext),
  );
  return concatBytes(new Uint8Array([SEALED_VERSION]), iv, new Uint8Array(ct));
}

export class DecryptError extends Error {
  constructor(message = 'Decryption failed') {
    super(message);
    this.name = 'DecryptError';
  }
}

export async function open(key: CryptoKey, sealed: Uint8Array, aad: string): Promise<Uint8Array> {
  if (sealed.length < 1 + IV_BYTES + 16 || sealed[0] !== SEALED_VERSION) {
    throw new DecryptError('Unknown or truncated ciphertext');
  }
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const ct = sealed.subarray(1 + IV_BYTES);
  try {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: buf(iv.slice()), additionalData: buf(utf8(aad)), tagLength: 128 },
      key,
      buf(ct.slice()),
    );
    return new Uint8Array(pt);
  } catch {
    throw new DecryptError();
  }
}

async function pipeThrough(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([buf(data)]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export function deflate(data: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(data, new CompressionStream('deflate-raw'));
}

export function inflate(data: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(data, new DecompressionStream('deflate-raw'));
}
