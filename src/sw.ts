// sw.ts — the app shell is cached on install. City data lives in IndexedDB,
// so nothing here ever needs to touch the network after the first visit.

/// <reference lib="es2023" />

declare const self: {
  addEventListener: (type: string, fn: (e: any) => void) => void;
  skipWaiting: () => Promise<void>;
  clients: { claim: () => Promise<void> };
  location: { origin: string };
};

// Bump on every shell change. The fetch handler below is cache-first with no
// revalidation, so a client that has already installed will keep serving the
// old modules forever until this constant changes and `activate` sweeps the
// previous cache away.
const CACHE = 'offline-rails-v1';

// Stable filenames, no content hashes — see build.ts for why that is a choice
// rather than an oversight.
const SHELL = [
  './',
  'index.html',
  'main.js',
  'main.css',
  'builder.worker.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

// addAll() fires every request at once and rejects the whole install if any
// one of them fails — which happens on single-threaded dev servers. Cache
// sequentially and survive a miss instead.
self.addEventListener('install', (e: any) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const missed: string[] = [];
      for (const url of SHELL) {
        try {
          await cache.add(new Request(url, { cache: 'reload' }));
        } catch {
          missed.push(url);
        }
      }
      if (missed.length) console.warn('[sw] not cached:', missed);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e: any) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e: any) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Overpass and Nominatim are deliberately never cached: they are only ever
  // called while online, and their responses are far too big to keep twice.
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
            return res;
          })
          .catch(() => caches.match('index.html') as Promise<Response>),
    ),
  );
});

export {};
