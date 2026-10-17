// Service worker del grabador (17 oct 2026). Alcance: SOLO /admin/grabar (lo registra grabar.astro con
// scope '/admin/grabar').
//
// Qué hace: si la página del grabador se abre SIN internet (modo avión), en vez del error de Safari
// ("no está conectado a internet") muestra /grabar-sin-internet.html, una página estática que cuenta las
// grabaciones guardadas en este teléfono y vuelve sola al grabador cuando hay internet; ahí el grabador
// retoma la subida de lo pendiente.
//
// Qué NO hace (a propósito, por privacidad y seguridad):
//  - No guarda en caché la página del grabador ni ninguna respuesta autenticada (traen nombres de pacientes).
//  - No intercepta ninguna otra ruta, ni /api, ni recursos: solo la navegación a /admin/grabar.
//  - No permite empezar una grabación sin internet: antes de grabar el sitio verifica el consentimiento.
const CACHE = 'vo-grabar-v1';
const SIN_INTERNET = '/grabar-sin-internet.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add(new Request(SIN_INTERNET, { cache: 'reload' }))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('vo-grabar-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate' || req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname !== '/admin/grabar') return;
  // Red primero, siempre: con internet se comporta exactamente como sin service worker.
  event.respondWith(
    fetch(req).catch(async () => (await caches.match(SIN_INTERNET, { cacheName: CACHE }))
      || new Response('Sin internet. Vuelve a abrir esta página cuando tengas conexión.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })),
  );
});
