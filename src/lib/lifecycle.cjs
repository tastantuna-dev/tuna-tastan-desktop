// Single quit-intent flag. The window 'close' handler uses this - and only
// this - to decide "hide to tray" vs "let the close proceed". It is written
// in exactly one place: app.on('before-quit'), which fires as part of
// app.quit() (our own Tray "Cikis" action) before any window's 'close'
// event runs, so ordering is reliable for that path.
//
// Windows shutdown/logoff is NOT guaranteed to fire 'before-quit' before
// closing our windows (Electron does not promise this cross-version). This
// module does not try to detect or special-case that: if it happens, the
// window's normal close handling (hide, not prevent-forever) still applies,
// and Windows' own session-end protocol (WM_QUERYENDSESSION / forced
// termination after timeout) is what actually guarantees the OS can shut
// down - not anything in this app. See the close handler in main.cjs.
function createLifecycle() {
  let quitting = false;
  return {
    isQuitting() {
      return quitting;
    },
    markQuitting() {
      quitting = true;
    },
  };
}

module.exports = { createLifecycle };
