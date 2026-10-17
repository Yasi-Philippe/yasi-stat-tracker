/**
 * On-device storage (IndexedDB via Dexie). Holds only encrypted chunks, the
 * same bytes that go to the cloud, plus non-secret bookkeeping.
 */

import Dexie, { type Table } from 'dexie';

export interface LocalChunk {
  /** Opaque chunk id. */
  id: string;
  blob: Uint8Array;
  /** Last cloud revision folded into this chunk; 0 = never synced. */
  rev: number;
  /** 1 = has local changes not yet uploaded. */
  dirty: 0 | 1;
  /** Key generation the blob is encrypted under. */
  dekId: string;
}

interface MetaRow {
  k: string;
  v: unknown;
}

class Db extends Dexie {
  chunks!: Table<LocalChunk, string>;
  meta!: Table<MetaRow, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({ chunks: 'id, dirty', meta: 'k' });
  }
}

export class LocalStore {
  private readonly db: Db;

  constructor(readonly name: string) {
    this.db = new Db(name);
  }

  allChunks(): Promise<LocalChunk[]> {
    return this.db.chunks.toArray();
  }

  getChunk(id: string): Promise<LocalChunk | undefined> {
    return this.db.chunks.get(id);
  }

  async putChunks(chunks: LocalChunk[]): Promise<void> {
    if (chunks.length) await this.db.chunks.bulkPut(chunks);
  }

  async deleteChunks(ids: string[]): Promise<void> {
    if (ids.length) await this.db.chunks.bulkDelete(ids);
  }

  /** Removes every chunk not encrypted under keepDekId. */
  async deleteForeign(keepDekId: string): Promise<number> {
    const ids = (await this.db.chunks.toArray()).filter((c) => c.dekId !== keepDekId).map((c) => c.id);
    await this.deleteChunks(ids);
    return ids.length;
  }

  async getMeta<T>(k: string): Promise<T | undefined> {
    return (await this.db.meta.get(k))?.v as T | undefined;
  }

  async setMeta(k: string, v: unknown): Promise<void> {
    await this.db.meta.put({ k, v });
  }

  async deleteMeta(k: string): Promise<void> {
    await this.db.meta.delete(k);
  }

  close(): void {
    this.db.close();
  }

  /** Erases everything stored on this device under this name. */
  async destroy(): Promise<void> {
    this.db.close();
    await Dexie.delete(this.name);
  }
}
