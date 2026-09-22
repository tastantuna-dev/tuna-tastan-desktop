# Tuna Tastan Desktop

Electron app with a local, bundled frontend (served over the privileged `app://tuna` protocol) backed by Supabase for auth/data/realtime. There is no remote/hosted web app and no ChatGPT/OpenAI runtime dependency - see `supabase/migrations/0001_init.sql` for the schema and `src/frontend/lib/` for the Supabase client/auth/data-adapter code.

## What this shell adds over a bare Electron+web-app pairing

- **Navigation/security hardening**: origin checks use exact-host `URL` parsing instead of `startsWith`, which is bypassable (e.g. `https://<host>.evil.com`). A permission-request handler denies everything except `notifications` from the app's own origin, and certificate errors are logged instead of silently ignored.
- **Single instance**: a second launch focuses the existing window instead of opening a duplicate.
- **Window-state persistence**: position/size/maximized state is saved to `userData/window-state.json` and restored on next launch, clamped to a currently visible display.
- **Controlled preload/IPC API**: `window.tunaDesktop` exposes only `logInfo`, `logError`, and the standalone Supabase config/auth-storage bridge - no raw `ipcRenderer` is ever exposed to the page.
- **System tray**: hide-to-tray on close, "Başlangıçta çalıştır" (launch at login), explicit quit.
- **Diagnostics/logging**: `userData/logs/tuna-tastan-YYYY-MM-DD.log`, daily-rotated and capped at 5MB, capturing navigation, denied permissions, renderer crashes/hangs, and uncaught exceptions.
- **Mobile/PWA**: the same frontend (`src/frontend/`) also runs as an installable PWA in a real browser - see `manifest.json`, `sw.js`, and `tools/generate-browser-config.ps1`.

## Deferred to a later phase

Auto-update, tray/startup integration, and broader Windows shell integration (jump lists, taskbar progress, etc.) - intentionally left out of this pass.

## Run / build

```
npm install
npm start          # run in dev
npm run build       # electron-builder --win -> dist/
```

No new runtime dependencies beyond `electron` (dev) and `electron-builder` (dev, for packaging) - same as the original build.
