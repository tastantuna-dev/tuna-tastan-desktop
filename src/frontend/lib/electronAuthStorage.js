// Supabase-compatible storage adapter ({getItem,setItem,removeItem}, sync or
// Promise-returning - Supabase supports both). Proxies every call to the
// main process over the narrow auth-storage IPC bridge instead of using
// localStorage - the renderer never holds the raw encryption key or touches
// the filesystem directly. Falls back to an in-memory Map when
// window.tunaDesktop isn't present (plain browser/PWA - see
// browserAuthStorage.js for that path's own, explicit decision).
window.TunaElectronAuthStorage = (function () {
  const bridge = window.tunaDesktop && window.tunaDesktop.standalone && window.tunaDesktop.standalone.authStorage;
  if (!bridge) return null; // not running inside the Electron shell

  return {
    async getItem(key) {
      return bridge.getItem(key);
    },
    async setItem(key, value) {
      await bridge.setItem(key, value);
    },
    async removeItem(key) {
      await bridge.removeItem(key);
    },
  };
})();
