/**
 * The vault: every record of one user, decrypted in memory, persisted to the
 * device as encrypted chunks, and exchanged with the cloud chunk by chunk.
 *
 * Reads and writes are synchronous against memory; encryption and storage
 * happen shortly after in the background (see flush). The sync engine talks
 * to the vault only through pendingUploads / markPushed / applyRemote.
 */

import { chunkIdFor, type DataKeys } from '../crypto/keys';
import { randomBytes } from '../crypto/primitives';
import { toBase64Url } from '../crypto/encoding';
import { decodeChunk, encodeChunk } from './codec';
import { Hlc } from './hlc';
import type { LocalChunk, LocalStore } from './localStore';
import { chunkKeyOf, K, mergeRecords, type Rec } from './records';

interface ChunkState {
  key: string;
  id: string | null;
  recs: Map<string, Rec>;
  /** Last cloud revision folded in; 0 = never synced. */
  rev: number;
  dirty: boolean;
  /** Bumped on every local change, so a stale upload never clears newer edits. */
  seq: number;
  /** Encrypted form of the current content, or null when it must be re-encrypted. */
  blob: Uint8Array | null;
}

export interface Upload {
  id: string;
  blob: Uint8Array;
  baseRev: number;
  seq: number;
}

export interface RemoteChunk {
  id: string;
  blob: Uint8Array;
  rev: number;
  dekId: string;
}

export type ApplyResult = 'added' | 'replaced' | 'merged' | 'stale' | 'foreign';

type Listener = (changed: ReadonlySet<string>) => void;

const DEVICE_META = 'deviceId';

export class Vault {
  private readonly chunks = new Map<string, ChunkState>();
  private readonly byId = new Map<string, ChunkState>();
  private readonly listeners = new Set<Listener>();
  private readonly metricVersions = new Map<string, number>();
  private pendingNotify = new Set<string>();
  private batching = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persisting: Promise<void> = Promise.resolve();
  private closed = false;
  /** Bumped on every change; handy for React's useSyncExternalStore. */
  version = 0;
  /** Chunks on this device that could not be decrypted when opening. */
  readonly loadErrors: Array<{ id: string; error: string }> = [];

  private constructor(
    private readonly store: LocalStore,
    readonly keys: DataKeys,
    readonly deviceId: string,
    private readonly hlc: Hlc,
    private readonly persistDelayMs: number,
  ) {}

  /** Loads and decrypts everything stored on this device for this key. */
  static async open(store: LocalStore, keys: DataKeys, opts: { persistDelayMs?: number; keepForeign?: boolean } = {}): Promise<Vault> {
    let deviceId = await store.getMeta<string>(DEVICE_META);
    if (!deviceId) {
      deviceId = toBase64Url(randomBytes(6));
      await store.setMeta(DEVICE_META, deviceId);
    }
    const vault = new Vault(store, keys, deviceId, new Hlc(deviceId), opts.persistDelayMs ?? 250);
    const rows = await store.allChunks();
    const foreign: string[] = [];
    await Promise.all(
      rows.map(async (row) => {
        if (row.dekId !== keys.dekId) {
          foreign.push(row.id);
          return;
        }
        let decoded: { key: string; recs: Rec[] };
        try {
          decoded = await decodeChunk(keys, row.id, row.blob);
        } catch (err) {
          // Keep the bytes (the cloud may still hold a good copy) but skip them.
          vault.loadErrors.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
          return;
        }
        const { key, recs } = decoded;
        const state: ChunkState = {
          key,
          id: row.id,
          recs: new Map(recs.map((r) => [r.k, r])),
          rev: row.rev,
          dirty: row.dirty === 1,
          seq: 0,
          blob: row.blob,
        };
        vault.chunks.set(key, state);
        vault.byId.set(row.id, state);
        for (const r of recs) vault.hlc.receive(r.u);
      }),
    );
    // Chunks from an older key generation can never be read again — unless a
    // key change is in progress and they are about to be re-encrypted.
    if (!opts.keepForeign) await store.deleteChunks(foreign);
    return vault;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  get<T>(key: string): T | undefined {
    const r = this.chunks.get(chunkKeyOf(key))?.recs.get(key);
    return r && !r.x ? (r.v as T) : undefined;
  }

  /** Live records whose key starts with prefix, sorted by key. */
  list<T>(prefix: string): Array<[string, T]> {
    const out: Array<[string, T]> = [];
    if (prefix.startsWith(K.entry)) {
      // Entry prefixes span many chunks; only visit the matching ones.
      for (const [ck, state] of this.chunks) {
        if (!ck.startsWith('e/') || !(ck.startsWith(prefix) || prefix.startsWith(ck))) continue;
        for (const r of state.recs.values()) if (!r.x && r.k.startsWith(prefix)) out.push([r.k, r.v as T]);
      }
    } else {
      const state = this.chunks.get(chunkKeyOf(prefix));
      if (state) for (const r of state.recs.values()) if (!r.x && r.k.startsWith(prefix)) out.push([r.k, r.v as T]);
    }
    return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  /** Changes whenever any entry of the metric changes. */
  metricVersion(metricId: string): number {
    return this.metricVersions.get(metricId) ?? 0;
  }

  /** Number of records, live or deleted. */
  get size(): number {
    let n = 0;
    for (const c of this.chunks.values()) n += c.recs.size;
    return n;
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  put(key: string, value: unknown): void {
    this.write({ k: key, u: this.hlc.tick(), v: value });
  }

  del(key: string): void {
    if (this.get(key) === undefined) return;
    this.write({ k: key, u: this.hlc.tick(), x: 1 });
  }

  /** Groups several writes into a single change notification. */
  batch(fn: () => void): void {
    this.batching++;
    try {
      fn();
    } finally {
      this.batching--;
      if (this.batching === 0) this.emit();
    }
  }

  private write(rec: Rec): void {
    if (this.closed) throw new Error('Vault is closed');
    const ck = chunkKeyOf(rec.k);
    let state = this.chunks.get(ck);
    if (!state) {
      state = { key: ck, id: null, recs: new Map(), rev: 0, dirty: false, seq: 0, blob: null };
      this.chunks.set(ck, state);
    }
    state.recs.set(rec.k, rec);
    state.seq++;
    state.dirty = true;
    state.blob = null;
    this.touch(ck);
    this.schedulePersist();
  }

  private touch(chunkKey: string): void {
    this.version++;
    if (chunkKey.startsWith('e/')) {
      const metricId = chunkKey.slice(2, chunkKey.lastIndexOf('/'));
      this.metricVersions.set(metricId, (this.metricVersions.get(metricId) ?? 0) + 1);
    }
    this.pendingNotify.add(chunkKey);
    if (this.batching === 0) this.emit();
  }

  /** Arrow property so it can be handed to React's useSyncExternalStore unbound. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    if (!this.pendingNotify.size) return;
    const changed = this.pendingNotify;
    this.pendingNotify = new Set();
    for (const l of this.listeners) l(changed);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, this.persistDelayMs);
  }

  /** Encrypts and stores every changed chunk now. */
  flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persisting = this.persisting.then(() => this.persistNow());
    return this.persisting;
  }

  private async idFor(state: ChunkState): Promise<string> {
    if (!state.id) {
      state.id = await chunkIdFor(this.keys.idKey, state.key);
      this.byId.set(state.id, state);
    }
    return state.id;
  }

  private async persistNow(): Promise<void> {
    for (;;) {
      const stale = [...this.chunks.values()].filter((s) => s.blob === null);
      if (!stale.length) return;
      const rows: LocalChunk[] = [];
      for (const state of stale) {
        const seq = state.seq;
        const id = await this.idFor(state);
        const blob = await encodeChunk(this.keys, id, state.key, state.recs.values());
        if (state.seq !== seq) continue; // changed meanwhile; next round re-encrypts
        state.blob = blob;
        rows.push({ id, blob, rev: state.rev, dirty: state.dirty ? 1 : 0, dekId: this.keys.dekId });
      }
      await this.store.putChunks(rows);
    }
  }

  // -------------------------------------------------------------------------
  // Sync interface
  // -------------------------------------------------------------------------

  /** Every chunk with local changes, encrypted and ready to upload. */
  async pendingUploads(): Promise<Upload[]> {
    await this.flush();
    const out: Upload[] = [];
    for (const s of this.chunks.values()) {
      if (s.dirty && s.blob && s.id) out.push({ id: s.id, blob: s.blob, baseRev: s.rev, seq: s.seq });
    }
    return out;
  }

  get hasPendingChanges(): boolean {
    for (const s of this.chunks.values()) if (s.dirty) return true;
    return false;
  }

  get pendingCount(): number {
    let n = 0;
    for (const s of this.chunks.values()) if (s.dirty) n++;
    return n;
  }

  /** The cloud accepted an upload as revision `rev`. */
  async markPushed(id: string, rev: number, seq: number): Promise<void> {
    const state = this.byId.get(id);
    if (!state) return;
    state.rev = Math.max(state.rev, rev);
    if (state.seq === seq) state.dirty = false;
    if (state.blob) {
      await this.store.putChunks([{ id, blob: state.blob, rev: state.rev, dirty: state.dirty ? 1 : 0, dekId: this.keys.dekId }]);
    }
  }

  /** The cloud lost this chunk (e.g. purged); treat it as never uploaded. */
  forgetRevision(id: string): void {
    const state = this.byId.get(id);
    if (state) {
      state.rev = 0;
      state.dirty = true;
    }
  }

  /** Folds a chunk downloaded from the cloud into the vault. */
  async applyRemote(remote: RemoteChunk): Promise<ApplyResult> {
    if (remote.dekId !== this.keys.dekId) return 'foreign';
    const known = this.byId.get(remote.id);
    if (known && remote.rev <= known.rev) return 'stale';

    const { key, recs } = await decodeChunk(this.keys, remote.id, remote.blob);
    for (const r of recs) this.hlc.receive(r.u);

    const state = known ?? this.chunks.get(key);
    let result: ApplyResult;
    if (!state) {
      const fresh: ChunkState = {
        key,
        id: remote.id,
        recs: new Map(recs.map((r) => [r.k, r])),
        rev: remote.rev,
        dirty: false,
        seq: 0,
        blob: remote.blob,
      };
      this.chunks.set(key, fresh);
      this.byId.set(remote.id, fresh);
      result = 'added';
    } else if (!state.dirty) {
      state.recs = new Map(recs.map((r) => [r.k, r]));
      state.rev = remote.rev;
      state.blob = remote.blob;
      state.seq++;
      if (!state.id) {
        state.id = remote.id;
        this.byId.set(remote.id, state);
      }
      result = 'replaced';
    } else {
      const { merged, differsFromRemote } = mergeRecords(state.recs, recs);
      state.recs = merged;
      state.rev = remote.rev;
      state.seq++;
      if (!state.id) {
        state.id = remote.id;
        this.byId.set(remote.id, state);
      }
      if (differsFromRemote) {
        state.blob = null; // re-encrypt the merge; stays dirty for upload
      } else {
        state.blob = remote.blob;
        state.dirty = false;
      }
      result = 'merged';
    }

    const s = this.chunks.get(key)!;
    if (s.blob) {
      await this.store.putChunks([{ id: remote.id, blob: s.blob, rev: s.rev, dirty: s.dirty ? 1 : 0, dekId: this.keys.dekId }]);
    } else {
      this.schedulePersist();
    }
    this.touch(key);
    return result;
  }

  /** Bookkeeping that is not user data, e.g. the sync cursor. */
  getMeta<T>(k: string): Promise<T | undefined> {
    return this.store.getMeta<T>(k);
  }

  setMeta(k: string, v: unknown): Promise<void> {
    return this.store.setMeta(k, v);
  }

  /** Every record, for export and re-keying. */
  allRecords(): Rec[] {
    const out: Rec[] = [];
    for (const s of this.chunks.values()) out.push(...s.recs.values());
    return out;
  }

  /** Imports records from another vault or a backup, keeping the newest version of each. */
  importRecords(recs: Iterable<Rec>): number {
    let changed = 0;
    this.batch(() => {
      const byChunk = new Map<string, Rec[]>();
      for (const r of recs) {
        const ck = chunkKeyOf(r.k);
        let list = byChunk.get(ck);
        if (!list) byChunk.set(ck, (list = []));
        list.push(r);
        this.hlc.receive(r.u);
      }
      for (const [ck, list] of byChunk) {
        let state = this.chunks.get(ck);
        if (!state) {
          state = { key: ck, id: null, recs: new Map(), rev: 0, dirty: false, seq: 0, blob: null };
          this.chunks.set(ck, state);
        }
        const { merged, differsFromLocal } = mergeRecords(state.recs, list);
        if (!differsFromLocal) continue;
        state.recs = merged;
        state.seq++;
        state.dirty = true;
        state.blob = null;
        changed++;
        this.touch(ck);
      }
    });
    if (changed) this.schedulePersist();
    return changed;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
    this.listeners.clear();
    this.store.close();
  }
}
