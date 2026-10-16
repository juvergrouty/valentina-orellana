// Pruebas unitarias del bot (sin navegador ni red). Correr: cd bot && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esNombreDeBot, esVale, leerConfig, normalizarNombre } from './config.js';
import { LineaHablantes } from './linea.js';
import { Vigia } from './vigia.js';
import { Segmentos } from './segmentos.js';
import { Sitio, TokenRechazadoError, type EventoBot } from './sitio.js';
import { trayectoria } from './meet/humano.js';
import { conIdiomaFijo } from './meet/argumentos.js';
import { esRechazoExplicito } from './meet/admision.js';

const ENV_OK = {
  GRABACION_ID: '3f2b8a1e-0c4d-4e5f-9a6b-7c8d9e0f1a2b',
  MEET_URL: 'https://meet.google.com/abc-defg-hij',
  EVENTO_URL: 'https://www.valentinaorellana.cl/api/transcriptor/bot-evento',
  BOT_TOKEN: 'A'.repeat(43),
  HORA_FIN: '2026-10-16T20:00:00.000Z',
};

test('leerConfig acepta la configuración mínima y aplica valores por defecto', () => {
  const c = leerConfig(ENV_OK);
  assert.equal(c.botNombre, 'Notas de Ps. Valentina Orellana');
  assert.equal(c.esperaAdmisionMs, 20 * 60_000);
  assert.equal(c.soloMs, 60_000);
  assert.equal(c.maxExtraMs, 30 * 60_000);
  assert.equal(c.segmentoMs, 15 * 60_000);
  assert.equal(c.solapamientoMs, 3_000);
  assert.equal(c.maxHumanos, 2);
});

test('leerConfig rechaza enlaces que no son de Meet, http y tokens raros', () => {
  assert.throws(() => leerConfig({ ...ENV_OK, MEET_URL: 'https://evil.example/abc-defg-hij' }), /Meet/);
  assert.throws(() => leerConfig({ ...ENV_OK, MEET_URL: 'https://meet.google.com/abc-defg-hij?x=1' }), /Meet/);
  assert.throws(() => leerConfig({ ...ENV_OK, EVENTO_URL: 'http://www.valentinaorellana.cl/x' }), /https/);
  assert.throws(() => leerConfig({ ...ENV_OK, BOT_TOKEN: 'corto' }), /BOT_TOKEN/);
  assert.throws(() => leerConfig({ ...ENV_OK, GRABACION_ID: 'x' }), /uuid/);
  assert.throws(() => leerConfig({ ...ENV_OK, SOLO_MS: '-5' }), /SOLO_MS/);
  const { BOT_TOKEN: _omit, ...sinToken } = ENV_OK;
  assert.throws(() => leerConfig(sinToken), /BOT_TOKEN/);
});

test('nombres: normaliza tildes y reconoce bots y a Vale', () => {
  assert.equal(normalizarNombre('  Valentína   ORELLANA '), 'valentina orellana');
  assert.ok(esNombreDeBot('Notas de Ps. Valentina Orellana', 'Notas de Ps. Valentina Orellana'));
  assert.ok(esNombreDeBot('Otter.ai Notetaker', 'x'));
  assert.ok(!esNombreDeBot('Camila Rojas', 'Notas de Ps. Valentina Orellana'));
  assert.ok(esVale('Valentina Orellana', ['Valentina Orellana']));
  assert.ok(!esVale('Valentina Pérez', ['Valentina Orellana']));
});

const VIGIA = { botNombre: 'Notas de Ps. Valentina Orellana', valeNombres: ['Valentina Orellana'], soloMs: 60_000, maxHumanos: 2, limiteMs: 10_000_000 };

test('vigía: sale cuando Vale se va (tras la gracia) y no antes', () => {
  const v = new Vigia(VIGIA);
  assert.equal(v.observar(0, ['Valentina Orellana', 'Camila']), null);
  assert.equal(v.observar(1000, ['Camila']), null);
  assert.equal(v.observar(15_000, ['Camila']), null);
  assert.equal(v.observar(21_000, ['Camila']), 'vale_salio');
});

test('vigía: si Vale vuelve dentro de la gracia, sigue', () => {
  const v = new Vigia(VIGIA);
  v.observar(0, ['Valentina Orellana', 'Camila']);
  v.observar(5000, ['Camila']);
  assert.equal(v.observar(10_000, ['Valentina Orellana', 'Camila']), null);
  assert.equal(v.observar(40_000, ['Valentina Orellana', 'Camila']), null);
});

test('vigía: solo bots durante soloMs → solo', () => {
  const v = new Vigia(VIGIA);
  assert.equal(v.observar(0, ['Otter Notetaker']), null);
  assert.equal(v.observar(59_000, []), null);
  assert.equal(v.observar(60_000, ['Otter Notetaker']), 'solo');
});

test('vigía: más humanos de los esperados → participantes_extra; un parpadeo no cuenta', () => {
  const v = new Vigia(VIGIA);
  assert.equal(v.observar(0, ['Valentina Orellana', 'Camila', 'Tercero']), null);
  assert.equal(v.observar(5000, ['Valentina Orellana', 'Camila']), null);
  assert.equal(v.observar(6000, ['Valentina Orellana', 'Camila', 'Tercero']), null);
  assert.equal(v.observar(21_000, ['Valentina Orellana', 'Camila', 'Tercero']), 'participantes_extra');
  const pareja = new Vigia({ ...VIGIA, maxHumanos: 3 });
  assert.equal(pareja.observar(0, ['Valentina Orellana', 'A', 'B']), null);
  assert.equal(pareja.observar(60_000, ['Valentina Orellana', 'A', 'B']), null);
});

test('vigía: pasada la hora límite sale con hora_fin', () => {
  const v = new Vigia({ ...VIGIA, limiteMs: 1000 });
  assert.equal(v.observar(1000, ['Valentina Orellana', 'Camila']), 'hora_fin');
});

test('línea de hablantes: ignora bots y repetidos, ordena y cierra al final', () => {
  const l = new LineaHablantes('Notas de Ps. Valentina Orellana');
  l.registrar(100, 'Valentina Orellana', true);
  l.registrar(150, 'Valentina Orellana', true); // repetido
  l.registrar(200, 'Notas de Ps. Valentina Orellana', true); // el propio bot
  l.registrar(900, 'Camila', true);
  l.registrar(800, 'Valentina Orellana', false); // llega desordenado → se pega a 900
  l.registrar(-5, 'Camila', false); // t inválido
  const out = l.cerrar(2000);
  assert.deepEqual(out, [
    { t_ms: 100, nombre: 'Valentina Orellana', on: true },
    { t_ms: 900, nombre: 'Camila', on: true },
    { t_ms: 900, nombre: 'Valentina Orellana', on: false },
    { t_ms: 2000, nombre: 'Camila', on: false },
  ]);
});

function respuesta(status: number, cuerpo: unknown = {}): Response {
  return new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });
}

test('sitio: manda Bearer, reintenta 5xx y corta en 404 (token rechazado)', async () => {
  const llamadas: { url: string; auth: string | null; cuerpo: unknown }[] = [];
  let n = 0;
  const f = (async (url: string, init: RequestInit) => {
    llamadas.push({ url, auth: new Headers(init.headers).get('authorization'), cuerpo: JSON.parse(String(init.body)) });
    n++;
    return n === 1 ? respuesta(503) : respuesta(200, { ok: true });
  }) as unknown as typeof fetch;
  const s = new Sitio({ eventoUrl: 'https://x.cl/e', token: 'T'.repeat(43), fetch: f, esperaBaseMs: 1 });
  assert.deepEqual(await s.enviar({ tipo: 'lobby' }), { ok: true });
  assert.equal(llamadas.length, 2);
  assert.equal(llamadas[0].auth, `Bearer ${'T'.repeat(43)}`);
  assert.deepEqual(llamadas[0].cuerpo, { tipo: 'lobby' });

  const f404 = (async () => respuesta(404)) as unknown as typeof fetch;
  const s2 = new Sitio({ eventoUrl: 'https://x.cl/e', token: 't', fetch: f404, esperaBaseMs: 1 });
  await assert.rejects(s2.enviar({ tipo: 'activo' }), TokenRechazadoError);
});

test('segmentos: une trozos, pide URL, hace PUT y avisa segmento_subido', async () => {
  const eventos: EventoBot[] = [];
  const puts: { url: string; tipo: string | null; bytes: number }[] = [];
  const sitio = {
    pedirUrl: async (seq: number) => `https://r2.example/a/${seq}?firma=1`,
    enviar: async (e: EventoBot) => { eventos.push(e); return { ok: true }; },
  };
  const f = (async (url: string, init: RequestInit) => {
    puts.push({ url, tipo: new Headers(init.headers).get('content-type'), bytes: (init.body as Buffer).length });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  const segs = new Segmentos({ sitio, fetch: f, esperaBaseMs: 1 });
  segs.agregarTrozo(0, Buffer.from('abc'));
  segs.agregarTrozo(0, Buffer.from('de'));
  await segs.cerrar(0, 0, 900_000);
  await segs.cerrar(1, 897_000, 10); // vacío: no se sube
  assert.deepEqual(await segs.vaciar(), []);
  assert.deepEqual(puts, [{ url: 'https://r2.example/a/0?firma=1', tipo: 'audio/webm', bytes: 5 }]);
  assert.deepEqual(eventos, [{ tipo: 'segmento_subido', seq: 0, bytes: 5, offset_ms: 0, duracion_ms: 900_000 }]);
});

test('segmentos: si el PUT falla siempre, queda en la lista de fallidos', async () => {
  const sitio = { pedirUrl: async () => 'https://r2.example/a', enviar: async () => ({}) };
  const f = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
  const segs = new Segmentos({ sitio, fetch: f, esperaBaseMs: 1, intentosPut: 2 });
  segs.agregarTrozo(3, Buffer.from('x'));
  await segs.cerrar(3, 0, 1);
  assert.deepEqual(await segs.vaciar(), [3]);
});

test('trayectoria del mouse termina exactamente en el destino', () => {
  let s = 1;
  const azar = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const pts = trayectoria(0, 0, 400, 300, 20, azar);
  assert.equal(pts.length, 20);
  assert.deepEqual(pts[pts.length - 1], { x: 400, y: 300 });
});

test('Meet: idioma fijo y clasificación de rechazo', () => {
  assert.equal(conIdiomaFijo('https://meet.google.com/abc-defg-hij'), 'https://meet.google.com/abc-defg-hij?hl=en');
  assert.ok(esRechazoExplicito('text=denied your request'));
  assert.ok(!esRechazoExplicito('button:has-text("Try again")'));
});
