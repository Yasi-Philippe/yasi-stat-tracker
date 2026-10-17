/**
 * Keeps a vault and the cloud in step: pull what changed since the last
 * cursor, then upload local changes with compare-and-swap, merging and
 * retrying when another device got there first.
 */

import type { Vault } from '../vault/vault';
import { RemoteError, type RemoteDoc, type RemoteStore } from './remote';

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'stopped';

export interface SyncStatus {
  state: SyncState;
  /** ms timestamp of the last fully successful sync. */
  lastSyncAt: number | null;
  /** Chunks waiting to be uploaded. */
  pending: number;
  error: string | null;
  errorKind: RemoteError['kind'] | null;
  /** During a long first download: chunks received so far. */
  progress: number | null;
}

/** Re-read a little before the cursor so writes committed near it are never missed. */
const CURSOR_OVERLAP_MS = 60_000;
const CURSOR_META = 'sync.cursor';
const LAST_SYNC_META = 'sync.last';
const MAX_ROUNDS = 6;

export interface SyncOptions {
  /** Wait this long after a local change before syncing. */
  debounceMs?: number;
  /** Background sync interval while running. */
  intervalMs?: number;
}

export class SyncEngine {
  private status: SyncStatus = {
    state: 'stopped',
    lastSyncAt: null,
    pending: 0,
    error: null,
    errorKind: null,
    progress: null,
  };
  private readonly listeners = new Set<(s: SyncStatus) => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private timers: Array<() => void> = [];
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly vault: Vault,
    private readonly remote: RemoteStore,
    private readonly opts: SyncOptions = {},
  ) {}

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }

  /** Runs one full sync. Concurrent calls share the run, plus one follow-up. */
  syncNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.runOnce();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async runOnce(): Promise<void> {
    this.set({ state: 'syncing', pending: this.vault.pendingCount });
    try {
      await this.pull();
      await this.push();
      const now = Date.now();
      await this.vault.setMeta(LAST_SYNC_META, now);
      this.set({ state: 'idle', lastSyncAt: now, error: null, errorKind: null, progress: null, pending: this.vault.pendingCount });
    } catch (err) {
      const kind = err instanceof RemoteError ? err.kind : 'other';
      this.set({
        state: kind === 'offline' ? 'offline' : 'error',
        error: err instanceof Error ? err.message : String(err),
        errorKind: kind,
        progress: null,
        pending: this.vault.pendingCount,
      });
    }
  }

  private async pull(): Promise<void> {
    const cursor = (await this.vault.getMeta<number>(CURSOR_META)) ?? 0;
    let received = 0;
    const firstSync = cursor === 0;
    const docs = await this.remote.pullSince(Math.max(0, cursor - CURSOR_OVERLAP_MS), (page) => {
      received += page.length;
      if (firstSync) this.set({ progress: received });
    });
    await this.ingest(docs, cursor);
  }

  /** Applies downloaded documents and advances the cursor past them. */
  private async ingest(docs: RemoteDoc[], cursor?: number): Promise<void> {
    let max = 0;
    for (const d of docs) {
      await this.vault.applyRemote(d);
      if (d.ts > max) max = d.ts;
    }
    const current = cursor ?? (await this.vault.getMeta<number>(CURSOR_META)) ?? 0;
    if (max > current) await this.vault.setMeta(CURSOR_META, max);
  }

  private async push(): Promise<void> {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const uploads = await this.vault.pendingUploads();
      if (!uploads.length) return;
      this.set({ pending: uploads.length });
      for (const up of uploads) {
        const res = await this.remote.push({ id: up.id, blob: up.blob, baseRev: up.baseRev, dekId: this.vault.keys.dekId });
        if (res.ok) {
          await this.vault.markPushed(up.id, res.rev, up.seq);
        } else if (res.current) {
          // Someone else wrote first: fold their version in; the next round uploads the merge.
          await this.vault.applyRemote(res.current);
        } else {
          // The cloud copy is gone; upload ours as a new document.
          this.vault.forgetRevision(up.id);
        }
      }
    }
  }

  /** Background mode: sync after local changes, periodically, and on live cloud updates. */
  start(): void {
    if (this.timers.length) return;
    this.set({ state: 'idle' });
    const unsub = this.vault.subscribe(() => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.syncNow(), this.opts.debounceMs ?? 1500);
    });
    const interval = setInterval(() => void this.syncNow(), this.opts.intervalMs ?? 5 * 60_000);
    this.timers.push(unsub, () => clearInterval(interval));

    if (typeof window !== 'undefined') {
      const online = () => void this.syncNow();
      window.addEventListener('online', online);
      this.timers.push(() => window.removeEventListener('online', online));
    }

    if (this.remote.watch) {
      const stop = this.remote.watch(
        Date.now() - CURSOR_OVERLAP_MS,
        (docs) => void this.ingest(docs),
        () => void this.syncNow(),
      );
      this.timers.push(stop);
    }
    void this.syncNow();
  }

  stop(): void {
    for (const t of this.timers) t();
    this.timers = [];
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.set({ state: 'stopped' });
  }
}
