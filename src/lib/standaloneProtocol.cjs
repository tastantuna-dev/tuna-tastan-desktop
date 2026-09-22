// Serves the standalone frontend (src/frontend/) over a custom, privileged
// app:// protocol instead of raw file:// - avoids file://'s weaker security
// posture (no origin isolation, no fetch/CORS semantics, awkward SPA
// routing) while keeping everything local: no network, no localhost server,
// no new port to secure.
const path = require('path');
const { net } = require('electron');
const { pathToFileURL } = require('url');

const SCHEME = 'app';
const HOST = 'tuna';

// Must run before app 'ready' - Electron requires privileged schemes to be
// declared this early.
function registerSchemePrivileges(protocol) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        allowServiceWorkers: false,
        stream: true,
      },
    },
  ]);
}

// Serves files under `frontendRoot` for app://tuna/<path>. Any request whose
// resolved path would escape frontendRoot (path traversal via ../) or whose
// host isn't exactly "tuna" is refused. A path with no matching file falls
// back to index.html so client-side (hash-based, here, but this also covers
// history-API routing later) navigation works without a server.
function setupProtocolHandler(protocol, frontendRoot) {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) {
      return new Response('not found', { status: 404 });
    }
    const decodedPath = decodeURIComponent(url.pathname);
    const candidate = path.normalize(path.join(frontendRoot, decodedPath));
    const rootWithSep = frontendRoot.endsWith(path.sep) ? frontendRoot : frontendRoot + path.sep;
    const target = candidate.startsWith(rootWithSep) || candidate === frontendRoot
      ? candidate
      : frontendRoot; // traversal attempt - refuse by falling back to root

    const finalPath = decodedPath === '/' || decodedPath === '' ? path.join(frontendRoot, 'index.html') : target;
    // file:// responses carry no Cache-Control, which lets Chromium apply
    // its own (aggressive, version-unaware) heuristic caching for this
    // "standard" scheme - found live while testing S2 (a CSS edit didn't
    // take effect after a soft reload). no-cache forces a fresh read every
    // navigation while still allowing normal in-session reuse.
    const withNoCache = (res) => new Response(res.body, { status: res.status, headers: { ...Object.fromEntries(res.headers), 'Cache-Control': 'no-cache' } });
    try {
      return withNoCache(await net.fetch(pathToFileURL(finalPath).toString()));
    } catch {
      // no such file - SPA fallback to index.html
      return withNoCache(await net.fetch(pathToFileURL(path.join(frontendRoot, 'index.html')).toString()));
    }
  });
}

module.exports = { registerSchemePrivileges, setupProtocolHandler, SCHEME, HOST };
