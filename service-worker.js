/**
 * BookAI SW v11 — v2.5.0-final (Batches 1–7) — batch2 public booking safety
 * Network-first for HTML. Never cache tenant-specific booking navigations.
 * Static shell assets only in precache.
 */
const CACHE_NAME = 'bookai-static-v11';
const PRECACHE = [
  '/offline.html',
  '/styles.css',
  '/manifest.json',
  '/manifest-admin.json',
  '/manifest-booking.json',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/icon-maskable-192.png',
  '/assets/icons/icon-maskable-512.png',
  '/pwa-register.js',
  '/VERSION.txt'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // APIs + Firebase/CDN always network (tenant data must not be cached by SW)
  if (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('cdn.') ||
    url.hostname.includes('cdnjs.') ||
    url.hostname.includes('firestore')
  ) {
    return;
  }

  const isBookingPage =
    url.pathname.endsWith('/booking.html') ||
    url.pathname === '/booking.html' ||
    url.pathname.startsWith('/b/');

  const isNav =
    event.request.mode === 'navigate' ||
    event.request.destination === 'document' ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/';

  // Public booking + handle routes: network-only (no cache put)
  // Prevents stale HTML and avoids confusing offline fallback across tenants
  if (isNav && isBookingPage) {
    event.respondWith(
      fetch(event.request)
        .then((res) => res)
        .catch(() => caches.match('/offline.html'))
    );
    return;
  }

  if (isNav) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          // Cache only path without query for generic pages
          if (res && res.ok && !url.search) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(url.pathname, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(url.pathname).then((r) => r || caches.match('/offline.html'))
        )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const net = fetch(event.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || net;
    })
  );
});
