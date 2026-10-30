// Two jobs. GitHub Pages cannot set response headers, so this worker adds the
// cross-origin isolation headers that SharedArrayBuffer needs. It also caches
// the app and runtimes so the core languages keep working offline.
// vendor/version.js is generated at build time. A runtime upgrade changes it,
// which makes the browser install this worker again and drop the old cache.
importScripts('vendor/version.js');
const SHELL = 'bytepad-shell-v1';
const RUNTIME = `bytepad-runtime-${self.RUNTIME_VERSION}`;
// Static files are the same for every request, and honouring Vary (Origin,
// Accept-Encoding) would turn cached files into misses when offline.
const MATCH = { ignoreVary: true };

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL, RUNTIME]);
      for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// Requested by the page once it has loaded, so it never delays the first visit.
async function precache() {
  const list = await (await fetch('precache.json')).json();
  const cache = await caches.open(SHELL);
  await Promise.allSettled(list.map(async (path) => {
    if (await cache.match(path, MATCH)) return;
    const response = await fetch(path);
    if (response.ok) await cache.put(path, response);
  }));
}

self.addEventListener('message', (event) => {
  if (event.data === 'precache') event.waitUntil(precache().catch(() => {}));
});

function isolate(response) {
  if (response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function cacheFirst(event, cacheName) {
  const { request } = event;
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, MATCH);
  if (hit) return hit;
  const response = await fetch(request);
  // Not awaited, so the page sees a large download progress as it arrives.
  if (response.ok) event.waitUntil(cache.put(request, response.clone()));
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request, MATCH);
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    const strategy = url.pathname.includes('/vendor/') ? cacheFirst(event, RUNTIME) : networkFirst(request);
    event.respondWith(strategy.then(isolate));
  } else if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/pyodide/')) {
    // Optional Python packages such as numpy, fetched only when a program imports them.
    event.respondWith(cacheFirst(event, RUNTIME));
  }
});
