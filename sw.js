/* ════════════════════════════════════════════════════════════
   বাংলা পঞ্জিকা — Service Worker v3.0
   © Manik Roy 2026. All Rights Reserved.

   Features:
   ─ Three-tier cache: app shell | fonts | dynamic
   ─ Strategies: Cache-First (fonts/icons) | Network-First (HTML)
                 Stale-While-Revalidate (fonts CSS)
   ─ Automatic old cache cleanup on activate
   ─ Background sync on reconnect (cache refresh)
   ─ skipWaiting + clients.claim for instant takeover
   ─ Push notification support (future)
   ─ Offline fallback to last cached index.html
   ─ Version broadcast to all clients on update
   ════════════════════════════════════════════════════════════ */

const APP_VERSION   = '3.0';
const CACHE_APP     = `panjika-app-v${APP_VERSION}`;
const CACHE_FONTS   = `panjika-fonts-v${APP_VERSION}`;
const CACHE_DYNAMIC = `panjika-dynamic-v${APP_VERSION}`;
const ALL_CACHES    = [CACHE_APP, CACHE_FONTS, CACHE_DYNAMIC];

/* ── App Shell: pre-cache on install ── */
const APP_SHELL = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

/* ── Google Fonts URLs ── */
const FONT_ORIGINS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const FONT_PRECACHE = [
  'https://fonts.googleapis.com/css2?family=Noto+Serif+Bengali:wght@300;400;600;700;900&display=swap'
];

/* ════════════════════════════════════════════════
   INSTALL — Pre-cache app shell & fonts
   ════════════════════════════════════════════════ */
self.addEventListener('install', event => {
  console.log(`[SW v${APP_VERSION}] Installing…`);

  event.waitUntil(
    Promise.allSettled([
      caches.open(CACHE_APP).then(cache =>
        cache.addAll(APP_SHELL).catch(err =>
          console.warn('[SW] App shell partial fail (offline install?):', err)
        )
      ),
      caches.open(CACHE_FONTS).then(cache =>
        cache.addAll(FONT_PRECACHE).catch(err =>
          console.warn('[SW] Font pre-cache fail (offline?):', err)
        )
      )
    ]).then(() => {
      console.log(`[SW v${APP_VERSION}] Pre-cache done. Skipping wait…`);
      return self.skipWaiting();
    })
  );
});

/* ════════════════════════════════════════════════
   ACTIVATE — Purge stale caches, claim clients
   ════════════════════════════════════════════════ */
self.addEventListener('activate', event => {
  console.log(`[SW v${APP_VERSION}] Activating…`);

  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => !ALL_CACHES.includes(key))
          .map(key => {
            console.log('[SW] Deleting stale cache:', key);
            return caches.delete(key);
          })
      ))
      .then(() => {
        console.log('[SW] Controlling all clients.');
        // Notify all clients about the update
        return self.clients.matchAll({ includeUncontrolled: true });
      })
      .then(clients => {
        clients.forEach(client =>
          client.postMessage({ type: 'SW_UPDATED', version: APP_VERSION })
        );
        return self.clients.claim();
      })
  );
});

/* ════════════════════════════════════════════════
   FETCH — Smart caching per resource type
   ════════════════════════════════════════════════ */
self.addEventListener('fetch', event => {
  const req  = event.request;
  const url  = new URL(req.url);

  // Only handle GET
  if (req.method !== 'GET') return;

  // Skip chrome-extension and non-http schemes
  if (!url.protocol.startsWith('http')) return;

  // ── Google Fonts CSS  → Stale-While-Revalidate ──
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(staleWhileRevalidate(req, CACHE_FONTS));
    return;
  }

  // ── Google Fonts files (woff2 etc) → Cache-First (immutable) ──
  if (url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, CACHE_FONTS));
    return;
  }

  // ── App HTML & manifest → Network-First (always get latest) ──
  if (
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.json') ||
    req.mode === 'navigate'
  ) {
    event.respondWith(networkFirst(req, CACHE_APP));
    return;
  }

  // ── Icons & images → Cache-First (stable assets) ──
  if (
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico') ||
    url.pathname.endsWith('.webp')
  ) {
    event.respondWith(cacheFirst(req, CACHE_APP));
    return;
  }

  // ── JS & CSS → Stale-While-Revalidate ──
  if (
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css')
  ) {
    event.respondWith(staleWhileRevalidate(req, CACHE_DYNAMIC));
    return;
  }

  // ── Everything else → Network-First ──
  event.respondWith(networkFirst(req, CACHE_DYNAMIC));
});

/* ════════════════════════════════════════════════
   CACHE STRATEGIES
   ════════════════════════════════════════════════ */

/**
 * Cache-First
 * Serve from cache; fetch & store on miss.
 * Ideal for: icons, font files (immutable).
 */
async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req, { ignoreSearch: false });
  if (cached) return cached;

  try {
    const response = await fetch(req);
    if (response && response.status === 200 && response.type !== 'opaqueredirect') {
      const cache = await caches.open(cacheName);
      cache.put(req, response.clone());
    }
    return response;
  } catch {
    return offlineFallback(req);
  }
}

/**
 * Network-First
 * Try network; fall back to cache on failure.
 * Ideal for: HTML, manifest — always want freshest.
 */
async function networkFirst(req, cacheName) {
  try {
    const response = await fetch(req);
    if (response && response.status === 200) {
      const cache = await caches.open(cacheName);
      cache.put(req, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    return offlineFallback(req);
  }
}

/**
 * Stale-While-Revalidate
 * Return cache immediately; update cache in background.
 * Ideal for: fonts CSS, semi-static assets.
 */
async function staleWhileRevalidate(req, cacheName) {
  const cached = await caches.match(req);

  // Background refresh
  const fetchAndCache = fetch(req)
    .then(response => {
      if (response && response.status === 200) {
        caches.open(cacheName).then(cache => cache.put(req, response.clone()));
      }
      return response;
    })
    .catch(() => null);

  // Return cached immediately if available, else wait for network
  return cached ?? await fetchAndCache ?? offlineFallback(req);
}

/**
 * Offline fallback
 * For navigation: return cached index.html.
 * For assets: return a minimal 503 response.
 */
async function offlineFallback(req) {
  if (req.mode === 'navigate') {
    const shell = await caches.match('./index.html');
    if (shell) return shell;
  }
  return new Response(
    JSON.stringify({ error: 'offline', message: 'বাংলা পঞ্জিকা — অফলাইন মোড' }),
    {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    }
  );
}

/* ════════════════════════════════════════════════
   MESSAGE HANDLER
   ════════════════════════════════════════════════ */
self.addEventListener('message', event => {
  if (!event.data) return;

  switch (event.data.type) {

    case 'SKIP_WAITING':
      console.log('[SW] SKIP_WAITING received — activating immediately.');
      self.skipWaiting();
      break;

    case 'GET_VERSION':
      if (event.ports[0]) {
        event.ports[0].postMessage({
          version: APP_VERSION,
          caches: ALL_CACHES
        });
      }
      break;

    case 'CLEAR_CACHE':
      // Called when user switches Siddhanta or Location — force fresh HTML
      caches.delete(CACHE_APP).then(() => {
        console.log('[SW] App cache cleared on request.');
        if (event.ports[0]) event.ports[0].postMessage({ cleared: true });
      });
      break;

    case 'CACHE_URLS':
      // Proactively cache a list of URLs
      if (Array.isArray(event.data.urls)) {
        caches.open(CACHE_DYNAMIC).then(cache =>
          cache.addAll(event.data.urls.filter(u => typeof u === 'string'))
        );
      }
      break;
  }
});

/* ════════════════════════════════════════════════
   BACKGROUND SYNC — refresh app shell when back online
   ════════════════════════════════════════════════ */
self.addEventListener('sync', event => {
  if (event.tag === 'panjika-refresh') {
    console.log('[SW] Background sync: refreshing app shell…');
    event.waitUntil(
      caches.open(CACHE_APP).then(cache =>
        Promise.allSettled(
          APP_SHELL.map(url =>
            fetch(url).then(res => {
              if (res && res.status === 200) cache.put(url, res);
            }).catch(() => {})
          )
        )
      )
    );
  }
});

/* ════════════════════════════════════════════════
   PUSH NOTIFICATIONS
   ════════════════════════════════════════════════ */
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try { data = event.data.json(); }
  catch { data = { title: 'বাংলা পঞ্জিকা', body: event.data.text() }; }

  const options = {
    body:    data.body    || 'আজকের পঞ্চাঙ্গ দেখুন',
    icon:    './icon-192.png',
    badge:   './icon-192.png',
    lang:    data.lang    || 'bn',
    dir:     'ltr',
    tag:     data.tag     || 'panjika-update',
    renotify: !!data.renotify,
    vibrate: [200, 100, 200, 100, 200],
    silent:  false,
    data:    { url: data.url || './index.html', timestamp: Date.now() },
    actions: [
      { action: 'open',    title: 'খুলুন / Open' },
      { action: 'dismiss', title: 'পরে / Later' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(
      data.title || 'বাংলা পঞ্জিকা', options
    )
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const targetUrl = (event.notification.data && event.notification.data.url)
    || './index.html';

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // Focus existing window if available
        for (const client of clientList) {
          if (client.url.includes('index') && 'focus' in client) {
            return client.focus();
          }
        }
        // Otherwise open a new window
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      })
  );
});

/* ════════════════════════════════════════════════
   PERIODIC BACKGROUND SYNC (Chrome 80+)
   Refreshes app shell once daily when online
   ════════════════════════════════════════════════ */
self.addEventListener('periodicsync', event => {
  if (event.tag === 'panjika-daily-refresh') {
    console.log('[SW] Periodic sync: daily app shell refresh');
    event.waitUntil(
      caches.open(CACHE_APP).then(cache =>
        fetch('./index.html')
          .then(res => { if (res.status === 200) cache.put('./index.html', res); })
          .catch(() => {})
      )
    );
  }
});

console.log(`[SW v${APP_VERSION}] বাংলা পঞ্জিকা Service Worker loaded.`);