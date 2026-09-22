// Creates the Supabase client with the environment-appropriate auth storage
// adapter (electronAuthStorage.js inside this Electron shell,
// browserAuthStorage.js on the PWA/browser path - see that file for the
// documented tradeoff). Returns null when not configured (no
// TUNA_SUPABASE_URL/ANON_KEY set up yet) so the rest of the app can fall
// back to the S1 local-only data store without erroring.
window.TunaSupabase = (function () {
  let clientPromise = null;

  async function getClient() {
    if (clientPromise) return clientPromise;
    clientPromise = (async () => {
      const isElectron = !!(window.tunaDesktop && window.tunaDesktop.desktop);
      const config = isElectron
        ? await window.tunaDesktop.standalone.getConfig()
        // browser/PWA path (S3): injected at build/deploy time by
        // tools/generate-browser-config.ps1 into config.js - see
        // config.example.js for why these values are safe to ship.
        : (window.TUNA_BROWSER_CONFIG || { configured: false });
      if (!config.configured) return null;

      const storage = isElectron ? window.TunaElectronAuthStorage : window.TunaBrowserAuthStorage;
      return window.supabase.createClient(config.url, config.anonKey, {
        auth: {
          storage,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      });
    })();
    return clientPromise;
  }

  return { getClient };
})();
