// PWA/plain-browser auth storage decision (S2, made explicitly rather than
// left implicit - see STANDALONE_MIGRATION_S2 report "PWA_BROWSER_AUTH_DECISION"):
//
// This app has no server component (Supabase is a BaaS, not a backend we
// operate), so a real HttpOnly-cookie session requires a server-side/BFF
// architecture that does not exist and is out of S2's scope to build.
// Building a half-HttpOnly custom scheme instead was explicitly rejected.
//
// Decision: on the PWA/browser path, use Supabase's own supported browser
// session model, which persists to localStorage. This is NOT HttpOnly and
// is readable by any script running on this origin - if this origin is ever
// compromised by XSS, the session is at risk, same as most client-only SPA
// auth. Mitigations in place: a strict CSP (script-src 'self' only, no
// inline scripts, no remote script sources) and no HTML ever built from
// unescaped user/task content (see app.js escapeHtml). This is a
// significant, considered tradeoff, not an oversight - the Electron path
// does NOT have this exposure (see electronAuthStorage.js: main-process
// safeStorage-encrypted, renderer never touches it directly).
window.TunaBrowserAuthStorage = {
  async getItem(key) { return window.localStorage.getItem(key); },
  async setItem(key, value) { window.localStorage.setItem(key, value); },
  async removeItem(key) { window.localStorage.removeItem(key); },
};
