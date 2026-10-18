// Service worker del grabador (17 oct 2026; ronda 2: 18 oct). Lo registra el grabador con scope '/admin/grabar'.
//
// Qué hace: si /admin/grabar se abre SIN internet (modo avión, o iOS descartó la pestaña de Safari en plena
// sesión y al volver la recarga), en vez del error de Safari muestra el GRABADOR SIN INTERNET: la página
// estática /grabar-sin-internet (src/pages/grabar-sin-internet.astro, se genera al compilar). Desde ahí se
// puede SEGUIR grabando la grabación que se cortó (la misma, ya autorizada con internet: mismo id, segmentos
// que continúan, trozos en IndexedDB) y ver lo pendiente. Con internet vuelve sola a /admin/grabar, que sube.
//
// Qué guarda en el teléfono: SOLO esa página estática y sus archivos /_astro/ (JS y CSS con huella en el
// nombre). Ninguno trae datos de pacientes ni de la sesión del panel: son iguales para cualquier visita.
//
// Qué NO hace (a propósito, por privacidad y seguridad):
//  - No guarda la página real del grabador ni ninguna respuesta autenticada (traen nombres de pacientes).
//  - No intercepta /api ni ninguna otra página; con internet todo va a la red como sin service worker.
//  - No permite empezar una grabación nueva sin internet: antes de grabar el servidor verifica el
//    consentimiento (grabacion-iniciar) y entrega el id; sin ese id el grabador no graba.
const CACHE = 'vo-grabar-v2';
const PAGINA = '/grabar-sin-internet';
const ASSET = /^\/_astro\/[\w.@-]+\.(?:js|css|woff2?)$/;

/** URLs /_astro/ que cita un HTML, CSS o JS (src/href, import, url()). Relativas al archivo que las cita. */
function referencias(texto, base) {
  const out = new Set();
  const re = /(?:src|href)=["']([^"']+)["']|(?:import|from)\s*\(?\s*["']([^"']+)["']|url\(\s*["']?([^"')]+)["']?\s*\)/g;
  let m;
  while ((m = re.exec(texto))) {
    const ref = m[1] || m[2] || m[3];
    try {
      const u = new URL(ref, base);
      if (u.origin === self.location.origin && ASSET.test(u.pathname)) out.add(u.pathname);
    } catch { /* referencia inválida */ }
  }
  return out;
}

let guardando = null;
/**
 * Baja la página estática y TODOS sus archivos; recién si todo llegó bien reemplaza la copia anterior
 * (nunca queda una página nueva con archivos viejos o a medias). Respuestas copiadas sin "redirected"
 * (una navegación no acepta una respuesta redirigida).
 */
function guardarPagina() {
  if (guardando) return guardando;
  guardando = (async () => {
    const res = await fetch(PAGINA, { cache: 'no-cache', credentials: 'omit' });
    if (!res.ok) throw new Error(`página sin internet: ${res.status}`);
    const html = await res.text();
    const nuevos = new Map();
    const pendientes = [...referencias(html, self.location.origin + PAGINA)];
    const vistos = new Set(pendientes);
    while (pendientes.length) {
      const ruta = pendientes.shift();
      const r = await fetch(ruta, { credentials: 'omit' });
      if (!r.ok) throw new Error(`archivo ${ruta}: ${r.status}`);
      const cuerpo = await r.arrayBuffer();
      nuevos.set(ruta, new Response(cuerpo, { status: 200, headers: { 'Content-Type': r.headers.get('Content-Type') || 'application/octet-stream' } }));
      if (/\.(?:js|css)$/.test(ruta)) {
        for (const x of referencias(new TextDecoder().decode(cuerpo), self.location.origin + ruta)) {
          if (!vistos.has(x)) { vistos.add(x); pendientes.push(x); }
        }
      }
    }
    // Cabeceras de la página (incluye Permissions-Policy con micrófono, vercel.json), sin las de transporte.
    const cabeceras = new Headers(res.headers);
    for (const h of ['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie']) cabeceras.delete(h);
    const cache = await caches.open(CACHE);
    await cache.put(PAGINA, new Response(html, { status: 200, headers: cabeceras }));
    for (const [ruta, r] of nuevos) await cache.put(ruta, r);
    for (const req of await cache.keys()) {
      const p = new URL(req.url).pathname;
      if (p !== PAGINA && !nuevos.has(p)) await cache.delete(req);
    }
  })().finally(() => { guardando = null; });
  return guardando;
}

self.addEventListener('install', (event) => {
  event.waitUntil(guardarPagina().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k.startsWith('vo-grabar-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function paginaSinInternet() {
  const c = await caches.match(PAGINA, { cacheName: CACHE });
  if (c) return new Response(await c.blob(), { status: 200, headers: c.headers });
  return new Response('Sin internet. Vuelve a abrir esta página cuando tengas conexión.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Archivos de la página sin internet (JS/CSS con huella, inmutables): de la copia si están; si no, red.
  if (ASSET.test(url.pathname)) {
    event.respondWith(caches.match(url.pathname, { cacheName: CACHE }).then((c) => c || fetch(req)));
    return;
  }
  if (req.mode !== 'navigate' || url.pathname !== '/admin/grabar') return;
  // Red primero, siempre: con internet se comporta exactamente como sin service worker (y de paso
  // actualiza la copia de la página sin internet, por si hubo un deploy).
  event.respondWith(
    fetch(req).then((res) => { try { event.waitUntil(guardarPagina().catch(() => undefined)); } catch { /* fuera de plazo */ } return res; })
      .catch(() => paginaSinInternet()),
  );
});
