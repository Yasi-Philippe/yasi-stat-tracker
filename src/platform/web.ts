/** Browser implementation, used in development and as the base for the shells. */

import Dexie, { type Table } from 'dexie';
import { open as openSealed, seal } from '../core/crypto/primitives';
import type { FileIO, Notifier, PickedFile, Platform, SecretStore } from './types';

interface KvRow {
  k: string;
  v: unknown;
}

class DeviceDb extends Dexie {
  kv!: Table<KvRow, string>;
  constructor() {
    super('trazo-device');
    this.version(1).stores({ kv: 'k' });
  }
}

/**
 * Secrets sealed with a non-extractable WebCrypto key kept in IndexedDB.
 * Script on the page can use the key but never read it out.
 */
export class BrowserSecretStore implements SecretStore {
  readonly protection = 'browser' as const;
  private db = new DeviceDb();
  private key: Promise<CryptoKey> | null = null;

  private deviceKey(): Promise<CryptoKey> {
    this.key ??= (async () => {
      const row = await this.db.kv.get('device-key');
      if (row?.v instanceof CryptoKey) return row.v;
      const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await this.db.kv.put({ k: 'device-key', v: k });
      return k;
    })();
    return this.key;
  }

  async get(name: string): Promise<Uint8Array | null> {
    const row = await this.db.kv.get(`secret:${name}`);
    if (!(row?.v instanceof Uint8Array)) return null;
    try {
      return await openSealed(await this.deviceKey(), row.v, `device|${name}`);
    } catch {
      return null;
    }
  }

  async set(name: string, value: Uint8Array): Promise<void> {
    await this.db.kv.put({ k: `secret:${name}`, v: await seal(await this.deviceKey(), value, `device|${name}`) });
  }

  async delete(name: string): Promise<void> {
    await this.db.kv.delete(`secret:${name}`);
  }
}

export class BrowserNotifier implements Notifier {
  readonly canSchedule = false;
  async permission(): Promise<'granted' | 'denied' | 'prompt'> {
    if (typeof Notification === 'undefined') return 'denied';
    return Notification.permission === 'default' ? 'prompt' : Notification.permission;
  }
  async requestPermission(): Promise<boolean> {
    if (typeof Notification === 'undefined') return false;
    return (await Notification.requestPermission()) === 'granted';
  }
  async replaceAll(): Promise<void> {
    // Browsers cannot wake a closed page; reminders need the Android app.
  }
}

export class BrowserFiles implements FileIO {
  async save(name: string, mime: string, data: Uint8Array | string): Promise<boolean> {
    const blob = new Blob([typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>)], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  }

  open(accept: string[]): Promise<PickedFile | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept.join(',');
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const f = input.files?.[0];
        input.remove();
        if (!f) return resolve(null);
        resolve({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      });
      input.addEventListener('cancel', () => {
        input.remove();
        resolve(null);
      });
      document.body.appendChild(input);
      input.click();
    });
  }
}

const backHandlers: Array<() => boolean> = [];

export function runBackHandlers(): boolean {
  for (let i = backHandlers.length - 1; i >= 0; i--) if (backHandlers[i]!()) return true;
  return false;
}

export function webPlatform(): Platform {
  return {
    kind: 'web',
    secrets: new BrowserSecretStore(),
    notifier: new BrowserNotifier(),
    files: new BrowserFiles(),
    haptic() {},
    openExternal(url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    onBack(handler) {
      backHandlers.push(handler);
      return () => {
        const i = backHandlers.indexOf(handler);
        if (i >= 0) backHandlers.splice(i, 1);
      };
    },
  };
}
