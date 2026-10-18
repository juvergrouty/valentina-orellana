// Service worker del grabador (public/grabar-sw.js): se ejecuta con un "self" falso, sin red real.
// Ronda 2 (18 oct): guarda la página estática /grabar-sin-internet (grabador para RETOMAR) y sus archivos.
// Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const RAIZ = join(import.meta.dirname, '..', '..', '..');
const CODIGO = readFileSync(join(RAIZ, 'public', 'grabar-sw.js'), 'utf8');
const PAGINA_ASTRO = readFileSync(join(RAIZ, 'src', 'pages', 'grabar-sin-internet.astro'), 'utf8');
const VERCEL = JSON.parse(readFileSync(join(RAIZ, 'vercel.json'), 'utf8'));
const ORIGEN = 'https://www.valentinaorellana.cl';

const HTML = '<!doctype html><link rel="stylesheet" href="/_astro/compiler.B6Pr.css"><script type="module" src="/_astro/Grabador.astro_astro_type_script_index_0_lang.CKd.js"></script><a href="https://otro.cl/_astro/x.js">x</a>';
const ARCHIVOS: Record<string, string> = {
  '/_astro/compiler.B6Pr.css': 'body{}',
  '/_astro/Grabador.astro_astro_type_script_index_0_lang.CKd.js': 'import{a}from"./medidor.Xy1.js";a()',
  '/_astro/medidor.Xy1.js': 'export const a=()=>1',
};

function cargarSW(red: { caida: boolean; falla?: string }) {
  const oyentes: Record<string, (e: any) => void> = {};
  const tienda = new Map<string, Response>();
  const pedidos: string[] = [];
  const clave = (u: string) => new URL(u, ORIGEN).pathname;
  const cache = {
    put: async (u: string, r: Response) => { tienda.set(clave(u), r); },
    keys: async () => [...tienda.keys()].map((k) => ({ url: ORIGEN + k })),
    delete: async (r: { url: string }) => tienda.delete(clave(r.url)),
  };
  const self = {
    location: { origin: ORIGEN },
    addEventListener: (t: string, f: (e: any) => void) => { oyentes[t] = f; },
    skipWaiting: async () => {}, clients: { claim: async () => {} },
  };
  const caches = {
    open: async () => cache, keys: async () => ['vo-grabar-v1', 'vo-grabar-v2'], delete: async () => true,
    match: async (u: string) => tienda.get(clave(u))?.clone(),
  };
  const fetchFalso = async (r: string | { url: string }) => {
    const ruta = clave(typeof r === 'string' ? r : r.url);
    pedidos.push(ruta);
    if (red.caida) throw new TypeError('Load failed');
    if (ruta === red.falla) return new Response('no', { status: 404 });
    if (ruta === '/grabar-sin-internet') return new Response(HTML, { headers: { 'Content-Type': 'text/html', 'Permissions-Policy': 'microphone=(self)', 'Content-Encoding': 'br' } });
    if (ruta === '/admin/grabar') return new Response('grabador en vivo');
    if (ARCHIVOS[ruta]) return new Response(ARCHIVOS[ruta], { headers: { 'Content-Type': ruta.endsWith('.css') ? 'text/css' : 'text/javascript' } });
    return new Response('red', { status: 200 });
  };
  runInNewContext(CODIGO, { self, caches, fetch: fetchFalso, Response, Headers, URL, Promise, Set, Map, TextDecoder });
  return { oyentes, tienda, pedidos, red };
}

async function instalar(sw: ReturnType<typeof cargarSW>) {
  let espera: Promise<unknown> | null = null;
  sw.oyentes.install({ waitUntil: (p: Promise<unknown>) => { espera = p; } });
  await espera;
}

async function pedir(sw: ReturnType<typeof cargarSW>, url: string, modo = 'navigate', metodo = 'GET'): Promise<Response | null> {
  let respuesta: Promise<Response> | null = null;
  const esperas: Promise<unknown>[] = [];
  sw.oyentes.fetch({ request: { url, mode: modo, method: metodo }, respondWith: (p: Promise<Response>) => { respuesta = p; }, waitUntil: (p: Promise<unknown>) => { esperas.push(p); } });
  const r = respuesta ? await respuesta : null;
  await Promise.all(esperas);
  return r;
}

test('instala SOLO la página estática y sus archivos /_astro/ (también los que importa un JS); nada autenticado', async () => {
  const sw = cargarSW({ caida: false });
  await instalar(sw);
  assert.deepEqual([...sw.tienda.keys()].sort(), ['/_astro/Grabador.astro_astro_type_script_index_0_lang.CKd.js', '/_astro/compiler.B6Pr.css', '/_astro/medidor.Xy1.js', '/grabar-sin-internet']);
  assert.ok(!sw.pedidos.some((p) => p.startsWith('/admin') || p.startsWith('/api')), 'no pide nada del panel al instalar');
  const pag = sw.tienda.get('/grabar-sin-internet')!;
  assert.equal(pag.headers.get('Permissions-Policy'), 'microphone=(self)', 'conserva el permiso de micrófono');
  assert.equal(pag.headers.get('Content-Encoding'), null, 'sin cabeceras de transporte');
});

test('si falta un archivo no deja una copia a medias (la instalación falla y queda la anterior)', async () => {
  const sw = cargarSW({ caida: false, falla: '/_astro/medidor.Xy1.js' });
  await assert.rejects(instalar(sw));
  assert.equal(sw.tienda.size, 0);
});

test('con internet /admin/grabar va a la red (nunca se guarda) y refresca la copia; sin internet sirve el grabador para retomar', async () => {
  const sw = cargarSW({ caida: false });
  const r = await pedir(sw, `${ORIGEN}/admin/grabar?paciente=1`);
  assert.equal(await r!.text(), 'grabador en vivo');
  assert.ok(!sw.tienda.has('/admin/grabar'), 'la página real (con pacientes) no se guarda');
  assert.ok(sw.tienda.has('/grabar-sin-internet'), 'aprovecha de actualizar la página sin internet');
  sw.red.caida = true;
  const sin = await pedir(sw, `${ORIGEN}/admin/grabar`);
  assert.equal(sin!.status, 200);
  assert.equal(sin!.redirected, false);
  assert.match(await sin!.text(), /Grabador\.astro/);
  // Sus archivos, desde la copia (sin red).
  assert.equal(await (await pedir(sw, `${ORIGEN}/_astro/medidor.Xy1.js`, 'cors'))!.text(), 'export const a=()=>1');
});

test('sin copia y sin internet: mensaje simple (503), no el error de Safari', async () => {
  const sw = cargarSW({ caida: true });
  const r = await pedir(sw, `${ORIGEN}/admin/grabar`);
  assert.equal(r!.status, 503);
});

test('no intercepta otras páginas, APIs, POST ni otros dominios', async () => {
  const sw = cargarSW({ caida: true });
  assert.equal(await pedir(sw, `${ORIGEN}/admin/pacientes`), null);
  assert.equal(await pedir(sw, `${ORIGEN}/api/admin/transcriptor/grabacion-iniciar`, 'cors', 'POST'), null);
  assert.equal(await pedir(sw, `${ORIGEN}/api/admin/transcriptor/subida-url`, 'cors'), null);
  assert.equal(await pedir(sw, 'https://otro.cl/admin/grabar'), null);
});

test('la página sin internet es estática, sin datos de pacientes, con micrófono permitido y noindex', () => {
  assert.match(PAGINA_ASTRO, /export const prerender = true/);
  assert.match(PAGINA_ASTRO, /DATOS_SIN_INTERNET/);
  assert.match(PAGINA_ASTRO, /noindex/);
  assert.doesNotMatch(PAGINA_ASTRO, /supabase|Astro\.cookies|Astro\.url/);
  const reglas = VERCEL.headers as { source: string; headers: { key: string; value: string }[] }[];
  const propia = reglas.find((r) => r.source === '/grabar-sin-internet')!;
  assert.match(propia.headers.find((h) => h.key === 'Permissions-Policy')!.value, /microphone=\(self\)/);
  const general = reglas.find((r) => r.source.startsWith('/((?!'))!;
  assert.ok(new RegExp(`^${general.source}$`).test('/grabar-sin-internet') === false, 'la regla general (micrófono apagado) no la toca');
  assert.ok(new RegExp(`^${general.source}$`).test('/admin/pacientes'));
});
