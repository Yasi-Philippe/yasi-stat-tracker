import { describe, expect, it } from 'vitest';
import { deriveDataKeys, generateDek } from '../crypto/keys';
import { MemoryRemote } from '../sync/memoryRemote';
import { SyncEngine } from '../sync/syncEngine';
import { decodeStamp, Hlc } from './hlc';
import { LocalStore } from './localStore';
import { chunkKeyOf, entryKey, mergeRecords, type Rec } from './records';
import { Vault } from './vault';

let dbCounter = 0;
const freshStore = () => new LocalStore(`test-${++dbCounter}-${Math.random()}`);

async function device(dek: Uint8Array, store = freshStore()) {
  const keys = await deriveDataKeys(dek);
  const vault = await Vault.open(store, keys, { persistDelayMs: 5 });
  return { vault, store, keys };
}

describe('HLC', () => {
  it('produces strictly increasing stamps even when the clock stalls or goes back', () => {
    let t = 1000;
    const h = new Hlc('devA1', () => t);
    const a = h.tick();
    const b = h.tick();
    t = 500;
    const c = h.tick();
    expect(a < b && b < c).toBe(true);
  });

  it('jumps past stamps received from other devices', () => {
    const h = new Hlc('devA1', () => 1000);
    h.receive(new Hlc('devB2', () => 9999).tick());
    expect(decodeStamp(h.tick())!.l).toBe(9999);
  });
});

describe('records', () => {
  it('chunks entries by metric and year, config by type', () => {
    expect(chunkKeyOf(entryKey('abc', '2024-03-17'))).toBe('e/abc/2024');
    expect(chunkKeyOf('m/xyz')).toBe('cfg/m');
    expect(chunkKeyOf('pd/1')).toBe('cfg/pd');
  });

  it('merges by last writer and reports which side changed', () => {
    const local = new Map<string, Rec>([
      ['a', { k: 'a', u: '2', v: 1 }],
      ['b', { k: 'b', u: '5', v: 'local' }],
    ]);
    const r = mergeRecords(local, [
      { k: 'b', u: '3', v: 'remote-old' },
      { k: 'c', u: '4', v: 'new' },
    ]);
    expect(r.merged.get('b')!.v).toBe('local');
    expect(r.merged.get('c')!.v).toBe('new');
    expect(r.differsFromLocal).toBe(true);
    expect(r.differsFromRemote).toBe(true);

    const same = mergeRecords(new Map([['a', { k: 'a', u: '1', v: 1 }]]), [{ k: 'a', u: '1', v: 1 }]);
    expect(same.differsFromLocal).toBe(false);
    expect(same.differsFromRemote).toBe(false);
  });
});

describe('vault', () => {
  it('persists encrypted and reopens with the same key', async () => {
    const dek = generateDek();
    const store = freshStore();
    const { vault } = await device(dek, store);
    vault.put('m/w', { name: 'Weight' });
    vault.put(entryKey('w', '2024-01-01'), { v: 80.1 });
    vault.put(entryKey('w', '2025-02-01'), { v: 79.4 });
    await vault.close();

    const rows = await new LocalStore(store.name).allChunks();
    expect(rows).toHaveLength(3);
    const raw = rows.map((r) => new TextDecoder('latin1').decode(r.blob)).join('');
    expect(raw).not.toContain('Weight');
    expect(raw).not.toContain('80.1');

    const { vault: again } = await device(dek, new LocalStore(store.name));
    expect(again.get('m/w')).toEqual({ name: 'Weight' });
    expect(again.list('e/w/').map(([, v]) => v)).toEqual([{ v: 80.1 }, { v: 79.4 }]);
  });

  it('ignores chunks encrypted under another key generation', async () => {
    const store = freshStore();
    const { vault } = await device(generateDek(), store);
    vault.put('m/x', 1);
    await vault.close();
    const { vault: other } = await device(generateDek(), new LocalStore(store.name));
    expect(other.get('m/x')).toBeUndefined();
    expect(await new LocalStore(store.name).allChunks()).toHaveLength(0);
  });

  it('deletes with tombstones and notifies listeners once per batch', async () => {
    const { vault } = await device(generateDek());
    let calls = 0;
    vault.subscribe(() => calls++);
    vault.batch(() => {
      vault.put('m/a', 1);
      vault.put('m/b', 2);
    });
    expect(calls).toBe(1);
    vault.del('m/a');
    expect(vault.get('m/a')).toBeUndefined();
    expect(vault.list('m/')).toEqual([['m/b', 2]]);
    expect(calls).toBe(2);
  });

  it('tracks a per-metric version for cache invalidation', async () => {
    const { vault } = await device(generateDek());
    const v0 = vault.metricVersion('w');
    vault.put(entryKey('w', '2024-01-01'), { v: 1 });
    expect(vault.metricVersion('w')).toBe(v0 + 1);
    vault.put('m/w', {});
    expect(vault.metricVersion('w')).toBe(v0 + 1);
  });
});

describe('sync between devices', () => {
  it('replicates through the cloud, which only ever sees ciphertext', async () => {
    const dek = generateDek();
    const remote = new MemoryRemote();
    const a = await device(dek);
    const b = await device(dek);
    const syncA = new SyncEngine(a.vault, remote);
    const syncB = new SyncEngine(b.vault, remote);

    a.vault.put('m/w', { name: 'Weight', unit: 'kg' });
    for (let d = 1; d <= 28; d++) a.vault.put(entryKey('w', `2024-02-${String(d).padStart(2, '0')}`), { v: 80 - d / 10 });
    await syncA.syncNow();
    expect(syncA.getStatus().state).toBe('idle');
    expect(remote.docs.size).toBe(2);
    for (const doc of remote.docs.values()) {
      expect(new TextDecoder('latin1').decode(doc.blob)).not.toContain('Weight');
    }

    await syncB.syncNow();
    expect(b.vault.get('m/w')).toEqual({ name: 'Weight', unit: 'kg' });
    expect(b.vault.list('e/w/')).toHaveLength(28);
    expect(b.vault.hasPendingChanges).toBe(false);
  });

  it('merges concurrent edits to the same chunk without losing either', async () => {
    const dek = generateDek();
    const remote = new MemoryRemote();
    const a = await device(dek);
    const b = await device(dek);
    const syncA = new SyncEngine(a.vault, remote);
    const syncB = new SyncEngine(b.vault, remote);

    a.vault.put(entryKey('w', '2024-03-01'), { v: 70 });
    await syncA.syncNow();
    await syncB.syncNow();

    // Both devices edit the same month while offline.
    a.vault.put(entryKey('w', '2024-03-02'), { v: 71 });
    b.vault.put(entryKey('w', '2024-03-03'), { v: 72 });
    b.vault.put(entryKey('w', '2024-03-01'), { v: 69.5 }); // later edit wins
    await syncA.syncNow();
    await syncB.syncNow(); // conflicts, merges, re-uploads
    await syncA.syncNow();

    for (const v of [a.vault, b.vault]) {
      expect(v.get(entryKey('w', '2024-03-01'))).toEqual({ v: 69.5 });
      expect(v.get(entryKey('w', '2024-03-02'))).toEqual({ v: 71 });
      expect(v.get(entryKey('w', '2024-03-03'))).toEqual({ v: 72 });
      expect(v.hasPendingChanges).toBe(false);
    }
  });

  it('propagates deletions', async () => {
    const dek = generateDek();
    const remote = new MemoryRemote();
    const a = await device(dek);
    const b = await device(dek);
    a.vault.put('c/chart1', { title: 'x' });
    await new SyncEngine(a.vault, remote).syncNow();
    await new SyncEngine(b.vault, remote).syncNow();
    b.vault.del('c/chart1');
    await new SyncEngine(b.vault, remote).syncNow();
    await new SyncEngine(a.vault, remote).syncNow();
    expect(a.vault.get('c/chart1')).toBeUndefined();
  });

  it('keeps local edits when offline and uploads them later', async () => {
    const dek = generateDek();
    const remote = new MemoryRemote();
    const a = await device(dek);
    const sync = new SyncEngine(a.vault, remote);
    remote.failWith = Object.assign(new Error('network down'));
    a.vault.put('m/x', 1);
    await sync.syncNow();
    expect(sync.getStatus().state).toBe('error');
    expect(a.vault.hasPendingChanges).toBe(true);
    remote.failWith = null;
    await sync.syncNow();
    expect(sync.getStatus().state).toBe('idle');
    expect(remote.docs.size).toBe(1);
  });

  it('restores a whole account onto a new device from the cloud alone', async () => {
    const dek = generateDek();
    const remote = new MemoryRemote();
    const a = await device(dek);
    for (const y of [2022, 2023, 2024]) {
      for (let m = 1; m <= 12; m++) {
        for (let d = 1; d <= 28; d++) {
          a.vault.put(entryKey('w', `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`), { v: m + d });
        }
      }
    }
    await new SyncEngine(a.vault, remote).syncNow();
    expect(remote.writes).toBe(3);

    const fresh = await device(dek);
    const before = remote.reads;
    await new SyncEngine(fresh.vault, remote).syncNow();
    expect(fresh.vault.list('e/w/')).toHaveLength(3 * 12 * 28);
    expect(remote.reads - before).toBeLessThanOrEqual(4);
  });

  it('does not re-upload a chunk edited while its upload was in flight as clean', async () => {
    const dek = generateDek();
    const remote = new MemoryRemote();
    const a = await device(dek);
    a.vault.put('m/x', 1);
    const ups = await a.vault.pendingUploads();
    a.vault.put('m/x', 2); // edit during "upload"
    const res = await remote.push({ id: ups[0]!.id, blob: ups[0]!.blob, baseRev: 0, dekId: a.keys.dekId });
    expect(res.ok).toBe(true);
    await a.vault.markPushed(ups[0]!.id, 1, ups[0]!.seq);
    expect(a.vault.hasPendingChanges).toBe(true);
    await new SyncEngine(a.vault, remote).syncNow();
    expect(a.vault.hasPendingChanges).toBe(false);
    const b = await device(dek);
    await new SyncEngine(b.vault, remote).syncNow();
    expect(b.vault.get('m/x')).toBe(2);
  });
});
