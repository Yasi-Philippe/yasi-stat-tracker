import { describe, expect, it } from 'vitest';
import { fromBase32, fromBase64Url, toBase32, toBase64Url, utf8 } from './encoding';
import {
  chunkIdFor,
  createEnvelope,
  dekMatches,
  deriveDataKeys,
  derivePasswordKeys,
  generateDek,
  generateRecoveryKey,
  parseRecoveryKey,
  RecoveryKeyFormatError,
  recoveryKek,
  unwrapDek,
} from './keys';
import { DecryptError, deflate, inflate, open, randomBytes, seal } from './primitives';

/** Cheap Argon2 settings so the suite stays fast; production uses 64 MiB. */
const FAST = { m: 256, t: 1, p: 1 };

describe('encoding', () => {
  it('round-trips base64url for every length', () => {
    for (let n = 0; n < 40; n++) {
      const b = randomBytes(n);
      expect(fromBase64Url(toBase64Url(b))).toEqual(b);
    }
    expect(toBase64Url(utf8('hello?'))).toBe('aGVsbG8_');
  });

  it('round-trips Crockford base32', () => {
    const b = randomBytes(20);
    const s = toBase32(b);
    expect(s).toHaveLength(32);
    expect(s).not.toMatch(/[ILOU]/);
    expect(fromBase32(s, 20)).toEqual(b);
    expect(fromBase32(s.toLowerCase(), 20)).toEqual(b);
  });
});

describe('AES-GCM sealing', () => {
  it('opens what it sealed and binds the associated data', async () => {
    const { dataKey } = await deriveDataKeys(generateDek());
    const msg = utf8('private numbers');
    const sealed = await seal(dataKey, msg, 'slot-a');
    expect(await open(dataKey, sealed, 'slot-a')).toEqual(msg);
    await expect(open(dataKey, sealed, 'slot-b')).rejects.toBeInstanceOf(DecryptError);
  });

  it('detects tampering', async () => {
    const { dataKey } = await deriveDataKeys(generateDek());
    const sealed = await seal(dataKey, utf8('x'), 'a');
    sealed[sealed.length - 1]! ^= 1;
    await expect(open(dataKey, sealed, 'a')).rejects.toBeInstanceOf(DecryptError);
  });

  it('never reuses an IV', async () => {
    const { dataKey } = await deriveDataKeys(generateDek());
    const a = await seal(dataKey, utf8('same'), 'a');
    const b = await seal(dataKey, utf8('same'), 'a');
    expect(toBase64Url(a)).not.toBe(toBase64Url(b));
  });

  it('compresses and restores', async () => {
    const text = utf8(JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ d: i, v: 70 + (i % 7) / 10 }))));
    const z = await deflate(text);
    expect(z.length).toBeLessThan(text.length / 3);
    expect(await inflate(z)).toEqual(text);
  });
});

describe('password keys', () => {
  it('is deterministic per email and password, and case-insensitive on email', async () => {
    const a = await derivePasswordKeys('Someone@Example.com ', 'correct horse', FAST);
    const b = await derivePasswordKeys('someone@example.com', 'correct horse', FAST);
    expect(a.loginSecret).toBe(b.loginSecret);
    expect(a.loginSecret.startsWith('Yst1!')).toBe(true);
    const c = await derivePasswordKeys('someone@example.com', 'correct horsE', FAST);
    expect(c.loginSecret).not.toBe(a.loginSecret);
    const d = await derivePasswordKeys('other@example.com', 'correct horse', FAST);
    expect(d.loginSecret).not.toBe(a.loginSecret);
  });

  it('works with production parameters', async () => {
    const k = await derivePasswordKeys('someone@example.com', 'pässwörd', undefined);
    expect(k.loginSecret).toHaveLength(5 + 43);
  }, 20_000);
});

describe('envelope', () => {
  it('unwraps the DEK with the password or the recovery key, and nothing else', async () => {
    const dek = generateDek();
    const pw = await derivePasswordKeys('a@b.co', 'pw-one', FAST);
    const rk = await generateRecoveryKey();
    const env = await createEnvelope(dek, pw.kek, rk.bytes, FAST);

    expect(await unwrapDek(pw.kek, env.pw, 'pw')).toEqual(dek);
    expect(await unwrapDek(await recoveryKek(rk.bytes), env.rk, 'rk')).toEqual(dek);
    expect(await dekMatches(dek, env)).toBe(true);

    const wrong = await derivePasswordKeys('a@b.co', 'pw-two', FAST);
    await expect(unwrapDek(wrong.kek, env.pw, 'pw')).rejects.toBeInstanceOf(DecryptError);
    // A wrapped DEK cannot be replayed into the other slot.
    await expect(unwrapDek(pw.kek, env.rk, 'pw')).rejects.toBeInstanceOf(DecryptError);
    expect(await dekMatches(generateDek(), env)).toBe(false);
  });
});

describe('recovery key', () => {
  it('formats as nine groups of four and parses back', async () => {
    const rk = await generateRecoveryKey();
    expect(rk.display).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){8}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(await parseRecoveryKey(rk.display)).toEqual(rk.bytes);
    expect(await parseRecoveryKey(` ${rk.display.toLowerCase().replace(/-/g, ' ')} `)).toEqual(rk.bytes);
  });

  it('catches typos with the checksum', async () => {
    const rk = await generateRecoveryKey();
    const chars = rk.display.split('');
    const i = chars.findIndex((c) => c !== '-');
    chars[i] = chars[i] === 'A' ? 'B' : 'A';
    await expect(parseRecoveryKey(chars.join(''))).rejects.toBeInstanceOf(RecoveryKeyFormatError);
    await expect(parseRecoveryKey('too-short')).rejects.toBeInstanceOf(RecoveryKeyFormatError);
  });
});

describe('chunk ids', () => {
  it('are stable per key and unlinkable across keys', async () => {
    const k1 = await deriveDataKeys(generateDek());
    const k2 = await deriveDataKeys(generateDek());
    const a = await chunkIdFor(k1.idKey, 'e/abc/2024-01');
    expect(await chunkIdFor(k1.idKey, 'e/abc/2024-01')).toBe(a);
    expect(await chunkIdFor(k1.idKey, 'e/abc/2024-02')).not.toBe(a);
    expect(await chunkIdFor(k2.idKey, 'e/abc/2024-01')).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
});
