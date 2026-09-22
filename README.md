# Tuna Tastan Desktop

Electron app with a local, bundled frontend (served over the privileged `app://tuna` protocol) backed by Supabase for auth/data/realtime. There is no remote/hosted web app and no ChatGPT/OpenAI runtime dependency - see `supabase/migrations/0001_init.sql` for the schema and `src/frontend/lib/` for the Supabase client/auth/data-adapter code.

## What this shell adds over a bare Electron+web-app pairing

- **Navigation/security hardening**: origin checks use exact-host `URL` parsing instead of `startsWith`, which is bypassable (e.g. `https://<host>.evil.com`). A permission-request handler denies everything except `notifications` from the app's own origin, and certificate errors are logged instead of silently ignored.
- **Single instance**: a second launch focuses the existing window instead of opening a duplicate.
- **Window-state persistence**: position/size/maximized state is saved to `userData/window-state.json` and restored on next launch, clamped to a currently visible display.
- **Controlled preload/IPC API**: `window.tunaDesktop` exposes only `logInfo`, `logError`, and the standalone Supabase config/auth-storage bridge - no raw `ipcRenderer` is ever exposed to the page.
- **System tray**: hide-to-tray on close, "Başlangıçta çalıştır" (launch at login), "Güncellemeleri kontrol et", "Tanılama paketi oluştur", explicit quit.
- **Diagnostics/logging**: `userData/logs/tuna-tastan-YYYY-MM-DD.log`, daily-rotated and capped at 5MB, capturing navigation, denied permissions, renderer crashes/hangs/uncaught exceptions/unhandled rejections (both main process and renderer, via `src/frontend/crashReporter.js`), and updater activity. Every logged line is redacted (`sanitizeLogMessage()` in `main.cjs`) for JWT/Bearer/Supabase-auth-token-shaped substrings before it ever touches disk.
- **Mobile/PWA**: the same frontend (`src/frontend/`) also runs as an installable PWA in a real browser - see `manifest.json`, `sw.js`, and `tools/generate-browser-config.ps1`. Live at https://tastantuna-dev.github.io/tuna-tastan-pwa/.
- **Auto-update**: `src/lib/updater.cjs` (electron-updater + GitHub Releases, packaged builds only) - see "Release" below.

## Deferred / intentionally out of scope

NSIS/updater code signing (no certificate purchased - see "Code signing" below), a cloud crash-reporting SaaS (Sentry/Bugsnag etc. - local, sanitized file logging + the on-demand diagnostics bundle were judged sufficient for a single-user personal app), native mobile apps, push notifications.

## Run / build

```
npm install
npm start          # run in dev
npm run build       # electron-builder --win -> dist/ (zip + NSIS installer)
```

Runtime dependencies: `@supabase/supabase-js`, `electron-updater`. Dev/build only: `electron`, `electron-builder`.

## Release

`pwsh tools\release.ps1` is the one canonical release flow: safety gates (clean git tree, no secrets tracked, no ChatGPT/OpenAI reference in source, artifact-hygiene scan of the release zip, signing verification if `CSC_LINK` is set) → clean build → a **draft** GitHub Release (never auto-published - promote it yourself once you've reviewed it: `gh release edit vX.Y.Z --draft=false`). Bump `package.json`'s `version` first; the script derives the git tag and release title from it.

### Code signing

No certificate is currently configured - builds are **unsigned**, and Windows SmartScreen will likely warn on first run of the installer. This is a known, accepted state, not a bug. To sign once a certificate exists:
1. Set `CSC_LINK` (path to the `.pfx`, or a base64-encoded blob) and `CSC_KEY_PASSWORD` as environment variables before running `npm run build` or `tools\release.ps1` - electron-builder picks these up automatically, no other config change needed (`package.json`'s `win.signingHashAlgorithms`/`rfc3161TimeStampServer` are already set for SHA-256 + a public RFC3161 timestamp server).
2. `tools\release.ps1` will then *require* a valid signature (via `tools\verify-signing.ps1`) before it will create a release - a certificate that's present but fails to actually sign correctly blocks the release rather than silently shipping unsigned.
3. Run `pwsh tools\verify-signing.ps1` any time to check the real Authenticode status of the current `dist\` build (`Get-AuthenticodeSignature`, no new dependency).

### Rollback

A bad release that somehow got published: `gh release edit vX.Y.Z --repo tastantuna-dev/tuna-tastan-desktop --draft=true` (hides it from update clients immediately) or `gh release delete vX.Y.Z` if it should never have existed. electron-updater always resolves the *latest* non-draft, non-prerelease release, so hiding/removing a bad one and publishing a corrected patch version is the whole recovery procedure - no custom downgrade mechanism exists or is needed.

### Diagnostics bundle

Tray → "Tanılama paketi oluştur" writes a folder to `userData\diagnostics\bundle-<timestamp>\` (app version, OS/Electron/Chrome version, `supabaseConfigured`/updater-state booleans, and a copy of today's already-redacted log file) and opens it in Explorer. Never contains tokens, DB/task content, or the anon key value - safe to share when reporting a problem. Right-click → "Send to → Compressed folder" if a single `.zip` is wanted.

### Manual validation checklist (things this environment cannot fully automate)

- **Update notification click**: launch an older installed version, wait for the "guncelleme hazir" notification, click it yourself, confirm the app restarts as the new version with your session/tasks intact.
- **PWA on a real phone**: open the live URL above on Android Chrome / iOS Safari, "Add to Home Screen", launch standalone, sign in, create a task, confirm it appears on desktop in real time, then toggle airplane mode and back to confirm offline queue + reconnect.
