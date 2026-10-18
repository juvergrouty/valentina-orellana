// Pruebas de la segunda ronda del robot (r2, 18 oct): reconexiones, consentimiento, no grabar
// silencio, pistas terminadas y evento movido. Sin navegador ni red. Correr: cd bot && npm test
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { leerConfig } from './config.js';
import { Segmentos } from './segmentos.js';
import { horaFinDeRespuesta, SinConsentimientoError, Sitio, type EventoBot } from './sitio.js';
import { desfaseOrigen, lineaConDesfase } from './linea.js';
import { instalarGrabadorEnPagina } from './captura/audio-pagina.js';
import { capturarPistasRTC } from './captura/rtc-pagina.js';

const ENV_OK = {
  GRABACION_ID: '3f2b8a1e-0c4d-4e5f-9a6b-7c8d9e0f1a2b',
  MEET_URL: 'https://meet.google.com/abc-defg-hij',
  EVENTO_URL: 'https://www.valentinaorellana.cl/api/transcriptor/bot-evento',
  BOT_TOKEN: 'A'.repeat(43),
  HORA_FIN: '2026-10-16T20:00:00.000Z',
};
const respuesta = (status: number, cuerpo: unknown = {}) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });

test('config r2: reemplazo con SEQ_INICIAL / ORIGEN_MS / ESPERA_LLEGADA_MS; por defecto 0 / null / 30 min / 3 min', () => {
  const c = leerConfig(ENV_OK);
  assert.deepEqual([c.seqInicial, c.origenMs, c.esperaLlegadaMs, c.graciaValeMs], [0, null, 30 * 60_000, 3 * 60_000]);
  const r = leerConfig({ ...ENV_OK, SEQ_INICIAL: '3', ORIGEN_MS: '1792170000000', ESPERA_LLEGADA_MS: '300000' });
  assert.deepEqual([r.seqInicial, r.origenMs, r.esperaLlegadaMs], [3, 1792170000000, 300_000]);
  assert.throws(() => leerConfig({ ...ENV_OK, ORIGEN_MS: 'ayer' }), /ORIGEN_MS/);
  assert.throws(() => leerConfig({ ...ENV_OK, SEQ_INICIAL: '-1' }), /SEQ_INICIAL/);
  assert.throws(() => leerConfig({ ...ENV_OK, SEQ_INICIAL: '500' }), /SEQ_INICIAL/);
});

test('reemplazo r2: offsets y línea de hablantes en el mismo origen que el robot anterior', () => {
  assert.equal(desfaseOrigen(1_000_000, null), 0);
  assert.equal(desfaseOrigen(1_000_000 + 1_800_000, 1_000_000), 1_800_000);
  assert.equal(desfaseOrigen(999_000, 1_000_000), 0, 'reloj desfasado: nunca negativo');
  assert.deepEqual(lineaConDesfase([{ t_ms: 0, nombre: 'A', on: true }, { t_ms: 500, nombre: 'A', on: false }], 60_000),
    [{ t_ms: 60_000, nombre: 'A', on: true }, { t_ms: 60_500, nombre: 'A', on: false }]);
});

test('sitio r2 (punto 2): 403 con codigo sin_consentimiento → SinConsentimientoError sin reintentar', async () => {
  let n = 0;
  const f = (async () => { n++; return respuesta(403, { error: 'Sin consentimiento de grabación vigente', codigo: 'sin_consentimiento' }); }) as unknown as typeof fetch;
  const s = new Sitio({ eventoUrl: 'https://x.cl/e', token: 't', fetch: f, esperaBaseMs: 1 });
  await assert.rejects(s.pedirUrl(0), SinConsentimientoError);
  await assert.rejects(s.enviar({ tipo: 'activo' }), SinConsentimientoError);
  assert.equal(n, 2, 'un solo intento por evento');
  const otro = new Sitio({ eventoUrl: 'https://x.cl/e', token: 't', fetch: (async () => respuesta(403, {})) as unknown as typeof fetch, esperaBaseMs: 1 });
  await assert.rejects(otro.enviar({ tipo: 'activo' }), /rechazó el evento activo/);
});

test('sitio r2 (punto 7): cada respuesta OK pasa por alResponder; hora_fin válida y acotada', async () => {
  const vistas: Record<string, unknown>[] = [];
  const f = (async () => respuesta(200, { ok: true, hora_fin: '2026-10-16T20:30:00.000Z' })) as unknown as typeof fetch;
  const s = new Sitio({ eventoUrl: 'https://x.cl/e', token: 't', fetch: f, esperaBaseMs: 1, alResponder: (r) => { vistas.push(r); } });
  await s.enviar({ tipo: 'activo' });
  assert.equal(vistas.length, 1);
  const actual = new Date('2026-10-16T20:00:00.000Z');
  assert.equal(horaFinDeRespuesta(vistas[0], actual)?.toISOString(), '2026-10-16T20:30:00.000Z');
  assert.equal(horaFinDeRespuesta({ hora_fin: '2026-10-16T20:00:00.000Z' }, actual), null, 'igual: sin cambio');
  assert.equal(horaFinDeRespuesta({ hora_fin: '2026-10-18T20:00:00.000Z' }, actual), null, 'más de 12 h: se ignora');
  assert.equal(horaFinDeRespuesta({ hora_fin: 'mañana' }, actual), null);
  assert.equal(horaFinDeRespuesta({}, actual), null);
});

test('segmentos r2 (punto 2): sin consentimiento no se sube nada más y se descarta lo que hay en memoria', async () => {
  const eventos: EventoBot[] = [];
  const puts: string[] = [];
  const sitio = {
    pedirUrl: async (): Promise<string> => { throw new SinConsentimientoError(); },
    enviar: async (e: EventoBot) => { eventos.push(e); return { ok: true }; },
  };
  const f = (async (url: string) => { puts.push(url); return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
  const segs = new Segmentos({ sitio, fetch: f, esperaBaseMs: 1 });
  segs.agregarTrozo(0, Buffer.from('abc'));
  await segs.cerrar(0, 0, 900_000);
  assert.equal(segs.sinConsentimiento, true);
  segs.agregarTrozo(1, Buffer.from('def'));
  await segs.cerrar(1, 897_000, 1000);
  assert.deepEqual(segs.cerrarHuerfanos(() => ({ offsetMs: 0, duracionMs: 0 })), []);
  assert.deepEqual(await segs.vaciar(), [], 'ni fallidos que reintentar');
  assert.deepEqual([puts, eventos], [[], []]);
});

// ─── Punto 4: pistas terminadas (página simulada, sin navegador) ──────────────

class PistaFalsa extends EventTarget {
  readonly kind = 'audio';
  readyState: 'live' | 'ended' = 'live';
  constructor(readonly id: string) { super(); }
  terminar() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}

function paginaFalsa() {
  const nodos: { desconectado: boolean }[] = [];
  const audios: { pausado: boolean; srcObject: unknown }[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const previos = Object.fromEntries(['window', 'document', 'MediaRecorder', 'AudioContext', 'Audio', 'MediaStream', 'RTCPeerConnection'].map((k) => [k, g[k]]));
  const nodo = () => { const n = { desconectado: false, connect: (x: unknown) => x, disconnect() { n.desconectado = true; } }; return n; };
  g.window = globalThis;
  g.document = { querySelectorAll: () => [] };
  g.MediaRecorder = class { static isTypeSupported() { return true; } };
  g.MediaStream = class { constructor(readonly pistas: unknown[]) {} };
  g.Audio = class { muted = false; srcObject: unknown = null; pausado = false; constructor() { audios.push(this); } play() { return Promise.resolve(); } pause() { this.pausado = true; } };
  g.AudioContext = class {
    state = 'running';
    resume() { return Promise.resolve(); }
    createMediaStreamDestination() { return { ...nodo(), stream: {} }; }
    createConstantSource() { return { ...nodo(), start() {}, connect: (x: unknown) => x }; }
    createGain() { return { gain: { value: 1 }, connect: (x: unknown) => x }; }
    createAnalyser() { return { fftSize: 0, getFloatTimeDomainData() {} }; }
    createMediaStreamSource() { const n = nodo(); nodos.push(n); return n; }
  };
  const restaurar = () => {
    for (const [k, v] of Object.entries(previos)) { if (v === undefined) delete g[k]; else g[k] = v; }
    for (const k of ['__voGrab', '__voT0', '__voPistasRTC', '__voRtcHook']) delete g[k];
  };
  return { nodos, audios, restaurar };
}

test('audio-pagina r2 (punto 4): una pista terminada se desconecta, suelta su <audio> y sale de __voPistasRTC', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const pg = paginaFalsa();
  try {
    const w = globalThis as unknown as { __voPistasRTC: PistaFalsa[]; __voGrab: { pistas(): number; apagar(): void } };
    const a = new PistaFalsa('a'), b = new PistaFalsa('b');
    w.__voPistasRTC = [a, b];
    assert.equal(instalarGrabadorEnPagina({ bitsPorSegundo: 32_000, trozoMs: 10_000 }), true);
    assert.equal(w.__voGrab.pistas(), 2);
    a.terminar(); // con evento 'ended'
    assert.equal(w.__voGrab.pistas(), 1);
    assert.equal(pg.nodos[0].desconectado, true, 'la fuente de la pista terminada se desconecta de la mezcla');
    assert.equal(pg.audios[0].pausado, true);
    assert.equal(pg.audios[0].srcObject, null, 'el <audio> silenciado se suelta');
    b.readyState = 'ended'; // sin evento (Chrome no siempre lo dispara): lo poda el sondeo de 1 s
    mock.timers.tick(1000);
    assert.equal(w.__voGrab.pistas(), 0);
    assert.equal(pg.nodos[1].desconectado, true);
    assert.deepEqual(w.__voPistasRTC, [], 'no se acumulan pistas muertas');
    const c = new PistaFalsa('c');
    w.__voPistasRTC.push(c);
    mock.timers.tick(1000);
    assert.equal(w.__voGrab.pistas(), 1, 'las pistas nuevas se siguen enlazando');
    w.__voGrab.apagar();
    assert.equal(w.__voGrab.pistas(), 0);
  } finally {
    mock.timers.reset();
    pg.restaurar();
  }
});

test('rtc-pagina r2 (punto 4): guarda solo pistas de audio vivas y saca las que terminan', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const previo = g.window;
  const oyentes: ((e: unknown) => void)[] = [];
  class PcFalsa { addEventListener(_t: string, f: (e: unknown) => void) { oyentes.push(f); } }
  g.window = globalThis;
  g.RTCPeerConnection = PcFalsa;
  try {
    capturarPistasRTC();
    new (g.RTCPeerConnection as new () => unknown)();
    const viva = new PistaFalsa('v'), muerta = new PistaFalsa('m');
    muerta.readyState = 'ended';
    for (const t of [viva, muerta, { kind: 'video', readyState: 'live' }]) oyentes[0]({ track: t });
    const lista = g.__voPistasRTC as unknown[];
    assert.deepEqual(lista, [viva]);
    viva.terminar();
    assert.deepEqual(lista, []);
  } finally {
    for (const k of ['__voPistasRTC', '__voRtcHook', 'RTCPeerConnection']) delete g[k];
    if (previo === undefined) delete g.window; else g.window = previo;
  }
});
