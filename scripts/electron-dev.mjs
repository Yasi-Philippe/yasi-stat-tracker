#!/usr/bin/env node
/**
 * Desktop development: starts the Vite dev server (port from vite.config.ts), then
 * Electron pointed at it through VITE_DEV_SERVER_URL. Closing the window or Ctrl+C
 * stops both.
 * Extra arguments go to Electron, e.g. `npm run electron:dev -- --enable-logging`.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let electronBinary;
try {
  electronBinary = createRequire(import.meta.url)('electron');
} catch (err) {
  console.error(`${err.message}\nDownload the Electron binary with: node node_modules/electron/install.js`);
  process.exit(1);
}

const server = await createServer({ root, server: { strictPort: true } });
try {
  // Port from vite.config.ts (server.port); 5180 if it sets none.
  await server.listen(server.config.server.port ?? 5180);
} catch (err) {
  console.error(`Vite dev server: ${err.message}`);
  await server.close();
  process.exit(1);
}
server.printUrls();
const url = server.resolvedUrls?.local[0];
if (!url) {
  console.error('Vite dev server did not report a local URL');
  await server.close();
  process.exit(1);
}

const env = { ...process.env, VITE_DEV_SERVER_URL: url };
delete env.ELECTRON_RUN_AS_NODE; // set by some editors' terminals; would start Electron as plain Node

const args = process.argv.slice(2);
// Electron 44 has no window decorations on GNOME Wayland, so default to XWayland
// (same as the packaged desktop entry). Pass --ozone-platform=wayland to override.
if (process.platform === 'linux' && !args.some((a) => a.startsWith('--ozone-platform'))) {
  args.unshift('--ozone-platform=x11');
}

const electron = spawn(electronBinary, [root, ...args], { cwd: root, env, stdio: 'inherit' });

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  if (electron.exitCode === null && electron.signalCode === null) electron.kill('SIGTERM');
  await server.close().catch(() => {});
  process.exit(code);
}

electron.on('exit', (code) => void stop(code ?? 0));
electron.on('error', (err) => {
  console.error(`Could not start Electron: ${err.message}`);
  void stop(1);
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void stop(0));
