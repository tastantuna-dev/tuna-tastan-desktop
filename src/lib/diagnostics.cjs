// Release Hardening phase: a safe, user-triggerable diagnostics bundle -
// main-process only, no arbitrary filesystem bridge exposed to the
// renderer. Produces a plain folder (not a compressed .zip - Windows
// Explorer can compress it in one right-click if the user wants to send a
// single file, with zero new dependency here) containing:
//   - diagnostics.json: structured, safe-by-construction metadata
//   - the current day's log file, copied verbatim (every line in it
//     already passed through sanitizeLogMessage()'s redaction - see
//     main.cjs - so no further scrubbing is done here; this file IS
//     already the sanitized source of truth)
//
// Never included, by construction (nothing here ever reads these):
// access/refresh tokens, cookies, OTP codes, DB row content, task/list
// text, Authorization headers, the Supabase anon key value, or any full
// URL with a query string.
const fs = require('fs');
const path = require('path');
const os = require('os');

function buildMetadata({ app, supabaseConfigured, updaterState }) {
  return {
    generatedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    platform: process.platform,
    osRelease: os.release(),
    packaged: app.isPackaged,
    // Booleans/enums only - never the underlying values.
    supabaseConfigured,
    updater: updaterState,
  };
}

// `updaterState` is a plain object of booleans/strings the caller already
// has on hand (e.g. { lastCheckAt, lastResult }) - this module never talks
// to electron-updater directly, keeping it a pure, easily-audited writer.
function createDiagnosticsBundle({ app, logger, shell, supabaseConfigured, updaterState }) {
  try {
    const outDir = path.join(app.getPath('userData'), 'diagnostics', `bundle-${Date.now()}`);
    fs.mkdirSync(outDir, { recursive: true });

    const metadata = buildMetadata({ app, supabaseConfigured, updaterState });
    fs.writeFileSync(path.join(outDir, 'diagnostics.json'), JSON.stringify(metadata, null, 2), 'utf8');

    const logsDir = path.join(app.getPath('userData'), 'logs');
    const today = new Date().toISOString().slice(0, 10);
    const logPath = path.join(logsDir, `tuna-tastan-${today}.log`);
    if (fs.existsSync(logPath)) {
      fs.copyFileSync(logPath, path.join(outDir, `log-${today}.log`));
    }

    logger.info(`[diagnostics] bundle created at ${outDir}`);
    shell.showItemInFolder(path.join(outDir, 'diagnostics.json'));
    return { ok: true, path: outDir };
  } catch (err) {
    logger.warn(`[diagnostics] bundle creation failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { createDiagnosticsBundle };
