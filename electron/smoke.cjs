'use strict';

/**
 * Headless self-test of the desktop shell, enabled with TRAZO_SMOKE=1 (see main.cjs):
 *
 *   TRAZO_SMOKE=1 npx electron .                 # source tree, after `npx vite build`
 *   TRAZO_SMOKE=1 release/linux-unpacked/trazo   # packaged build
 *
 * Uses a throw-away profile in the OS temp dir, never shows a window, and replaces the
 * file dialogs and the system browser with in-memory stand-ins. Prints a JSON report on
 * stdout and exits with 0 when every check passed, 1 otherwise. The secrets round-trip
 * uses the real OS keyring.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const TIMEOUT_MS = 60_000;
const RENDER_WAIT_MS = 15_000;
const SECRET = { name: 'smoke:check', value: 'smoke ü \u{1F511} ✓' };

exports.create = (profileDir) => {
  const opened = [];
  let savedFile = null;
  const system = {
    async showSaveDialog(_win, options) {
      const dir = path.join(profileDir, 'smoke-files');
      fs.mkdirSync(dir, { recursive: true });
      savedFile = path.join(dir, path.basename(options.defaultPath));
      return { canceled: false, filePath: savedFile };
    },
    async showOpenDialog() {
      return savedFile ? { canceled: false, filePaths: [savedFile] } : { canceled: true, filePaths: [] };
    },
    async openExternal(url) {
      opened.push(url);
    },
  };
  return { system, run: (ctx) => run({ ...ctx, profileDir, opened, savedFile: () => savedFile }) };
};

async function run({ win, keyring, startUrl, origin, secretsFile, profileDir, opened, savedFile }) {
  const contents = win.webContents;
  const report = {
    ok: false,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    keyring,
    keyringBackend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null,
    url: null,
    checks: {},
  };
  const consoleLines = [];
  contents.on('console-message', (event, legacyLevel, legacyMessage) => {
    const level = event.level ?? legacyLevel;
    if (level === 'error' || level === 'warning' || level === 2 || level === 3) {
      consoleLines.push(`${level}: ${event.message ?? legacyMessage}`.slice(0, 300));
    }
  });

  let done = false;
  const finish = (error) => {
    if (done) return;
    done = true;
    clearTimeout(watchdog);
    if (error) report.error = String(error.message ?? error);
    report.failed = Object.keys(report.checks).filter((name) => report.checks[name] === false);
    report.ok = !error && report.failed.length === 0;
    report.console = consoleLines.slice(0, 20);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    removeWhenExited(profileDir);
    app.exit(report.ok ? 0 : 1);
  };
  const watchdog = setTimeout(() => finish(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);

  const js = (fn, ...args) => contents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`, true);
  const record = (results) => Object.assign(report.checks, results);

  try {
    await loaded(contents);
    report.url = contents.getURL();
    const page = await js(() => ({ type: document.contentType, root: Boolean(document.getElementById('root')) }));
    record({ page: report.url === startUrl && page.type === 'text/html' });
    if (page.root) {
      const deadline = Date.now() + RENDER_WAIT_MS;
      let rendered = false;
      while (!rendered && Date.now() < deadline) {
        rendered = await js(() => document.getElementById('root').childElementCount > 0);
        if (!rendered) await delay(250);
      }
      record({ appRendered: rendered });
    }
    record({ noCspViolationsOnLoad: !consoleLines.some((line) => line.includes('Content Security Policy')) });

    record(await js(rendererEnvironment, origin, origin.startsWith('app:')));

    // Secrets: set in the page, inspect the file here, then read back and delete.
    if (keyring === 'os') {
      await js((s) => window.trazoNative.secrets.set(s.name, s.value), SECRET);
      const stored = JSON.parse(fs.readFileSync(secretsFile, 'utf8'))[SECRET.name];
      const raw = Buffer.from(stored ?? '', 'base64');
      record({
        secretsFileMode0600: (fs.statSync(secretsFile).mode & 0o777) === 0o600,
        secretEncryptedAtRest: Boolean(stored) && !raw.toString('utf8').includes('smoke'),
        secretDecrypts: Boolean(stored) && safeStorage.decryptString(raw) === SECRET.value,
      });
      record(await js(secretsRoundTrip, SECRET));
    } else {
      record(await js(secretsRefused, SECRET));
    }

    record(await js(filesRoundTrip));
    const file = savedFile();
    record({ savedFileMode0600: Boolean(file) && (fs.statSync(file).mode & 0o777) === 0o600 });

    record(await js(externalLinks));
    await js(() => {
      location.assign('https://example.com/navigate');
      return true;
    });
    await delay(750);
    record({
      navigationBlocked: contents.getURL() === report.url,
      externalOpenedOnlyHttps:
        ['https://example.com/link', 'https://example.com/popup', 'https://example.com/navigate'].every((u) =>
          opened.includes(u),
        ) && opened.every((u) => u.startsWith('https:')),
    });
    finish();
  } catch (err) {
    finish(err);
  }
}

function loaded(contents) {
  return new Promise((resolve, reject) => {
    contents.once('did-finish-load', resolve);
    contents.once('did-fail-load', (_event, code, description, url) =>
      reject(new Error(`load failed: ${description} (${code}) ${url}`)),
    );
  });
}

/** Chromium keeps writing to the profile while it shuts down, so a detached shell deletes it afterwards. */
function removeWhenExited(dir) {
  if (!path.basename(dir).startsWith('trazo-smoke-')) return;
  const script = 'i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 600 ]; do sleep 0.2; i=$((i+1)); done; rm -rf -- "$2"';
  spawn('/bin/sh', ['-c', script, 'sh', String(process.pid), dir], { detached: true, stdio: 'ignore' }).unref();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The functions below are serialized and run in the page (main world): no closures.

async function rendererEnvironment(expectedOrigin, appScheme) {
  const r = {};
  const bridge = window.trazoNative;
  r.bridgeShape =
    Boolean(bridge) &&
    (bridge.keyring === 'os' || bridge.keyring === 'none') &&
    ['get', 'set', 'delete'].every((k) => typeof bridge.secrets?.[k] === 'function') &&
    typeof bridge.files?.save === 'function' &&
    typeof bridge.files?.open === 'function' &&
    typeof bridge.openExternal === 'function';
  r.bridgeFrozen = Boolean(bridge) && Object.isFrozen(bridge) && Object.isFrozen(bridge.secrets);
  r.noNodeInPage =
    typeof require === 'undefined' &&
    typeof process === 'undefined' &&
    typeof module === 'undefined' &&
    typeof Buffer === 'undefined';
  r.secureContext = window.isSecureContext && location.origin === expectedOrigin;
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    r.cryptoSubtle = hex === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' && key instanceof CryptoKey;
  } catch {
    r.cryptoSubtle = false;
  }
  r.indexedDB = await new Promise((resolve) => {
    const name = `trazo-smoke-${Date.now()}`;
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => resolve(false);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(new Uint8Array([1, 2, 3]), 'k');
      tx.onerror = () => resolve(false);
      tx.oncomplete = () => {
        const get = db.transaction('kv').objectStore('kv').get('k');
        get.onerror = () => resolve(false);
        get.onsuccess = () => {
          db.close();
          indexedDB.deleteDatabase(name);
          resolve(get.result instanceof Uint8Array && get.result[2] === 3);
        };
      };
    };
  });
  r.wasmAllowed = await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(
    (m) => m instanceof WebAssembly.Module,
    () => false,
  );
  if (appScheme) {
    const traversal = await Promise.all(
      ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/assets/..%2f..%2f..%2fpackage.json'].map((p) =>
        fetch(p).then((res) => res.status, () => 0),
      ),
    );
    r.pathTraversalBlocked = traversal.every((status) => status === 403 || status === 404);
  }
  try {
    (0, eval)('1');
    r.cspBlocksEval = false;
  } catch (err) {
    r.cspBlocksEval = err instanceof EvalError;
  }
  r.cspBlocksRemoteImage = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    document.addEventListener('securitypolicyviolation', (e) => {
      if (e.blockedURI.includes('example.invalid')) {
        clearTimeout(timer);
        resolve(e.effectiveDirective === 'img-src');
      }
    });
    new Image().src = 'https://example.invalid/smoke.png';
  });
  return r;
}

async function secretsRoundTrip(secret) {
  const s = window.trazoNative.secrets;
  const rejects = (fn) => fn().then(() => false, () => true);
  const readBack = (await s.get(secret.name)) === secret.value;
  await s.delete(secret.name);
  const deleted = (await s.get(secret.name)) === null;
  return {
    secretRoundTrip: readBack && deleted,
    secretMissingIsNull: (await s.get('smoke:never-set')) === null,
    secretBadNameRejected: (await rejects(() => s.set('../escape', 'x'))) && (await rejects(() => s.get('a b'))),
    secretBadValueRejected: await rejects(() => s.set(secret.name, 42)),
  };
}

async function secretsRefused(secret) {
  const s = window.trazoNative.secrets;
  const rejects = (fn) => fn().then(() => false, () => true);
  return {
    secretsRefusedWithoutKeyring: (await rejects(() => s.get(secret.name))) && (await rejects(() => s.set(secret.name, 'x'))),
  };
}

async function filesRoundTrip() {
  const f = window.trazoNative.files;
  const rejects = (fn) => fn().then(() => false, () => true);
  const backing = Uint8Array.from({ length: 64 }, (_, i) => i * 4);
  const view = backing.subarray(8, 24); // offset view: only these 16 bytes may be written
  const saved = await f.save('smoke-check.bin', view);
  const picked = await f.open(['.bin', 'json']);
  return {
    fileSaved: saved === true,
    fileOpenedName: picked?.name === 'smoke-check.bin',
    fileOpenedBytes:
      picked?.data instanceof Uint8Array && picked.data.length === view.length && view.every((b, i) => picked.data[i] === b),
    fileBadArgsRejected:
      (await rejects(() => f.save('../escape.bin', view))) &&
      (await rejects(() => f.save('x.bin', 'not bytes'))) &&
      (await rejects(() => f.open('json'))),
  };
}

async function externalLinks() {
  const open = window.trazoNative.openExternal;
  const rejects = (fn) => fn().then(() => false, () => true);
  return {
    openExternalHttps: !(await rejects(() => open('https://example.com/link'))),
    openExternalOthersRejected:
      (await rejects(() => open('http://example.com/'))) &&
      (await rejects(() => open('file:///etc/hostname'))) &&
      (await rejects(() => open('javascript:void 0'))),
    windowOpenDenied: window.open('https://example.com/popup', '_blank') === null,
  };
}
