// Tuna Tastan desktop shell - Standalone Migration S4/S6
// Scope: retires the ChatGPT-hosted remote runtime and its auth-window
// isolation entirely. The standalone local frontend (app://tuna) is now the
// sole, unconditional production origin; Supabase is the sole auth/data
// backend. See STANDALONE_MIGRATION_S4 report for the pre-retirement audit
// and KEEP/REMOVE/REPLACE decisions this file reflects. S6 added minimal
// native auto-update (electron-updater + GitHub Releases) - see
// lib/updater.cjs.
//
// Deferred to a later phase: NSIS/signing, downloads manager, file/clipboard
// bridge, taskbar progress/badge, global shortcuts.
const { app, BrowserWindow, Menu, shell, screen, Notification, ipcMain, protocol } = require('electron');
const path = require('path');
const { Logger } = require('./lib/logger.cjs');
const { createWindowStateKeeper } = require('./lib/windowState.cjs');
const { createLifecycle } = require('./lib/lifecycle.cjs');
const { createTray } = require('./lib/tray.cjs');
const startup = require('./lib/startup.cjs');
const standaloneProtocol = require('./lib/standaloneProtocol.cjs');
const { loadSupabaseConfig } = require('./lib/config.cjs');
const { createAuthStorage } = require('./lib/authStorage.cjs');
const { createUpdater } = require('./lib/updater.cjs');
const { createDiagnosticsBundle } = require('./lib/diagnostics.cjs');

// Must match electron-builder's build.appId exactly (package.json).
const APP_USER_MODEL_ID = 'com.tastantuna.tunatastan';

const FRONTEND_ROOT = path.join(__dirname, 'frontend');
const STANDALONE_URL = `${standaloneProtocol.SCHEME}://${standaloneProtocol.HOST}/index.html`;
const STANDALONE_HOST = standaloneProtocol.HOST;
// Must be called before app.whenReady() regardless - Electron requires
// privileged scheme declarations this early.
standaloneProtocol.registerSchemePrivileges(protocol);

// Public (anon/publishable) Supabase config only - see src/lib/config.cjs.
// A service_role/admin key must never be loaded here or anywhere in this
// app; there is no server component that would legitimately need one.
//
// Found live in S5 production packaging (PS-154): __dirname resolves
// INSIDE app.asar once packaged, so path.join(__dirname, '..') pointed at
// the asar root - config/local.json (deliberately never bundled inside
// the asar, since it's gitignored dev-machine state) was silently
// unreachable there, so every packaged build launched with
// supabaseConfigured=false and no session/data ever loaded. electron-
// builder's `extraResources` now copies config/local.json next to the
// asar (resources/config/local.json) at build time; app.isPackaged
// selects that real on-disk location instead of the asar-internal one.
const CONFIG_ROOT = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const SUPABASE_CONFIG = loadSupabaseConfig(CONFIG_ROOT);
let authStorage; // created in whenReady, once userData is available

const MAX_RENDERER_LOG_MESSAGE_LENGTH = 2000;

let logger;
let mainWindow = null;
let tray = null;
let updater = null;
const lifecycle = createLifecycle();

// Single source of truth for "what is this URL, and how should we handle
// it" - used by every navigation/popup/redirect/IPC-trust decision so none
// of them can drift apart. Exact protocol + host checks only, never
// substring/startsWith (bypassable by e.g. "<host>.evil.com").
//
// Only two kinds remain post-S4: our own local standalone shell (the sole
// trusted "app" origin - no remote origin exists anymore), and everything
// else, which either goes to the system browser (http/https "external") or
// is blocked and logged. There is no "auth" kind: Supabase's email
// OTP/magic-link flow never opens a popup or navigates the window - see
// src/frontend/lib/authService.js, which only ever makes API calls - so the
// auth-window-isolation architecture (S2.1) has no standalone-path caller
// and was removed rather than kept unused.
function classifyUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { kind: 'blocked', reason: 'malformed URL' };
  }
  if (url.protocol === `${standaloneProtocol.SCHEME}:` && url.host === STANDALONE_HOST) return { kind: 'app', url };
  if (url.protocol === 'https:' || url.protocol === 'http:') return { kind: 'external', url };
  return { kind: 'blocked', reason: `unsupported scheme "${url.protocol}"` };
}

function isAppOrigin(urlString) {
  return classifyUrl(urlString).kind === 'app';
}

// origin+pathname only - never query string/hash/credentials, which can
// carry tokens/state. Used only for diagnostic log lines.
function safeUrlForLog(urlString) {
  try {
    const u = new URL(urlString);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}

// title/body must never contain tokens, cookies, auth URLs, full local
// paths, or other sensitive data - only short, static, human-facing text.
// `topic` is an optional dedupe key: repeats of the same topic within
// NOTIFY_COOLDOWN_MS are silently dropped so a flapping condition can't spam
// the user.
const NOTIFY_COOLDOWN_MS = 10000;
const notifyLastSentAt = new Map();
// `onClick` lets a specific call site (e.g. the S6 updater's "ready to
// install" notification) override the default click behavior; every other
// caller keeps the original default of just focusing the main window.
function notify(title, body, topic, onClick) {
  try {
    if (!Notification.isSupported()) return;
    if (topic) {
      const last = notifyLastSentAt.get(topic) || 0;
      if (Date.now() - last < NOTIFY_COOLDOWN_MS) return;
      notifyLastSentAt.set(topic, Date.now());
    }
    const n = new Notification({ title, body, silent: true });
    n.on('click', () => {
      if (onClick) { onClick(); return; }
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.flashFrame(false);
    });
    n.show();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
      mainWindow.flashFrame(true);
    }
  } catch (err) {
    logger.warn(`notification failed: ${err.message}`);
  }
}

// Local-only reload: Ctrl+R / F5 and the local reload shortcut both route
// through this, reloading the canonical local shell directly. Unlike the
// retired remote path, this never fails from a network condition (the
// shell is served from disk via app://tuna), so there is no retry/backoff
// state machine here anymore - a plain reload is the whole story.
function reloadStandalone(win) {
  logger.info(`reloading local shell ${STANDALONE_URL}`);
  win.loadURL(STANDALONE_URL).catch((err) => logger.warn(`reload failed: ${err.message}`));
}

function createWindow() {
  const primaryWorkArea = screen.getPrimaryDisplay().workAreaSize;
  const defaults = {
    width: 1440,
    height: 900,
    x: Math.max(0, Math.round((primaryWorkArea.width - 1440) / 2)),
    y: Math.max(0, Math.round((primaryWorkArea.height - 900) / 2)),
    isMaximized: false,
  };
  const windowState = createWindowStateKeeper({
    userDataDir: app.getPath('userData'),
    screen,
    defaults,
  });

  const win = new BrowserWindow({
    title: 'Tuna Tastan',
    x: windowState.state.x,
    y: windowState.state.y,
    width: windowState.state.width,
    height: windowState.state.height,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#f7f5f1',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  });

  if (windowState.state.isMaximized) win.maximize();
  // Launched via the OS login item: start hidden in the tray rather than
  // popping a window the user didn't ask to see right now. A normal manual
  // launch still shows immediately, as before.
  if (!startup.wasOpenedAtLogin()) {
    win.once('ready-to-show', () => win.show());
  }
  windowState.track(win);
  win.on('focus', () => win.flashFrame(false));

  // Close/quit lifecycle: native X, Alt+F4, and a page's own window.close()
  // all fire this same 'close' event with no way to tell them apart. V3
  // resolves it with an explicit, single quit-intent flag (lifecycle.cjs)
  // instead of guessing: unless something has actually called app.quit()
  // (Tray "Cikis", which triggers 'before-quit' first), a close request
  // just hides the window to the tray.
  win.on('close', (event) => {
    logger.info(`window close requested (isQuitting=${lifecycle.isQuitting()}), last url: ${win.webContents.getURL()}`);
    if (!lifecycle.isQuitting()) {
      event.preventDefault();
      win.hide();
    }
  });

  // Local-only reload: Ctrl+R / F5. Attached only to the main window's
  // webContents.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isCtrlR = input.control && !input.shift && !input.alt && input.key.toLowerCase() === 'r';
    const isF5 = input.key === 'F5';
    if (!isCtrlR && !isF5) return;
    event.preventDefault();
    logger.info('local reload shortcut triggered');
    reloadStandalone(win);
  });

  // Popups: app-origin popups get a plain, hardened window; everything else
  // is either handed to the system browser (http/https) or blocked and
  // logged (unknown schemes). There is no auth-popup case anymore.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const decision = classifyUrl(url);
    if (decision.kind === 'app') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    if (decision.kind === 'external') {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    logger.warn(`BLOCKED popup: ${url} (${decision.reason})`);
    return { action: 'deny' };
  });

  // Same-window navigation: only the app's own local origin may navigate
  // the main window in place. Everything else goes to the system browser
  // (http/https) or is blocked and logged.
  win.webContents.on('will-navigate', (event, url) => {
    const decision = classifyUrl(url);
    if (decision.kind === 'app') return;
    event.preventDefault();
    if (decision.kind === 'external') {
      shell.openExternal(url);
    } else {
      logger.warn(`BLOCKED navigation: ${url} (${decision.reason})`);
    }
  });

  // Same policy as will-navigate, but for server-side HTTP redirects. The
  // standalone shell never issues one (it is local, static files), but this
  // stays as defense in depth against any future https: content this
  // window might ever load.
  win.webContents.on('will-redirect', (event, url) => {
    const decision = classifyUrl(url);
    if (decision.kind === 'app') return;
    event.preventDefault();
    if (decision.kind === 'external') {
      shell.openExternal(url);
    } else {
      logger.warn(`BLOCKED redirect: ${url} (${decision.reason})`);
    }
  });

  // Deny every permission request (camera, mic, geolocation, ...) except
  // notifications from the app's own origin.
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const requestingUrl = webContents.getURL();
    const allowed = permission === 'notifications' && isAppOrigin(requestingUrl);
    if (!allowed) logger.info(`denied permission "${permission}" for ${requestingUrl}`);
    callback(allowed);
  });

  win.webContents.on('certificate-error', (event, url, error) => {
    // Do not silently trust bad certificates; log and let Chromium's
    // default (reject) behavior stand.
    logger.error(`certificate error for ${url}: ${error}`);
  });

  // Diagnostic only. The local shell loads from disk via app://tuna and
  // does not experience network-load failures the way the retired remote
  // path did, so there is no retry/offline-fallback state machine here
  // anymore - a failure here would mean something is genuinely wrong with
  // the local install, worth logging but not worth a bespoke recovery UI.
  win.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = ERR_ABORTED (e.g. our own navigation)
    logger.error(`did-fail-load ${errorCode} ${errorDescription} for ${safeUrlForLog(validatedURL)}`);
  });

  win.webContents.on('did-navigate', (event, url) => {
    logger.info(`did-navigate: url=${safeUrlForLog(url)} isAppOrigin=${isAppOrigin(url)}`);
  });

  win.webContents.on('render-process-gone', (event, details) => {
    logger.error(`renderer process gone: ${details.reason}`);
  });
  win.webContents.on('unresponsive', () => logger.warn('renderer unresponsive'));
  win.webContents.on('responsive', () => logger.info('renderer responsive again'));

  // The local standalone shell is the sole, unconditional production
  // origin - no remote URL, no TUNA_STANDALONE env var gate.
  logger.info(`loading local shell ${STANDALONE_URL}`);
  win.loadURL(STANDALONE_URL);
  return win;
}

// Every renderer->main IPC handler must call this first. The main window's
// preload is the only place any of these channels are exposed from, so this
// is defense in depth against a future channel being reachable from
// somewhere it shouldn't be: the sender's webContents must literally be
// mainWindow's, AND its current URL must classify as the local app origin.
// A single trust tier now covers every channel, including the S2 auth/data
// bridge - previously that bridge used a stricter, separate check
// (assertStandaloneSender) because the general channels also had to accept
// the retired offline.html fallback page; with that page gone, both checks
// were identical, so they were collapsed into this one function.
function assertAppSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (event.sender !== mainWindow.webContents) return false;
  return isAppOrigin(event.senderFrame.url);
}

// Strips control characters (including CR/LF, which could otherwise forge
// extra fake log lines), caps length, and redacts anything token/secret-
// shaped (Release Hardening phase - defense in depth: renderer log/error
// text is always supposed to be plain human-facing strings, never a
// token, but a future bug could accidentally interpolate one into a
// thrown Error message, and this is the one narrow point every renderer
// log line already passes through).
const REDACT_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-_.]+/gi, // Authorization header values
  /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g, // JWT-shaped (access/refresh tokens)
  /sb-[a-z0-9-]+-auth-token[^\s]*/gi, // Supabase auth storage key + any adjacent value
];
function sanitizeLogMessage(raw) {
  let msg = String(raw).slice(0, MAX_RENDERER_LOG_MESSAGE_LENGTH);
  for (const pattern of REDACT_PATTERNS) msg = msg.replace(pattern, '[redacted]');
  // eslint-disable-next-line no-control-regex
  return msg.replace(/[\x00-\x1f\x7f]/g, ' ');
}

function setupIpc() {
  ipcMain.on('renderer-log', (event, payload) => {
    if (!assertAppSender(event)) {
      logger.warn('rejected renderer-log from untrusted IPC sender');
      return;
    }
    const level = payload && payload.level === 'error' ? 'error' : 'info';
    const message = payload && typeof payload.message === 'string'
      ? sanitizeLogMessage(payload.message)
      : '(no message)';
    logger[level](`[renderer] ${message}`);
  });

  // Standalone auth/data bridge. Public config only (anon key is meant to
  // be client-visible by design - this is not a secret).
  ipcMain.handle('standalone-config:get', (event) => {
    if (!assertAppSender(event)) {
      logger.warn('rejected standalone-config:get from untrusted IPC sender');
      return { url: null, anonKey: null, configured: false };
    }
    return SUPABASE_CONFIG;
  });

  // Narrow, named key/value operations only - never a generic
  // readFile/writeFile-shaped channel. Keys are further restricted to
  // Supabase's own session-key pattern inside authStorage.cjs. Values (the
  // encrypted session) never touch the log.
  ipcMain.handle('auth-storage:get', (event, key) => {
    if (!assertAppSender(event) || !authStorage) { logger.warn('rejected auth-storage:get from untrusted IPC sender'); return null; }
    return authStorage.getItem(key);
  });
  ipcMain.handle('auth-storage:set', (event, key, value) => {
    if (!assertAppSender(event) || !authStorage) { logger.warn('rejected auth-storage:set from untrusted IPC sender'); return false; }
    return authStorage.setItem(key, value);
  });
  ipcMain.handle('auth-storage:remove', (event, key) => {
    if (!assertAppSender(event) || !authStorage) { logger.warn('rejected auth-storage:remove from untrusted IPC sender'); return false; }
    return authStorage.removeItem(key);
  });
}

// --- Single instance ---
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.setName('Tuna Tastan');
  // Must be set before whenReady for Windows to reliably associate
  // notifications/taskbar grouping with this identity. Kept identical to
  // package.json's build.appId - deliberately does NOT touch userData path,
  // package name, or productName (existing session/log/window-state on disk
  // are untouched).
  app.setAppUserModelId(APP_USER_MODEL_ID);

  app.whenReady().then(() => {
    logger = new Logger(path.join(app.getPath('userData'), 'logs'));
    logger.info(
      `app ready, version ${app.getVersion()}, AUMID ${APP_USER_MODEL_ID}, `
      + `supabaseConfigured=${SUPABASE_CONFIG.configured}`
    );
    authStorage = createAuthStorage(app.getPath('userData'));
    updater = createUpdater({ app, logger, notify });
    standaloneProtocol.setupProtocolHandler(protocol, FRONTEND_ROOT);
    setupIpc();
    Menu.setApplicationMenu(null);
    mainWindow = createWindow();
    tray = createTray({
      iconPath: path.join(__dirname, 'icon.png'),
      logger,
      showMainWindow: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      },
      hideMainWindow: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
      },
      // Explicit app.quit() only (never app.exit(), which skips
      // before-quit/will-quit and would bypass this whole lifecycle model).
      // before-quit fires as part of this call, before any window's
      // 'close' event, so lifecycle.isQuitting() is already true by the
      // time the close handler above runs.
      quitApp: () => app.quit(),
      checkForUpdates: () => updater.checkForUpdates(),
      createDiagnosticsBundle: () => createDiagnosticsBundle({
        app, logger, shell,
        supabaseConfigured: SUPABASE_CONFIG.configured,
        updaterState: updater.getState(),
      }),
      startup,
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });

    // S6: delayed (never on the critical startup path) and entirely
    // best-effort - see lib/updater.cjs for why every failure mode here is
    // just a log line, never a blocked/crashed app.
    setTimeout(() => updater.checkForUpdates(), 10000);
  });

  // The single, exclusive place lifecycle's quit-intent flag is written.
  // Fires for app.quit() (Tray "Cikis") and, best-effort, some OS-level
  // quit signals - but is NOT guaranteed on every Windows shutdown/logoff
  // path, and nothing here assumes otherwise (see lifecycle.cjs). Never
  // call event.preventDefault() in this handler: doing so would risk
  // blocking OS shutdown, which this app must never do.
  app.on('before-quit', () => {
    lifecycle.markQuitting();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  process.on('uncaughtException', (err) => {
    if (logger) logger.error(`uncaughtException: ${err.stack || err.message}`);
  });

  // Release Hardening: main-process promise rejections had no handler at
  // all before this - they were silently swallowed, the single biggest
  // gap in crash visibility (found via audit, not a reported symptom).
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    if (logger) logger.error(`unhandledRejection: ${detail}`);
  });

  // GPU/utility/network process crashes (distinct from a renderer crash,
  // already handled per-window above) - Electron 28+.
  app.on('child-process-gone', (event, details) => {
    if (logger) logger.error(`child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
  });
}
