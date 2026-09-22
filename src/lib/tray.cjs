// System tray icon + menu. Holds no window/auth state itself - everything
// it needs (show/hide/quit/close-auth callbacks, the startup helper) is
// injected by main.cjs, so this module stays a thin, testable wiring layer.
const { Tray, Menu, nativeImage } = require('electron');

// Kept at module scope in addition to whatever the caller stores: an
// unreferenced Tray gets garbage-collected and its icon silently vanishes -
// a well-known Electron footgun. This reference outlives any single call.
let trayRef = null;

function buildTrayIcon(iconPath) {
  const full = nativeImage.createFromPath(iconPath);
  if (full.isEmpty()) return full;
  // Runtime resize of the existing app icon keeps this dependency-free and
  // needs no build step. A hand-authored multi-size .ico can replace this
  // later without changing any call site - see the audit note in the report.
  return full.resize({ width: 32, height: 32, quality: 'best' });
}

function createTray({ iconPath, logger, showMainWindow, hideMainWindow, quitApp, checkForUpdates, startup }) {
  const tray = new Tray(buildTrayIcon(iconPath));
  trayRef = tray;
  tray.setToolTip('Tuna Tastan');
  if (logger) logger.info(`tray bounds: ${JSON.stringify(tray.getBounds())}`);

  function buildMenu() {
    const startupSupported = startup.isStartupSupported();
    return Menu.buildFromTemplate([
      { label: 'Göster', click: () => showMainWindow() },
      {
        label: 'Gizle',
        click: () => hideMainWindow(),
      },
      { type: 'separator' },
      {
        label: 'Başlangıçta çalıştır',
        type: 'checkbox',
        checked: startup.getOpenAtLogin(),
        enabled: startupSupported,
        click: (menuItem) => {
          const actual = startup.setOpenAtLogin(menuItem.checked, logger);
          // Never trust the click's own checked state as the new truth -
          // read it back from the OS and re-render the menu to match it.
          tray.setContextMenu(buildMenu());
          void actual;
        },
      },
      { type: 'separator' },
      { label: 'Güncellemeleri kontrol et', click: () => checkForUpdates() },
      { type: 'separator' },
      { label: 'Çıkış', click: () => quitApp() },
    ]);
  }

  tray.setContextMenu(buildMenu());
  // A left-click always shows/focuses - "Gizle" in the context menu already
  // covers hiding, so click does not need to toggle (see audit deviation
  // note: this differs from a naive show/hide toggle on purpose).
  tray.on('click', () => showMainWindow());

  return tray;
}

module.exports = { createTray };
