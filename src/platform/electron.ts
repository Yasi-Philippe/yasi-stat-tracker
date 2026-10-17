/** Desktop (Electron) implementation, talking to electron/preload.cjs. */

import { fromBase64Url, toBase64Url } from '../core/crypto/encoding';
import type { Platform, SecretStore } from './types';
import { BrowserSecretStore, webPlatform } from './web';

export interface NativeBridge {
  keyring: 'os' | 'none';
  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
  };
  files: {
    save(name: string, data: Uint8Array): Promise<boolean>;
    open(extensions: string[]): Promise<{ name: string; data: Uint8Array } | null>;
  };
  openExternal(url: string): Promise<void>;
}

declare global {
  interface Window {
    trazoNative?: NativeBridge;
  }
}

class KeyringSecrets implements SecretStore {
  readonly protection = 'os-keyring' as const;
  constructor(private readonly bridge: NativeBridge) {}
  async get(name: string): Promise<Uint8Array | null> {
    const v = await this.bridge.secrets.get(name);
    return v ? fromBase64Url(v) : null;
  }
  set(name: string, value: Uint8Array): Promise<void> {
    return this.bridge.secrets.set(name, toBase64Url(value));
  }
  delete(name: string): Promise<void> {
    return this.bridge.secrets.delete(name);
  }
}

export function electronPlatform(bridge: NativeBridge): Platform {
  const base = webPlatform();
  return {
    ...base,
    kind: 'electron',
    // Without a system keyring, fall back to the browser store rather than plain text.
    secrets: bridge.keyring === 'os' ? new KeyringSecrets(bridge) : new BrowserSecretStore(),
    files: {
      async save(name, _mime, data) {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        return bridge.files.save(name, bytes);
      },
      async open(accept) {
        const r = await bridge.files.open(accept.map((a) => a.replace(/^\./, '')).filter((a) => !a.includes('/')));
        return r ? { name: r.name, bytes: r.data } : null;
      },
    },
    openExternal(url) {
      // The shell only opens https links; anything else is refused on purpose.
      bridge.openExternal(url).catch(() => undefined);
    },
  };
}
