/** What the sync engine needs from a cloud store. Firestore implements it in production. */

export interface RemoteDoc {
  id: string;
  blob: Uint8Array;
  /** Revision, incremented by every accepted write. */
  rev: number;
  /** Key generation the blob is encrypted under. */
  dekId: string;
  /** Server time of the last write, in ms. */
  ts: number;
}

export interface PushRequest {
  id: string;
  blob: Uint8Array;
  /** The revision this upload was based on; the write only succeeds if the cloud is still there. */
  baseRev: number;
  dekId: string;
}

/** On conflict, `current` is the cloud's version, or null if the document no longer exists. */
export type PushResult = { ok: true; rev: number } | { ok: false; current: RemoteDoc | null };

export interface RemoteStore {
  /** Documents written at or after `sinceTs`, oldest first. Calls onPage as pages arrive. */
  pullSince(sinceTs: number, onPage?: (docs: RemoteDoc[]) => void): Promise<RemoteDoc[]>;
  /** Compare-and-swap write of one chunk. */
  push(req: PushRequest): Promise<PushResult>;
  /** Live updates while the app is open. Optional. */
  watch?(sinceTs: number, onDocs: (docs: RemoteDoc[]) => void, onError: (err: unknown) => void): () => void;
  /** Deletes every chunk not encrypted under keepDekId (after a key reset). */
  purgeForeign?(keepDekId: string): Promise<number>;
}

/** Errors the sync engine knows how to present. */
export class RemoteError extends Error {
  constructor(
    message: string,
    readonly kind: 'offline' | 'denied' | 'quota' | 'other',
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}
