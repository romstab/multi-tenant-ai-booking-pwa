/**
 * BookAI Service Worker v14 — Batch 28 PWA production pack
 *
 * Strategy:
 * - Precache static shell only (CSS, icons, offline, manifests, register)
 * - Never cache /api/*, Firebase, CDNs, or non-GET
 * - Public booking pages: network-only (tenant-specific, no stale availability)
 * - Other HTML navigations: network-first, optional shell cache without query strings
 * - Static assets: cache-first with network refresh
 * - No offline mutation queue; no token caching
 */
const CACHE_NAME = 'bookai-static-v14';
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

function isSensitiveHost(hostname) {
  return (
    hostname.includes('googleapis.com') ||
    hostname.includes('firebase') ||
    hostname.includes('gstatic.com') ||
    hostname.includes('firestore') ||
    hostname.includes('cdn.') ||
    hostname.includes('cdnjs.') ||
    hostname.includes('jsdelivr') ||
    hostname.includes('unpkg.com')
  );
}

function isBookingNav(url) {
  return (
    url.pathname.endsWith('/booking.html') ||
    url.pathname === '/booking.html' ||
    url.pathname.startsWith('/b/')
  );
}

function isManageNav(url) {
  return url.pathname.endsWith('/manage-booking.html') || url.pathname === '/manage-booking.html';
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Cross-origin / API / auth backends: network only (do not intercept)
  if (url.pathname.startsWith('/api/') || isSensitiveHost(url.hostname)) {
    return;
  }

  const isNav =
    event.request.mode === 'navigate' ||
    event.request.destination === 'document' ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/';

  // Booking + manage flows: never serve stale tenant/token pages from cache
  if (isNav && (isBookingNav(url) || isManageNav(url))) {
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
          // Cache generic shell pages only (no query) — not tokenized URLs
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

  // Same-origin static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const net = fetch(event.request)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
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
