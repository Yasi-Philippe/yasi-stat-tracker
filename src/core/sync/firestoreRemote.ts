/**
 * RemoteStore on Cloud Firestore: users/{uid}/chunks/{chunkId} holding
 * { c: ciphertext bytes, r: revision, t: server time, k: key generation }.
 */

import {
  Bytes,
  collection,
  doc,
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
  FirestoreError,
  getDocsFromServer,
  limit,
  type Query,
  onSnapshot,
  orderBy,
  query,
  type QueryDocumentSnapshot,
  runTransaction,
  serverTimestamp,
  startAfter,
  Timestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { type PushRequest, type PushResult, RemoteError, type RemoteDoc, type RemoteStore } from './remote';

const PAGE = 300;

export class FirestoreRemote implements RemoteStore {
  constructor(
    private readonly db: Firestore,
    private readonly uid: string,
  ) {}

  private col() {
    return collection(this.db, 'users', this.uid, 'chunks');
  }

  async pullSince(sinceTs: number, onPage?: (docs: RemoteDoc[]) => void): Promise<RemoteDoc[]> {
    const out: RemoteDoc[] = [];
    let last: QueryDocumentSnapshot<DocumentData> | null = null;
    const since = Timestamp.fromMillis(sinceTs);
    for (;;) {
      const q: Query<DocumentData> = last
        ? query(this.col(), where('t', '>=', since), orderBy('t'), startAfter(last), limit(PAGE))
        : query(this.col(), where('t', '>=', since), orderBy('t'), limit(PAGE));
      const snap = await guard(() => getDocsFromServer(q));
      const docs = snap.docs.map(toRemoteDoc).filter((d): d is RemoteDoc => d !== null);
      out.push(...docs);
      onPage?.(docs);
      if (snap.docs.length < PAGE) return out;
      last = snap.docs[snap.docs.length - 1]!;
    }
  }

  async push(req: PushRequest): Promise<PushResult> {
    const ref = doc(this.col(), req.id);
    return guard(() =>
      runTransaction(this.db, async (tx): Promise<PushResult> => {
        const cur = await tx.get(ref);
        const body = (rev: number) => ({ c: Bytes.fromUint8Array(req.blob), r: rev, t: serverTimestamp(), k: req.dekId });
        if (cur.exists()) {
          const d = toRemoteDoc(cur);
          const rev = (cur.data().r as number) ?? 0;
          if (rev !== req.baseRev) return { ok: false, current: d };
          tx.set(ref, body(rev + 1));
          return { ok: true, rev: rev + 1 };
        }
        if (req.baseRev !== 0) return { ok: false, current: null };
        tx.set(ref, body(1));
        return { ok: true, rev: 1 };
      }),
    );
  }

  watch(sinceTs: number, onDocs: (docs: RemoteDoc[]) => void, onError: (err: unknown) => void): () => void {
    const q = query(this.col(), where('t', '>=', Timestamp.fromMillis(sinceTs)), orderBy('t'));
    return onSnapshot(
      q,
      (snap) => {
        const docs = snap
          .docChanges()
          .filter((c) => c.type !== 'removed' && !c.doc.metadata.hasPendingWrites)
          .map((c) => toRemoteDoc(c.doc))
          .filter((d): d is RemoteDoc => d !== null);
        if (docs.length) onDocs(docs);
      },
      onError,
    );
  }

  async purgeForeign(keepDekId: string): Promise<number> {
    const snap = await guard(() => getDocsFromServer(this.col()));
    const doomed = snap.docs.filter((d) => d.data().k !== keepDekId);
    for (let i = 0; i < doomed.length; i += 400) {
      const batch = writeBatch(this.db);
      for (const d of doomed.slice(i, i + 400)) batch.delete(d.ref);
      await guard(() => batch.commit());
    }
    return doomed.length;
  }
}

function toRemoteDoc(snap: DocumentSnapshot): RemoteDoc | null {
  const data = snap.data();
  if (!data || !(data.c instanceof Bytes) || !(data.t instanceof Timestamp)) return null;
  return { id: snap.id, blob: data.c.toUint8Array(), rev: data.r as number, dekId: data.k as string, ts: data.t.toMillis() };
}

/** Maps Firestore failures onto the kinds the sync engine reports. */
export async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toRemoteError(err);
  }
}

export function toRemoteError(err: unknown): RemoteError {
  if (err instanceof RemoteError) return err;
  const code = err instanceof FirestoreError ? err.code : (err as { code?: string })?.code;
  switch (code) {
    case 'unavailable':
    case 'deadline-exceeded':
      return new RemoteError('You appear to be offline.', 'offline');
    case 'permission-denied':
    case 'unauthenticated':
      return new RemoteError('The cloud refused access. Your email may not be verified yet.', 'denied');
    case 'resource-exhausted':
      return new RemoteError("Today's free cloud quota is used up. Sync resumes after the daily reset.", 'quota');
    default:
      return new RemoteError(err instanceof Error ? err.message : String(err), 'other');
  }
}
