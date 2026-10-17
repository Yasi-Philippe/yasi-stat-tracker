/** Chunk encryption: JSON → deflate → AES-256-GCM bound to the chunk id. */

import { fromUtf8, utf8 } from '../crypto/encoding';
import { chunkIdFor, type DataKeys } from '../crypto/keys';
import { deflate, inflate, open, seal } from '../crypto/primitives';
import type { Rec } from './records';

interface ChunkPlain {
  v: 1;
  key: string;
  recs: Rec[];
}

const aad = (chunkId: string) => `yst/v1/chunk|${chunkId}`;

export async function encodeChunk(keys: DataKeys, chunkId: string, key: string, recs: Iterable<Rec>): Promise<Uint8Array> {
  const plain: ChunkPlain = { v: 1, key, recs: [...recs] };
  return seal(keys.dataKey, await deflate(utf8(JSON.stringify(plain))), aad(chunkId));
}

export class CorruptChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptChunkError';
  }
}

export async function decodeChunk(keys: DataKeys, chunkId: string, blob: Uint8Array): Promise<{ key: string; recs: Rec[] }> {
  const json = fromUtf8(await inflate(await open(keys.dataKey, blob, aad(chunkId))));
  const plain = JSON.parse(json) as ChunkPlain;
  if (plain?.v !== 1 || typeof plain.key !== 'string' || !Array.isArray(plain.recs)) {
    throw new CorruptChunkError('Unexpected chunk format');
  }
  // Defence in depth: the name inside must hash to the id it was stored under.
  if ((await chunkIdFor(keys.idKey, plain.key)) !== chunkId) {
    throw new CorruptChunkError('Chunk name does not match its id');
  }
  for (const r of plain.recs) {
    if (typeof r?.k !== 'string' || typeof r.u !== 'string') throw new CorruptChunkError('Malformed record');
  }
  return { key: plain.key, recs: plain.recs };
}
