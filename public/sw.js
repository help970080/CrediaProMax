// Service worker PWA. HTML SIEMPRE fresco (red, no-store) y auto-recarga las
// pestañas cuando se activa una versión nueva. CSS/JS/img: network-first.
const CACHE = 'cobrapro-v4';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
  await self.clients.claim();
  // recargar las pestañas abiertas para que tomen el HTML nuevo
  const cs = await self.clients.matchAll({ type: 'window' });
  for (const c of cs) { try { c.navigate(c.url); } catch (e) {} }
})()); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.url.includes('/api/')) return;
  const isHTML = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) { e.respondWith(fetch(req, { cache: 'no-store' }).catch(() => caches.match(req))); return; }
  e.respondWith(
    fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); return res; })
      .catch(() => caches.match(req))
  );
});
