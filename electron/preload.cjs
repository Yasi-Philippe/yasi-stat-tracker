'use strict';

/**
 * Sandboxed preload: exposes window.trazoNative (contract in src/platform/electron.ts).
 * Every call is validated again in main.cjs; this side only shapes the data.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Decided by the main process when it created the window (webPreferences.additionalArguments).
const keyring = process.argv.includes('--trazo-keyring=os') ? 'os' : 'none';

/** Copies a view that does not own its whole buffer, so IPC sends exactly these bytes. */
function exactBytes(view) {
  if (!(view instanceof Uint8Array)) throw new TypeError('Expected a Uint8Array');
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength ? view : view.slice();
}

contextBridge.exposeInMainWorld('trazoNative', {
  keyring,
  secrets: {
    get: (name) => ipcRenderer.invoke('trazo:secrets:get', name),
    set: async (name, value) => {
      await ipcRenderer.invoke('trazo:secrets:set', name, value);
    },
    delete: async (name) => {
      await ipcRenderer.invoke('trazo:secrets:delete', name);
    },
  },
  files: {
    save: async (name, data) => (await ipcRenderer.invoke('trazo:files:save', name, exactBytes(data))) === true,
    open: async (extensions) => {
      const picked = await ipcRenderer.invoke('trazo:files:open', extensions);
      if (!picked) return null;
      const { name, data } = picked;
      return { name: String(name), data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    },
  },
  openExternal: async (url) => {
    await ipcRenderer.invoke('trazo:open-external', url);
  },
});
