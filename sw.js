// sw.js – Service Worker: Offline-Cache für die App-Dateien.
//
// WICHTIG: Nach JEDER Änderung an App-Dateien die VERSION erhöhen (z. B. 'v2'),
// sonst bekommen installierte Apps die neuen Dateien nicht. Die App zeigt dann
// den Hinweis „Neue Version verfügbar".

const VERSION = 'v2';
const CACHE = `motorrad-${VERSION}`;

// Eigene App-Dateien (relativ, damit es auch unter https://name.github.io/repo/ klappt)
const APP_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/ui.js',
  './js/logbook.js',
  './js/settings.js',
  './js/weather.js',
  './js/ampel.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// Externe Bibliotheken (CDN) – werden mitgecacht, damit z. B. Diagramme offline gehen
const CDN_FILES = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' umgeht den HTTP-Cache, damit wirklich die neuen Dateien geladen werden
    await cache.addAll(APP_FILES.map((url) => new Request(url, { cache: 'reload' })));
    // CDN-Fehler sollen die Installation nicht verhindern
    await Promise.all(CDN_FILES.map((url) => cache.add(new Request(url, { mode: 'cors' })).catch(() => {})));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Alte Cache-Versionen löschen
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('motorrad-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const type = event.data?.type;
  if (type === 'SKIP_WAITING') self.skipWaiting();
  if (type === 'GET_VERSION') event.ports[0]?.postMessage({ version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Seitenaufrufe: immer die gecachte index.html (passt garantiert zu den gecachten
  // Skripten derselben VERSION); nur wenn sie fehlt, aus dem Netz
  if (req.mode === 'navigate') {
    event.respondWith((async () => (await caches.match('./index.html')) || fetch(req))());
    return;
  }

  // Eigene Dateien und CDN-Bibliotheken: Cache zuerst, sonst Netz (und nachcachen)
  const isOwn = url.origin === self.location.origin;
  const isCdn = CDN_FILES.includes(req.url);
  if (isOwn || isCdn) {
    event.respondWith((async () => {
      const cached = await caches.match(req, { ignoreSearch: isOwn });
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok && (isCdn || res.type === 'basic')) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    })());
  }
  // Alles andere (Wetter-API, Routing, Kartenkacheln) geht direkt ans Netz –
  // die App cached API-Antworten selbst in IndexedDB.
});
