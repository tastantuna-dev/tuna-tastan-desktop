// Standalone Migration S6 - minimal native auto-update via electron-updater
// + GitHub Releases (see package.json's `build.publish`). No renderer UI:
// every user-visible moment is a native notification or the tray menu's
// "Guncellemeleri kontrol et" item (added in tray.cjs) - the planner UI
// itself is untouched, per the S6 UI freeze.
//
// Design constraints (all deliberate, not oversights):
// - Only runs when app.isPackaged - `electron-updater` errors out in dev
//   (no packaged app.asar / no publish metadata to compare against), and a
//   dev session has no business checking GitHub for a newer version of
//   itself anyway.
// - Every failure path (network down, GitHub unreachable, no release yet)
//   only logs - startup is never blocked, the app never crashes, and
//   nothing here can prevent normal use of the planner/offline queue.
// - autoDownload is on (electron-updater's default) so a plain background
//   check-and-fetch needs no progress UI; the ONLY moment the user is ever
//   interrupted is a single native notification once the update is fully
//   downloaded and ready, and even then nothing installs until they
//   explicitly click it (or trigger it themselves via the tray) -
//   quitAndInstall() is never called automatically.
// - The update check itself only ever talks to GitHub's release API/CDN
//   over HTTPS via electron-updater's own client - no custom URL, no
//   renderer-reachable API, no secrets involved (public repo releases
//   need no token to read).
let autoUpdaterSingleton = null;

function getAutoUpdater() {
  if (!autoUpdaterSingleton) {
    // Lazy require: importing electron-updater in a dev (non-packaged) run
    // is harmless, but keeping it lazy means a require-time failure in this
    // dependency can never block app startup before whenReady even runs.
    autoUpdaterSingleton = require('electron-updater').autoUpdater;
  }
  return autoUpdaterSingleton;
}

function createUpdater({ app, logger, notify }) {
  let wired = false;
  // Release Hardening: minimal state for the diagnostics bundle - booleans/
  // timestamps/short enums only, never anything from the update payload
  // itself beyond the version string GitHub already publishes.
  const state = { lastCheckAt: null, lastResult: 'never-checked' };

  function wireEvents() {
    if (wired) return;
    wired = true;
    const autoUpdater = getAutoUpdater();
    autoUpdater.logger = { info: (m) => logger.info(`[updater] ${m}`), warn: (m) => logger.warn(`[updater] ${m}`), error: (m) => logger.error(`[updater] ${m}`), debug: () => {} };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false; // explicit user action only, never silent-on-quit

    autoUpdater.on('checking-for-update', () => { logger.info('[updater] checking for update'); state.lastCheckAt = new Date().toISOString(); state.lastResult = 'checking'; });
    autoUpdater.on('update-not-available', (info) => { logger.info(`[updater] no update available (current ${info.version})`); state.lastResult = 'up-to-date'; });
    autoUpdater.on('update-available', (info) => { logger.info(`[updater] update available: ${info.version}`); state.lastResult = 'update-available'; });
    autoUpdater.on('download-progress', (p) => logger.info(`[updater] downloading: ${Math.round(p.percent)}%`));
    // Never let an update-check failure be anything but a log line - a
    // GitHub outage, no releases published yet, or the user being offline
    // must never surface as an error the user sees or a blocked app.
    autoUpdater.on('error', (err) => { logger.warn(`[updater] check/download failed (non-fatal): ${err && err.message ? err.message : err}`); state.lastResult = 'error'; });
    autoUpdater.on('update-downloaded', (info) => {
      logger.info(`[updater] update ${info.version} downloaded, ready to install`);
      state.lastResult = 'downloaded';
      notify(
        'Tuna Tastan guncellemesi hazir',
        `Surum ${info.version} indirildi. Uygulamayi yeniden baslatmak icin tikla.`,
        'update-ready',
        () => quitAndInstall()
      );
    });
  }

  function checkForUpdates() {
    if (!app.isPackaged) {
      logger.info('[updater] skipped: not a packaged build');
      return;
    }
    try {
      wireEvents();
      getAutoUpdater().checkForUpdates().catch((err) => {
        logger.warn(`[updater] checkForUpdates rejected (non-fatal): ${err.message}`);
      });
    } catch (err) {
      logger.warn(`[updater] checkForUpdates threw (non-fatal): ${err.message}`);
    }
  }

  // Only called from an explicit user action (notification click, tray
  // "restart to update" if ever added) - never automatically.
  function quitAndInstall() {
    if (!app.isPackaged) return;
    try {
      getAutoUpdater().quitAndInstall();
    } catch (err) {
      logger.warn(`[updater] quitAndInstall failed: ${err.message}`);
    }
  }

  function getState() {
    return { ...state, packaged: app.isPackaged };
  }

  return { checkForUpdates, quitAndInstall, getState };
}

module.exports = { createUpdater };
