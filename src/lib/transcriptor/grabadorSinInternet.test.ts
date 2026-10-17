// Service worker del grabador (public/grabar-sw.js): se ejecuta con un "self" falso, sin red real.
// Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const RAIZ = join(import.meta.dirname, '..', '..', '..');
const CODIGO = readFileSync(join(RAIZ, 'public', 'grabar-sw.js'), 'utf8');
const PAGINA = readFileSync(join(RAIZ, 'public', 'grabar-sin-internet.html'), 'utf8');

function cargarSW(red: 'ok' | 'caida') {
  const oyentes: Record<string, (e: any) => void> = {};
  const guardados: string[] = [];
  const cache = { add: async (r: Request) => { guardados.push(new URL(r.url, 'https://x').pathname); }, put: async () => { throw new Error('no debe usar put'); } };
  const self = {
    location: { origin: 'https://www.valentinaorellana.cl' },
    addEventListener: (t: string, f: (e: any) => void) => { oyentes[t] = f; },
    skipWaiting: async () => {}, clients: { claim: async () => {} },
  };
  const caches = {
    open: async () => cache, keys: async () => [], delete: async () => true,
    match: async (u: string) => (guardados.includes(u) ? new Response('pagina sin internet') : undefined),
  };
  const fetchFalso = async () => { if (red === 'caida') throw new TypeError('Load failed'); return new Response('grabador en vivo'); };
  runInNewContext(CODIGO, { self, caches, fetch: fetchFalso, Request: class { url: string; constructor(u: string) { this.url = `https://www.valentinaorellana.cl${u}`; } }, Response, URL, Promise });
  return { oyentes, guardados };
}

async function navegar(sw: ReturnType<typeof cargarSW>, url: string, modo = 'navigate', metodo = 'GET'): Promise<string | null> {
  let respuesta: Promise<Response> | null = null;
  sw.oyentes.fetch({ request: { url, mode: modo, method: metodo }, respondWith: (p: Promise<Response>) => { respuesta = p; } });
  return respuesta ? (await respuesta as Response).text() : null;
}

test('instala solo la página estática sin internet (nada autenticado)', async () => {
  const sw = cargarSW('ok');
  let espera: Promise<unknown> | null = null;
  sw.oyentes.install({ waitUntil: (p: Promise<unknown>) => { espera = p; } });
  await espera;
  assert.deepEqual(sw.guardados, ['/grabar-sin-internet.html']);
  assert.doesNotMatch(CODIGO, /\.put\(/); // nunca guarda respuestas de la red
});

test('con internet no cambia nada; sin internet muestra la página estática', async () => {
  const ok = cargarSW('ok');
  assert.equal(await navegar(ok, 'https://www.valentinaorellana.cl/admin/grabar?paciente=1'), 'grabador en vivo');
  const caida = cargarSW('caida');
  let espera: Promise<unknown> | null = null;
  caida.oyentes.install({ waitUntil: (p: Promise<unknown>) => { espera = p; } });
  await espera;
  assert.equal(await navegar(caida, 'https://www.valentinaorellana.cl/admin/grabar'), 'pagina sin internet');
});

test('no intercepta otras rutas, APIs, recursos ni POST', async () => {
  const sw = cargarSW('caida');
  assert.equal(await navegar(sw, 'https://www.valentinaorellana.cl/admin/pacientes'), null);
  assert.equal(await navegar(sw, 'https://www.valentinaorellana.cl/api/admin/transcriptor/grabacion-iniciar', 'cors', 'POST'), null);
  assert.equal(await navegar(sw, 'https://www.valentinaorellana.cl/_astro/x.js', 'no-cors'), null);
  assert.equal(await navegar(sw, 'https://otro.cl/admin/grabar'), null);
});

test('la página sin internet no trae datos de pacientes, no crea la base y vuelve sola al grabador', () => {
  assert.match(PAGINA, /noindex/);
  assert.match(PAGINA, /Abre la página con internet y recién después activa el modo avión/);
  assert.match(PAGINA, /addEventListener\('online', volver\)/);
  assert.match(PAGINA, /onupgradeneeded = function \(\) \{ r\.transaction\.abort\(\); \}/);
  assert.doesNotMatch(PAGINA, /etiqueta|nombre/);
});
