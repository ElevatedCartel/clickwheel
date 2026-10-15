// Offline shell: the app's own files are cached on first visit and served from the cache after.
// Bump VERSION whenever any file changes so phones pick up the update.
const VERSION = 'clickwheel-v1';
const FILES = ['./', 'index.html', 'app.css', 'app.js', 'db.js', 'tags.js', 'manifest.webmanifest',
  'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true })
      .then((hit) => hit || (e.request.mode === 'navigate' ? caches.match('index.html') : null))
      .then((hit) => hit || fetch(e.request)),
  );
});
