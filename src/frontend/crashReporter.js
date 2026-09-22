// Release Hardening phase: forwards uncaught renderer errors/rejections to
// the main-process diagnostics log (window.tunaDesktop.logError, Electron
// only - on the PWA/browser path this just uses console.error, since there
// is no main process to forward to). Loaded FIRST in index.html so it can
// catch errors from every other script's own load/init, not just app.js's
// later code.
//
// Never includes: exception message/stack could theoretically be
// influenced by user-entered task/list text if a future bug interpolates
// it into a thrown Error - truncated hard at a small length specifically
// so that scenario can never leak a large chunk of private task content
// into the shared diagnostics log. main.cjs's sanitizeLogMessage() also
// redacts anything token/JWT-shaped as a second, independent layer.
(function () {
  const MAX_LEN = 300;
  function report(prefix, detail) {
    const message = `${prefix}: ${String(detail).slice(0, MAX_LEN)}`;
    if (window.tunaDesktop && window.tunaDesktop.logError) {
      window.tunaDesktop.logError(message);
    } else {
      console.error('[Tuna]', message);
    }
  }

  window.addEventListener('error', (event) => {
    report('uncaught error', `${event.message} at ${event.filename}:${event.lineno}`);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason && event.reason.message ? event.reason.message : event.reason;
    report('unhandled rejection', reason);
  });
})();
