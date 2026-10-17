/** In-memory RemoteStore with the same compare-and-swap semantics as Firestore. For tests and demo mode. */

import type { PushRequest, PushResult, RemoteDoc, RemoteStore } from './remote';

export class MemoryRemote implements RemoteStore {
  readonly docs = new Map<string, RemoteDoc>();
  private clock = 1_000;
  reads = 0;
  writes = 0;
  /** When set, every call fails with this error (simulates being offline). */
  failWith: Error | null = null;

  async pullSince(sinceTs: number, onPage?: (docs: RemoteDoc[]) => void): Promise<RemoteDoc[]> {
    if (this.failWith) throw this.failWith;
    const out = [...this.docs.values()].filter((d) => d.ts >= sinceTs).sort((a, b) => a.ts - b.ts);
    this.reads += out.length || 1;
    onPage?.(out);
    return out.map((d) => ({ ...d }));
  }

  async push(req: PushRequest): Promise<PushResult> {
    if (this.failWith) throw this.failWith;
    this.reads++;
    const cur = this.docs.get(req.id);
    const curRev = cur?.rev ?? 0;
    if (curRev !== req.baseRev) return { ok: false, current: cur ? { ...cur } : null };
    this.writes++;
    const doc: RemoteDoc = { id: req.id, blob: req.blob, rev: curRev + 1, dekId: req.dekId, ts: ++this.clock };
    this.docs.set(req.id, doc);
    return { ok: true, rev: doc.rev };
  }

  async purgeForeign(keepDekId: string): Promise<number> {
    let n = 0;
    for (const [id, d] of this.docs) {
      if (d.dekId !== keepDekId) {
        this.docs.delete(id);
        n++;
      }
    }
    return n;
  }
}
