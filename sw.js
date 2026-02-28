/* ================================================
   বাংলা পঞ্জিকা — Service Worker v1.0
   © Manik Roy 2026. All Rights Reserved.
   ================================================ */

const CACHE_NAME   = 'bangla-panjika-v1.1';
const STATIC_CACHE = 'bangla-panjika-static-v1.1';
const FONT_CACHE   = 'bangla-panjika-fonts-v1.1';

// Core app shell — always cache these
const APP_SHELL = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Font URLs to cache separately
const FONT_URLS = [
  'https://fonts.googleapis.com/css2?family=Noto+Serif+Bengali:wght@300;400;600;700;900&display=swap'
];

/* ────────────────────────────────────────
   INSTALL — pre-cache app shell
──────────────────────────────────────── */
self.addEventListener('install', event => {
  console.log('[SW] Installing বাংলা পঞ্জিকা v1.0...');

  event.waitUntil(
    Promise.all([
      // Cache app shell
      caches.open(STATIC_CACHE).then(cache => {
        return cache.addAll(APP_SHELL).catch(err => {
          console.warn('[SW] App shell cache partial fail:', err);
        });
      }),
      // Cache fonts
      caches.open(FONT_CACHE).then(cache => {
        return cache.addAll(FONT_URLS).catch(err => {
          console.warn('[SW] Font cache fail (offline install?):', err);
        });
      })
    ]).then(() => {
      console.log('[SW] Pre-cache complete. Skipping waiting...');
      return self.skipWaiting();
    })
  );
});

/* ────────────────────────────────────────
   ACTIVATE — delete old caches, take control
──────────────────────────────────────── */
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');

  const VALID_CACHES = [STATIC_CACHE, FONT_CACHE, CACHE_NAME];

  event.waitUntil(
    caches.keys()
      .then(cacheNames =>
        Promise.all(
          cacheNames
            .filter(name => !VALID_CACHES.includes(name))
            .map(name => {
              console.log('[SW] Deleting obsolete cache:', name);
              return caches.delete(name);
            })
        )
      )
      .then(() => {
        console.log('[SW] Now controlling all clients');
        return self.clients.claim();
      })
  );
});

/* ────────────────────────────────────────
   FETCH — smart caching strategy
──────────────────────────────────────── */
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests
  if (req.method !== 'GET') return;

  // ── Google Fonts CSS — stale-while-revalidate ──
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(staleWhileRevalidate(req, FONT_CACHE));
    return;
  }

  // ── Google Fonts files — cache first (immutable) ──
  if (url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  // ── App shell (HTML, manifest, icons) — network first, fallback cache ──
  if (
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.json') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.ico')
  ) {
    event.respondWith(networkFirst(req, STATIC_CACHE));
    return;
  }

  // ── JS/CSS — stale-while-revalidate ──
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(staleWhileRevalidate(req, CACHE_NAME));
    return;
  }

  // ── Everything else — network first ──
  event.respondWith(networkFirst(req, CACHE_NAME));
});

/* ────────────────────────────────────────
   CACHE STRATEGIES
──────────────────────────────────────── */

/**
 * Cache First — serve from cache, fetch if missing.
 * Best for immutable assets (font files, icons).
 */
async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;

  try {
    const response = await fetch(req);
    if (response && response.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(req, response.clone());
    }
    return response;
  } catch (err) {
    return offlineFallback(req);
  }
}

/**
 * Network First — try network, fall back to cache.
 * Best for HTML pages and frequently updated content.
 */
async function networkFirst(req, cacheName) {
  try {
    const response = await fetch(req);
    if (response && response.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(req, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    return offlineFallback(req);
  }
}

/**
 * Stale While Revalidate — serve cache immediately, update in background.
 * Best for fonts and semi-static assets.
 */
async function staleWhileRevalidate(req, cacheName) {
  const cached = await caches.match(req);

  const fetchPromise = fetch(req).then(response => {
    if (response && response.status === 200) {
      caches.open(cacheName).then(cache => cache.put(req, response.clone()));
    }
    return response;
  }).catch(() => null);

  return cached || fetchPromise || offlineFallback(req);
}

/**
 * Offline fallback — return cached homepage for navigation requests.
 */
async function offlineFallback(req) {
  if (req.mode === 'navigate') {
    const cached = await caches.match('./index.html');
    if (cached) return cached;
  }
  // Return empty 503 for other requests
  return new Response('Offline', {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/plain' }
  });
}

/* ────────────────────────────────────────
   MESSAGE HANDLER
──────────────────────────────────────── */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] Received SKIP_WAITING message');
    self.skipWaiting();
  }

  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_NAME });
  }
});

/* ────────────────────────────────────────
   PUSH NOTIFICATIONS (future use)
──────────────────────────────────────── */
self.addEventListener('push', event => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body: data.body || 'আজকের পঞ্জিকা আপডেট',
    icon: './icon-192.png',
    badge: './icon-192.png',
    lang: 'bn',
    dir: 'ltr',
    vibrate: [200, 100, 200],
    data: { url: './index.html' }
  };

  event.waitUntil(
    self.registration.showNotification(
      data.title || 'বাংলা পঞ্জিকা',
      options
    )
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('index') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('./index.html');
      }
    })
  );
});