// App-shell-only service worker (S3 PWA foundation). Caches static assets
// so the shell can open offline; NEVER caches Supabase requests, auth
// tokens, or any API response - real data offline support is already
// handled at the data layer by dataAdapter.js's own queue/cache (see
// browserAuthStorage.js/electronAuthStorage.js for why auth storage is
// separate and deliberately not routed through here).
const SHELL_CACHE = 'tuna-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './data.js',
  './manifest.json',
  './icon.png',
  './vendor/supabase.umd.js',
  './lib/electronAuthStorage.js',
  './lib/browserAuthStorage.js',
  './lib/supabaseClient.js',
  './lib/authService.js',
  './lib/dataAdapter.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never touch anything Supabase-bound (API data, auth, realtime) - this
  // service worker is app-shell-only.
  if (url.hostname.endsWith('supabase.co')) return;
  if (event.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Network-first with cache fallback: keeps the shell fresh on every
  // online load (this app updates its own files, unlike a versioned
  // native build), while still opening offline from the last-cached copy.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
