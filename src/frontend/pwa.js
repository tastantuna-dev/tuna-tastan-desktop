// S3 PWA foundation: service worker registration only, browser/PWA path
// only. Inside Electron the app:// protocol already serves fresh files
// with no-cache (see standaloneProtocol.cjs) - registering a second cache
// layer there would be redundant and is deliberately skipped, matching
// the progressive-enhancement pattern already used elsewhere in this app
// (window.tunaDesktop?.desktop).
(function () {
  const isElectron = !!(window.tunaDesktop && window.tunaDesktop.desktop);
  if (isElectron) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    // Found live on the S5 production deploy (PS-153): some browsers
    // enforce Trusted Types on ServiceWorkerContainer.register() and
    // reject a bare string ("This document requires 'TrustedScriptURL'
    // assignment"). Our CSP declares no `trusted-types` allowlist, so
    // policy creation itself stays unrestricted - feature-detected, so
    // browsers without Trusted Types just use the plain string as before.
    let swUrl = 'sw.js';
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
      const policy = window.trustedTypes.createPolicy('tuna-sw', { createScriptURL: (url) => url });
      swUrl = policy.createScriptURL('sw.js');
    }
    navigator.serviceWorker.register(swUrl).catch((err) => {
      console.warn('[Tuna] service worker registration failed:', err.message);
    });
  });
})();
