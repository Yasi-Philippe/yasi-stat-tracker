/**
 * Records are the unit of merge. Each one is a key, a value and the HLC stamp
 * of its last change. Deletes are tombstones so they propagate. Records are
 * grouped into chunks, the unit of encryption and sync.
 */

export interface Rec {
  /** Record key, e.g. "m/<id>" or "e/<metricId>/<YYYY-MM-DD>". */
  k: string;
  /** HLC stamp of the last change. */
  u: string;
  /** Value; absent on tombstones. */
  v?: unknown;
  /** 1 = deleted. */
  x?: 1;
}

/** Record key prefixes. */
export const K = {
  metric: 'm/',
  formula: 'f/',
  periodSet: 'ps/',
  period: 'pd/',
  chart: 'c/',
  dashboard: 'd/',
  theme: 't/',
  settings: 's/',
  entry: 'e/',
} as const;

export function entryKey(metricId: string, date: string): string {
  return `${K.entry}${metricId}/${date}`;
}

/** Entries are chunked per metric and year (a few KB each); everything else per record type. */
export function chunkKeyOf(recordKey: string): string {
  if (recordKey.startsWith(K.entry)) {
    const slash = recordKey.lastIndexOf('/');
    return `${recordKey.slice(0, slash)}/${recordKey.slice(slash + 1, slash + 5)}`;
  }
  const slash = recordKey.indexOf('/');
  return `cfg/${slash < 0 ? recordKey : recordKey.slice(0, slash)}`;
}

/** Last writer wins; ties cannot happen because stamps embed the device id. */
export function pick(a: Rec, b: Rec): Rec {
  return a.u >= b.u ? a : b;
}

/**
 * Merges two versions of a chunk. Reports whether the result differs from
 * each side, so callers know whether to upload or just adopt the remote copy.
 */
export function mergeRecords(
  local: Map<string, Rec>,
  remote: Iterable<Rec>,
): { merged: Map<string, Rec>; differsFromLocal: boolean; differsFromRemote: boolean } {
  const merged = new Map(local);
  let differsFromLocal = false;
  let remoteCount = 0;
  let remoteWins = 0;
  for (const r of remote) {
    remoteCount++;
    const l = merged.get(r.k);
    if (!l) {
      merged.set(r.k, r);
      differsFromLocal = true;
      remoteWins++;
    } else if (r.u > l.u) {
      merged.set(r.k, r);
      differsFromLocal = true;
      remoteWins++;
    } else if (r.u === l.u) {
      remoteWins++;
    }
  }
  // The merge equals the remote copy only if every merged record came from it.
  const differsFromRemote = merged.size !== remoteCount || remoteWins !== remoteCount;
  return { merged, differsFromLocal, differsFromRemote };
}
