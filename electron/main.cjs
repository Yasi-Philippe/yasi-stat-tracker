'use strict';

/**
 * Trazo desktop shell (Electron main process).
 *
 * Serves the built web app (dist/) from the private origin app://trazo, keeps the
 * renderer locked down (sandbox, context isolation, CSP, no navigation away from the
 * app) and answers the native bridge exposed by preload.cjs
 * (contract: src/platform/electron.ts).
 *
 * Environment:
 *   VITE_DEV_SERVER_URL  load this dev server instead of dist/ (scripts/electron-dev.mjs)
 *   TRAZO_SMOKE=1        hidden, headless self-test with a throw-away profile (smoke.cjs)
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
} = require('electron');

const APP_NAME = 'Trazo';
const SCHEME = 'app';
const APP_HOST = 'trazo';
const APP_ORIGIN = `${SCHEME}://${APP_HOST}`;
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PRELOAD = path.join(__dirname, 'preload.cjs');
const ICON = path.join(__dirname, '..', 'build', 'icons', '512x512.png');
const BACKGROUND = '#0A0B0F';
const MIN_SIZE = { width: 380, height: 600 };
const DEFAULT_SIZE = { width: 1100, height: 780 };

const SMOKE = process.env.TRAZO_SMOKE === '1';
const DEV_URL = devServerUrl(process.env.VITE_DEV_SERVER_URL);
const START_URL = DEV_URL || `${APP_ORIGIN}/index.html`;
const TRUSTED_ORIGIN = DEV_URL ? originOf(DEV_URL) : APP_ORIGIN;

const CSP = contentSecurityPolicy(DEV_URL ? TRUSTED_ORIGIN : null);

/** 127.0.0.1 is for the local Firebase emulators. The dev server is only allowed in dev mode. */
function contentSecurityPolicy(devOrigin) {
  const dev = devOrigin ? { connect: ` ${devOrigin} ${devOrigin.replace(/^http/, 'ws')}`, script: " 'unsafe-inline'" } : null;
  return [
    "default-src 'self'",
    // In dev, Vite's React refresh preamble is an inline script.
    `script-src 'self' 'wasm-unsafe-eval'${dev ? dev.script : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://firestore.googleapis.com http://127.0.0.1:* ws://127.0.0.1:*${dev ? dev.connect : ''}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const MIME_TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.pdf': 'application/pdf',
  }),
);

// IPC argument limits.
const SECRET_NAME = /^[a-z0-9:_-]{1,64}$/i;
const MAX_SECRET_CHARS = 64 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FILE_NAME = 255;
const MAX_URL_CHARS = 2048;
const MAX_EXTENSIONS = 32;
const EXTENSION = /^[a-z0-9][a-z0-9._+-]{0,15}$/i;

// ---------------------------------------------------------------------------
// Startup (everything here runs before `ready`).

app.setName(APP_NAME);
const PROFILE_DIR = SMOKE
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'trazo-smoke-'))
  : path.join(app.getPath('appData'), DEV_URL ? `${APP_NAME}-dev` : APP_NAME);
app.setPath('userData', PROFILE_DIR);

app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

/** Side effects on the desktop; the smoke test swaps them for in-memory stand-ins. */
const smoke = SMOKE ? require('./smoke.cjs').create(PROFILE_DIR) : null;
const system = smoke
  ? smoke.system
  : {
      showSaveDialog: (win, options) => dialog.showSaveDialog(win, options),
      showOpenDialog: (win, options) => dialog.showOpenDialog(win, options),
      openExternal: (url) => shell.openExternal(url),
    };

let mainWindow = null;
let keyring = 'none';

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on('web-contents-created', (_event, contents) => harden(contents));
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(onReady).catch((err) => {
    console.error('[trazo] startup failed:', err);
    app.exit(1);
  });
}

function onReady() {
  // No menu bar: on GNOME Wayland, Electron 44 crashes creating a framed window that has
  // one (and draws no title bar, hence --ozone-platform=x11 in the desktop entry and the
  // dev script). The usual shortcuts are handled in handleShortcuts() instead.
  Menu.setApplicationMenu(null);
  lockDownSession(session.defaultSession);
  protocol.handle(SCHEME, serveApp);
  keyring = detectKeyring();
  registerIpc();

  if (!DEV_URL && !fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    const message = `The app bundle is missing: ${path.join(DIST_DIR, 'index.html')}\nBuild it first with "npx vite build".`;
    console.error(`[trazo] ${message}`);
    if (!SMOKE) {
      dialog.showErrorBox(APP_NAME, message);
      app.exit(1);
      return;
    }
  }

  mainWindow = createMainWindow();
  if (smoke) {
    smoke.run({ win: mainWindow, keyring, startUrl: START_URL, origin: TRUSTED_ORIGIN, secretsFile: secretsFile() });
  }
}

// ---------------------------------------------------------------------------
// Window

function createMainWindow() {
  const state = SMOKE ? null : loadWindowState();
  const icon = nativeImage.createFromPath(ICON);
  const win = new BrowserWindow({
    ...(state ? state.bounds : DEFAULT_SIZE),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: APP_NAME,
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    ...(icon.isEmpty() ? {} : { icon }),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      additionalArguments: [`--trazo-keyring=${keyring}`],
    },
  });

  const reveal = () => {
    clearTimeout(fallback);
    if (SMOKE || win.isDestroyed() || win.isVisible()) return;
    if (state?.maximized) win.maximize();
    win.show();
  };
  // ready-to-show avoids a blank frame; the timer covers a page that never paints.
  const fallback = setTimeout(reveal, 5000);
  win.once('ready-to-show', reveal);
  if (!SMOKE) trackWindowState(win);
  handleShortcuts(win);

  win.loadURL(START_URL).catch((err) => console.error(`[trazo] could not load ${START_URL}: ${err.message}`));
  return win;
}

function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8')) || {};
  } catch {
    // First run or unreadable: defaults.
  }
  const area = screen.getPrimaryDisplay().workAreaSize;
  const size = (value, min, fallback, max) =>
    Math.min(Math.max(Number.isInteger(value) ? value : Math.min(fallback, max), min), Math.max(min, max));
  const bounds = {
    width: size(saved.width, MIN_SIZE.width, DEFAULT_SIZE.width, area.width),
    height: size(saved.height, MIN_SIZE.height, DEFAULT_SIZE.height, area.height),
  };
  if (Number.isInteger(saved.x) && Number.isInteger(saved.y) && isOnScreen({ ...bounds, x: saved.x, y: saved.y })) {
    bounds.x = saved.x;
    bounds.y = saved.y;
  }
  return { bounds, maximized: saved.maximized === true };
}

/** True if a usable part of the rectangle is on some display (monitors change). */
function isOnScreen(rect) {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(rect.x + rect.width, a.x + a.width) - Math.max(rect.x, a.x);
    const h = Math.min(rect.y + rect.height, a.y + a.height) - Math.max(rect.y, a.y);
    return w >= 120 && h >= 80;
  });
}

function trackWindowState(win) {
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    if (win.isDestroyed()) return;
    const { x, y, width, height } = win.getNormalBounds();
    try {
      writeFileAtomic(windowStateFile(), JSON.stringify({ x, y, width, height, maximized: win.isMaximized() }));
    } catch (err) {
      console.warn(`[trazo] could not save window state: ${err.message}`);
    }
  };
  const saveSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 750);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) win.on(event, saveSoon);
  win.on('close', save);
}

/** Reload, zoom, full screen, DevTools and quit shortcuts (there is no menu to carry them). */
function handleShortcuts(win) {
  const contents = win.webContents;
  const zoom = (step) => contents.setZoomLevel(step === 0 ? 0 : Math.min(3, Math.max(-3, contents.getZoomLevel() + step)));
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    let action = null;
    if (key === 'f12' || (ctrl && input.shift && key === 'i')) action = () => contents.toggleDevTools();
    else if (key === 'f5' || (ctrl && !input.shift && key === 'r')) action = () => contents.reload();
    else if (key === 'f11') action = () => win.setFullScreen(!win.isFullScreen());
    else if (ctrl && (key === '=' || key === '+')) action = () => zoom(0.5);
    else if (ctrl && key === '-') action = () => zoom(-0.5);
    else if (ctrl && key === '0') action = () => zoom(0);
    else if (ctrl && key === 'q') action = () => app.quit();
    if (!action) return;
    event.preventDefault();
    action();
  });
}

// ---------------------------------------------------------------------------
// Security

function devServerUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`VITE_DEV_SERVER_URL must be http(s): ${value}`);
  return url.href;
}

/** "scheme://host[:port]"; computed by hand because Node gives custom schemes a null origin. */
function originOf(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function isTrusted(url) {
  return typeof url === 'string' && originOf(url) === TRUSTED_ORIGIN;
}

/** Opens a web link in the system browser; anything else is dropped. */
function openInBrowser(rawUrl, { allowHttp }) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  if (url.protocol === 'https:' || (allowHttp && url.protocol === 'http:')) {
    Promise.resolve(system.openExternal(url.href)).catch((err) => console.warn(`[trazo] openExternal: ${err.message}`));
  }
}

/** Applied to every WebContents the app creates. */
function harden(contents) {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event, legacyUrl) => {
    const url = event.url ?? legacyUrl;
    if (isTrusted(url)) return;
    event.preventDefault();
    openInBrowser(url, { allowHttp: true });
  });
  contents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url, { allowHttp: false });
    return { action: 'deny' };
  });
}

function lockDownSession(ses) {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permission === 'notifications' && isTrusted(details?.requestingUrl || contents.getURL()));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return permission === 'notifications' && isTrusted(requestingOrigin);
  });
  // app:// responses carry the CSP themselves (serveApp); dev server responses get it here.
  if (DEV_URL) {
    ses.webRequest.onHeadersReceived((details, callback) => {
      if (!isTrusted(details.url)) return callback({});
      const headers = Object.entries(details.responseHeaders ?? {}).filter(
        ([name]) => name.toLowerCase() !== 'content-security-policy',
      );
      callback({ responseHeaders: { ...Object.fromEntries(headers), 'Content-Security-Policy': [CSP] } });
    });
  }
}

// ---------------------------------------------------------------------------
// app:// protocol

async function serveApp(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return textResponse(405, 'Method Not Allowed');
  const url = new URL(request.url);
  if (url.host !== APP_HOST) return textResponse(404, 'Not Found');
  const file = resolveInDist(url.pathname);
  if (!file) return textResponse(403, 'Forbidden');
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return textResponse(404, 'Not Found');
    const body = request.method === 'HEAD' ? null : await fsp.readFile(file);
    const type = MIME_TYPES.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream';
    return new Response(body, { status: 200, headers: responseHeaders(type) });
  } catch {
    return textResponse(404, 'Not Found');
  }
}

/** Maps a URL path to a file inside dist/, or null if it would escape it. */
function resolveInDist(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes('\0')) return null;
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(DIST_DIR, rel);
  const inside = path.relative(DIST_DIR, file);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return null;
  return file;
}

function responseHeaders(type) {
  return {
    'Content-Type': type,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  };
}

function textResponse(status, text) {
  return new Response(text, { status, headers: responseHeaders('text/plain; charset=utf-8') });
}

// ---------------------------------------------------------------------------
// Native bridge (IPC)

function detectKeyring() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return 'none';
    if (process.platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend();
      if (backend === 'basic_text' || backend === 'unknown') return 'none';
    }
    return 'os';
  } catch (err) {
    console.warn(`[trazo] keyring unavailable: ${err.message}`);
    return 'none';
  }
}

/** Registers a handler that only answers the app's own top-level page. */
function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    const frame = event.senderFrame;
    const trusted =
      mainWindow && event.sender === mainWindow.webContents && frame && frame.parent === null && isTrusted(frame.url);
    if (!trusted) throw new Error('Request from an untrusted frame');
    return fn(event, ...args);
  });
}

function registerIpc() {
  handle('trazo:secrets:get', (_event, name) => {
    const key = secretNameArg(name);
    requireKeyring();
    const stored = readSecrets().get(key);
    if (stored === undefined) return null;
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      throw new Error('Stored secret could not be decrypted with the current OS keyring');
    }
  });

  handle('trazo:secrets:set', (_event, name, value) => {
    const key = secretNameArg(name);
    if (typeof value !== 'string' || value.length > MAX_SECRET_CHARS) throw new TypeError('Invalid secret value');
    requireKeyring();
    const next = new Map(readSecrets());
    next.set(key, safeStorage.encryptString(value).toString('base64'));
    writeSecrets(next);
  });

  handle('trazo:secrets:delete', (_event, name) => {
    const key = secretNameArg(name);
    requireKeyring();
    const current = readSecrets();
    if (!current.has(key)) return;
    const next = new Map(current);
    next.delete(key);
    writeSecrets(next);
  });

  handle('trazo:files:save', async (event, name, data) => {
    const fileName = fileNameArg(name);
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_FILE_BYTES) throw new TypeError('Invalid file data');
    const ext = path.extname(fileName).slice(1);
    const result = await system.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      defaultPath: path.join(app.getPath('downloads'), fileName),
      filters: ext
        ? [
            { name: `${ext.toUpperCase()} file`, extensions: [ext] },
            { name: 'All files', extensions: ['*'] },
          ]
        : [],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (result.canceled || !result.filePath) return false;
    await fsp.writeFile(result.filePath, Buffer.from(data.buffer, data.byteOffset, data.byteLength), { mode: 0o600 });
    return true;
  });

  handle('trazo:files:open', async (event, extensions) => {
    const exts = extensionsArg(extensions);
    const result = await system.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      properties: ['openFile'],
      filters: exts.length
        ? [
            { name: 'Supported files', extensions: exts },
            { name: 'All files', extensions: ['*'] },
          ]
        : [],
    });
    const file = !result.canceled && result.filePaths?.[0];
    if (!file) return null;
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('Not a regular file');
    if (stat.size > MAX_FILE_BYTES) throw new Error('File is too large');
    const bytes = await fsp.readFile(file);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('File is too large');
    // Own the exact bytes so IPC never serializes a larger backing buffer.
    return { name: path.basename(file), data: new Uint8Array(bytes) };
  });

  handle('trazo:open-external', async (_event, url) => {
    if (typeof url !== 'string' || url.length > MAX_URL_CHARS) throw new TypeError('Invalid URL');
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new TypeError('Invalid URL');
    }
    if (parsed.protocol !== 'https:') throw new Error('Only https: links can be opened');
    await system.openExternal(parsed.href);
  });
}

function requireKeyring() {
  if (keyring !== 'os') throw new Error('No OS keyring available; secrets are disabled');
}

function secretNameArg(name) {
  if (typeof name !== 'string' || !SECRET_NAME.test(name)) throw new TypeError('Invalid secret name');
  return name;
}

function fileNameArg(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > MAX_FILE_NAME ||
    name === '.' ||
    name === '..' ||
    /[/\\\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new TypeError('Invalid file name');
  }
  return name;
}

function extensionsArg(extensions) {
  if (!Array.isArray(extensions) || extensions.length > MAX_EXTENSIONS) throw new TypeError('Invalid extensions');
  return extensions.map((ext) => {
    const clean = typeof ext === 'string' ? ext.replace(/^\./, '') : '';
    if (!EXTENSION.test(clean)) throw new TypeError('Invalid extension');
    return clean;
  });
}

// ---------------------------------------------------------------------------
// Secret file: { "<name>": "<base64 of safeStorage ciphertext>" }, mode 0600.

let secretsCache = null;

function secretsFile() {
  return path.join(app.getPath('userData'), 'secrets.json');
}

function readSecrets() {
  if (secretsCache) return secretsCache;
  const entries = new Map();
  let text = null;
  try {
    text = fs.readFileSync(secretsFile(), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Cannot read secrets file (${err.code})`);
  }
  if (text !== null) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Secrets file is corrupt');
    for (const [name, value] of Object.entries(data)) {
      if (SECRET_NAME.test(name) && typeof value === 'string') entries.set(name, value);
    }
  }
  secretsCache = entries;
  return entries;
}

function writeSecrets(entries) {
  // Object.fromEntries defines own properties, so a name like "__proto__" stays plain data.
  writeFileAtomic(secretsFile(), `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
  secretsCache = entries;
}

/** Write to a 0600 temp file, fsync, rename over the target. Synchronous, so writes never interleave. */
function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync is best effort.
  }
}
