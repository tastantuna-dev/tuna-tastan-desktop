// Loads the Supabase project's PUBLIC config (project URL + anon/publishable
// key) for the standalone auth/data layer. Never loads or has any code path
// for a service_role/admin key - there is no server component in this app,
// so that key has no legitimate reason to exist here at all.
//
// Priority: real environment variables first (TUNA_SUPABASE_URL /
// TUNA_SUPABASE_ANON_KEY), then a local, gitignored config/local.json - so a
// desktop user isn't forced to set env vars on every launch. Neither is
// committed; see config/local.example.json for the shape.
const fs = require('fs');
const path = require('path');

function readLocalConfigFile(root) {
  const p = path.join(root, 'config', 'local.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

// `appRoot` is the project root (two levels up from src/lib) in dev, or the
// asar-adjacent unpacked location when packaged - caller passes it in so
// this module makes no assumption about __dirname depth.
function loadSupabaseConfig(appRoot) {
  const local = readLocalConfigFile(appRoot);
  const url = process.env.TUNA_SUPABASE_URL || local.supabaseUrl || null;
  const anonKey = process.env.TUNA_SUPABASE_ANON_KEY || local.supabaseAnonKey || null;
  return {
    url,
    anonKey,
    configured: Boolean(url && anonKey),
  };
}

module.exports = { loadSupabaseConfig };
