// Launch-at-login, backed entirely by Electron's built-in
// app.setLoginItemSettings/getLoginItemSettings (no registry editing, no
// dependency). Mutation is only ever allowed on a packaged build - in dev,
// process.execPath points at the bare electron.exe running this folder, so
// writing a login item there would register a meaningless/broken entry.
const { app } = require('electron');

function isStartupSupported() {
  return app.isPackaged;
}

function getOpenAtLogin() {
  if (!app.isPackaged) return false;
  return app.getLoginItemSettings().openAtLogin;
}

// Always returns the REAL resulting OS state (read back after writing),
// never the caller's requested value - callers must not assume the toggle
// succeeded just because they asked for it.
function setOpenAtLogin(enabled, logger) {
  if (!app.isPackaged) {
    if (logger) logger.warn('startup toggle ignored: not a packaged build (dev mode)');
    return false;
  }
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath });
  return app.getLoginItemSettings().openAtLogin;
}

function wasOpenedAtLogin() {
  if (!app.isPackaged) return false;
  return app.getLoginItemSettings().wasOpenedAtLogin === true;
}

module.exports = { isStartupSupported, getOpenAtLogin, setOpenAtLogin, wasOpenedAtLogin };
