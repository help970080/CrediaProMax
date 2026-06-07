// Service worker mínimo para que la app sea instalable (PWA).
// Estrategia: la red manda (la app necesita datos en vivo); el SW solo
// permite la instalación y un fallback básico si no hay conexión.
const CACHE = 'cobrapro-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', e => {
  const req = e.request;
  // Nunca cachear la API ni peticiones que no sean GET
  if (req.method !== 'GET' || req.url.includes('/api/')) return;
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req))
  );
});
