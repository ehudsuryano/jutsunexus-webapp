/*
 * Offline support: the app's own files are cached on install and served from the cache, so the
 * app opens with no connection. The library itself is in IndexedDB, not here.
 *
 * Bump VERSION with every release: the new worker caches the new files, and the page offers an
 * "Update" button that swaps it in.
 */
const VERSION = 'jn-web-1.2.1';
const FILES = [
  './',
  'index.html',
  'style.css',
  'graph.css',
  'extras.css',
  'manifest.webmanifest',
  'logo.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'vendor/pako.min.js',
  'vendor/qrcode.js',
  'js/prefs.js',
  'js/addmedia.js',
  'js/config.js',
  'js/drive.js',
  'js/views/drivescreen.js',
  'js/views/sharescreens.js',
  'js/app.js',
  'js/db.js',
  'js/dom.js',
  'js/i18n.js',
  'js/library.js',
  'js/links.js',
  'js/media.js',
  'js/packages.js',
  'js/player.js',
  'js/share.js',
  'js/ui.js',
  'js/zip.js',
  'js/graph/model.js',
  'js/graph/view.js',
  'js/views/map.js',
  'js/strings/en.js',
  'js/strings/he.js',
  'js/views/editors.js',
  'js/views/import.js',
  'js/views/library.js',
  'js/views/more.js',
  'js/views/technique.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // package links and Google go straight to the network
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    // Any page navigation (?open=… included) is the one-page app.
    const hit = req.mode === 'navigate'
      ? await cache.match('index.html')
      : await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch {
      return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
