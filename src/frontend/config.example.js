// PWA/browser-path Supabase config (S3). Copy this file to config.js and
// fill in the SAME public values as config/local.json's supabaseUrl/
// supabaseAnonKey - the anon key is a public, safe-to-ship key by design
// (RLS enforces real access control server-side), same as the Electron
// path already ships via IPC. Never put a service_role key here or
// anywhere in this app. config.js is gitignored so a per-deploy value
// isn't accidentally committed, even though its contents are not secret.
window.TUNA_BROWSER_CONFIG = {
  configured: true,
  url: 'https://YOUR-PROJECT-REF.supabase.co',
  anonKey: 'YOUR-ANON-PUBLIC-KEY',
};
