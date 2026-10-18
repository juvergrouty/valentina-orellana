// Pruebas unitarias del bot (sin navegador ni red). Correr: cd bot && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esNombreDeBot, esVale, leerConfig, normalizarNombre, NOMBRE_ROBOT } from './config.js';
import { estadoSesionValido, muestraCorreo, soloGoogle } from './sesion.js';
import { LineaHablantes } from './linea.js';
import { decidirInicio, listaIlegible, nombreVisible, Vigia } from './vigia.js';
import { Segmentos } from './segmentos.js';
import { horaFinDeRespuesta, SinConsentimientoError, Sitio, TokenRechazadoError, type EventoBot } from './sitio.js';
import { desfaseOrigen, lineaConDesfase } from './linea.js';
import { trayectoria } from './meet/humano.js';
import { argumentosChromium, conIdiomaFijo } from './meet/argumentos.js';
import { sanearError } from './saneo.js';
import { esBloqueoRecaptcha, esRechazoExplicito } from './meet/admision.js';

const ENV_OK = {
  GRABACION_ID: '3f2b8a1e-0c4d-4e5f-9a6b-7c8d9e0f1a2b',
  MEET_URL: 'https://meet.google.com/abc-defg-hij',
  EVENTO_URL: 'https://www.valentinaorellana.cl/api/transcriptor/bot-evento',
  BOT_TOKEN: 'A'.repeat(43),
  HORA_FIN: '2026-10-16T20:00:00.000Z',
};

test('leerConfig acepta la configuración mínima y aplica valores por defecto', () => {
  const c = leerConfig(ENV_OK);
  assert.equal(c.botNombre, 'Notas Ps. Valentina Orellana');
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
  assert.ok(esNombreDeBot('Notas Ps. Valentina Orellana', 'Notas Ps. Valentina Orellana'));
  assert.ok(esNombreDeBot('Otter.ai Notetaker', 'x'));
  assert.ok(!esNombreDeBot('Camila Rojas', 'Notas Ps. Valentina Orellana'));
  assert.ok(esVale('Valentina Orellana', ['Valentina Orellana']));
  assert.ok(!esVale('Valentina Pérez', ['Valentina Orellana']));
});

const VIGIA = { botNombre: 'Notas Ps. Valentina Orellana', valeNombres: ['Valentina Orellana'], soloMs: 60_000, maxHumanos: 2, limiteMs: 10_000_000 };

test('vigía: Vale se va con el paciente en la llamada → a lo más 3 min más (reconexión) y vale_salio', () => {
  const v = new Vigia(VIGIA);
  assert.equal(v.observar(0, ['Valentina Orellana', 'Camila']), null);
  assert.equal(v.observar(1000, ['Camila']), null);
  assert.equal(v.observar(21_000, ['Camila']), null, 'ya no corta a los 20 s: tolera la reconexión de Vale');
  assert.equal(v.observar(2 * 60_000, ['Camila']), null);
  assert.equal(v.observar(1000 + 3 * 60_000, ['Camila']), 'vale_salio', 'tope de 3 min grabando al paciente solo');
});

test('vigía r2: Vale reconecta dentro de 3 min → sigue; Vale era la última y cuelga → vale_salio en 60 s', () => {
  const v = new Vigia(VIGIA);
  v.observar(0, ['Valentina Orellana', 'Camila']);
  v.empezoGrabacion(); // Vale está: el robot graba
  v.observar(10_000, ['Camila']);
  assert.equal(v.observar(150_000, ['Valentina Orellana', 'Camila']), null);
  assert.equal(v.observar(400_000, ['Valentina Orellana', 'Camila']), null);
  // Fin normal: el paciente sale, Vale queda sola y cuelga.
  assert.equal(v.observar(410_000, ['Valentina Orellana']), null);
  assert.equal(v.observar(420_000, []), null);
  assert.equal(v.observar(480_000, []), 'vale_salio');
  // Desaparecen todos a la vez (falla de la página o de la red del robot) → 'solo' (el sitio relanza).
  const w = new Vigia(VIGIA);
  w.observar(0, ['Valentina Orellana', 'Camila']);
  w.empezoGrabacion();
  assert.equal(w.observar(2_000, []), null);
  assert.equal(w.observar(62_000, []), 'solo');
});

test('vigía r2 (punto 8): el recuadro de pantalla compartida no cuenta como otra persona', () => {
  assert.equal(nombreVisible('Valentina Orellana (Presentation)'), 'Valentina Orellana');
  assert.equal(nombreVisible('Valentina Orellana (presentación)'), 'Valentina Orellana');
  assert.equal(nombreVisible('Presentation from Camila Rojas'), 'Camila Rojas');
  assert.equal(nombreVisible('Camila Rojas is presenting'), 'Camila Rojas');
  assert.equal(nombreVisible('You are presenting'), '');
  assert.equal(nombreVisible('Camila Rojas'), 'Camila Rojas');
  const v = new Vigia(VIGIA);
  const tiles = ['Valentina Orellana', 'Camila Rojas', 'Valentina Orellana (Presentation)', 'You are presenting'];
  assert.deepEqual(v.humanos(tiles), ['Valentina Orellana', 'Camila Rojas']);
  for (let t = 0; t <= 60_000; t += 2_000) assert.equal(v.observar(t, tiles), null, 'no sale por participantes_extra');
});

test('vigía r2: el sitio puede mover la hora límite (evento movido)', () => {
  const v = new Vigia({ ...VIGIA, limiteMs: 1000 });
  v.fijarLimite(5000);
  assert.equal(v.observar(1000, ['Valentina Orellana', 'Camila']), null);
  assert.equal(v.observar(5000, ['Valentina Orellana', 'Camila']), 'hora_fin');
});

test('vigía: si Vale vuelve dentro de la gracia, sigue', () => {
  const v = new Vigia(VIGIA);
  v.observar(0, ['Valentina Orellana', 'Camila']);
  v.observar(5000, ['Camila']);
  assert.equal(v.observar(10_000, ['Valentina Orellana', 'Camila']), null);
  assert.equal(v.observar(40_000, ['Valentina Orellana', 'Camila']), null);
});

test('vigía: después de ver a alguien, solo bots durante soloMs → solo', () => {
  const v = new Vigia(VIGIA);
  v.empezoGrabacion();
  assert.equal(v.observar(0, ['Paciente Prueba']), null);
  assert.equal(v.observar(1_000, ['Otter Notetaker']), null);
  assert.equal(v.observar(60_000, []), null);
  assert.equal(v.observar(61_000, ['Otter Notetaker']), 'solo');
});

test('vigía: antes de que llegue alguien espera esperaLlegadaMs (el robot entra antes de la hora)', () => {
  const v = new Vigia(VIGIA);
  assert.equal(v.observar(0, []), null);
  assert.equal(v.observar(5 * 60_000, []), null);
  assert.equal(v.observar(29 * 60_000, ['Otter Notetaker']), null);
  assert.equal(v.observar(30 * 60_000, []), 'nadie_llego', 'r2: nadie llegó (no se grabó nada)');
  const r = new Vigia({ ...VIGIA, esperaLlegadaMs: 5 * 60_000 }); // robot de reemplazo
  assert.equal(r.observar(0, []), null);
  assert.equal(r.observar(5 * 60_000, []), 'nadie_llego');
  const w = new Vigia(VIGIA);
  assert.equal(w.observar(0, []), null);
  assert.equal(w.observar(10 * 60_000, ['Valentina Orellana']), null);
  assert.equal(w.observar(11 * 60_000, []), null);
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
  const l = new LineaHablantes('Notas Ps. Valentina Orellana');
  l.registrar(100, 'Valentina Orellana', true);
  l.registrar(150, 'Valentina Orellana', true); // repetido
  l.registrar(200, 'Notas Ps. Valentina Orellana', true); // el propio bot
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

test('segmentos (auditoría): un segmento que la página nunca cerró se sube igual al terminar', async () => {
  const eventos: EventoBot[] = [];
  const sitio = {
    pedirUrl: async (seq: number) => `https://r2.example/a/${seq}`,
    enviar: async (e: EventoBot) => { eventos.push(e); return { ok: true }; },
  };
  const f = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
  const segs = new Segmentos({ sitio, fetch: f, esperaBaseMs: 1 });
  segs.agregarTrozo(0, Buffer.from('abc'));
  await segs.cerrar(0, 0, 900_000);           // cerrado normal
  segs.agregarTrozo(1, Buffer.from('defg'));  // la página se cayó: nunca llega __voSegFin
  assert.deepEqual(segs.cerrarHuerfanos((seq) => ({ offsetMs: seq * 897_000, duracionMs: 120_000 })), [1]);
  assert.deepEqual(await segs.vaciar(), []);
  assert.deepEqual(eventos.map((e) => e.tipo === 'segmento_subido' ? [e.seq, e.bytes, e.offset_ms] : null), [[0, 3, 0], [1, 4, 897_000]]);
  assert.deepEqual(segs.cerrarHuerfanos(() => ({ offsetMs: 0, duracionMs: 0 })), []); // nada pendiente
});

test('reCAPTCHA (auditoría): la casilla "No soy un robot" bloquea; el anchor invisible no', () => {
  const base = 'https://www.google.com/recaptcha/enterprise/anchor?ar=1&k=x&co=y&hl=en&v=z';
  assert.equal(esBloqueoRecaptcha({ src: `${base}&size=normal&cb=1`, w: 304, h: 78, oculto: false }), true);
  assert.equal(esBloqueoRecaptcha({ src: `${base}&size=compact`, w: 164, h: 144, oculto: false }), true);
  assert.equal(esBloqueoRecaptcha({ src: 'https://www.google.com/recaptcha/api2/anchor?k=x&size=normal', w: 304, h: 78, oculto: false }), true);
  assert.equal(esBloqueoRecaptcha({ src: `${base}&size=invisible`, w: 256, h: 60, oculto: false }), false);
  assert.equal(esBloqueoRecaptcha({ src: `${base}&size=normal`, w: 304, h: 78, oculto: true }), false);
  assert.equal(esBloqueoRecaptcha({ src: `${base}&size=normal`, w: 0, h: 0, oculto: false }), false);
  const bframe = 'https://www.google.com/recaptcha/enterprise/bframe?hl=en&v=z&k=x';
  assert.equal(esBloqueoRecaptcha({ src: bframe, w: 400, h: 580, oculto: false }), true);
  assert.equal(esBloqueoRecaptcha({ src: bframe, w: 400, h: 580, oculto: true }), false);
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

test('Chromium: sin --no-sandbox salvo que se pida explícitamente (B6)', () => {
  assert.ok(!argumentosChromium().includes('--no-sandbox'));
  assert.ok(!argumentosChromium(1280, 720, { sandbox: true }).includes('--no-sandbox'));
  assert.ok(argumentosChromium(1280, 720, { sandbox: false }).includes('--no-sandbox'));
});

test('sanearError quita el enlace y el código de Meet (B8)', () => {
  const m = sanearError('page.goto: net::ERR_ABORTED at https://meet.google.com/abc-defg-hij?hl=en\nllamada abc-defg-hij');
  assert.ok(!m.includes('meet.google.com'));
  assert.ok(!m.includes('abc-defg-hij'));
  assert.ok(!/[\n\r]/.test(m));
  assert.ok(m.includes('[url]'));
  assert.equal(sanearError('x'.repeat(500)).length, 300);
});

// ─── Modo 'cuenta' (robot con cuenta de Google propia) ────────────────────────

const CORREO = 'notas.valentinaorellana@gmail.com';
const SESION = {
  cookies: [
    { name: 'SID', value: 'v', domain: '.google.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const },
    { name: 'otra', value: 'v', domain: '.evil.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' as const },
  ],
  origins: [{ origin: 'https://meet.google.com', localStorage: [] }, { origin: 'https://evil.com', localStorage: [] }],
};

test('config: modo invitado por defecto; cuenta exige correo válido', () => {
  const c = leerConfig(ENV_OK);
  assert.equal(c.modo, 'invitado');
  assert.equal(c.cuentaEmail, null);
  const k = leerConfig({ ...ENV_OK, BOT_MODO: 'cuenta', BOT_CUENTA_EMAIL: ' Notas.ValentinaOrellana@gmail.com ' });
  assert.equal(k.modo, 'cuenta');
  assert.equal(k.cuentaEmail, CORREO);
  assert.throws(() => leerConfig({ ...ENV_OK, BOT_MODO: 'cuenta' }), /BOT_CUENTA_EMAIL/);
  assert.equal(leerConfig({ ...ENV_OK, BOT_CUENTA_EMAIL: CORREO }).cuentaEmail, null); // sin BOT_MODO=cuenta no se usa
});

test('sesión: valida, filtra a google.com y reconoce el correo en la antesala', () => {
  assert.ok(estadoSesionValido(SESION));
  assert.ok(!estadoSesionValido({ cookies: [SESION.cookies[1]], origins: [] }));
  assert.ok(!estadoSesionValido(null));
  const g = soloGoogle(SESION);
  assert.deepEqual(g.cookies.map((c) => c.name), ['SID']);
  assert.deepEqual(g.origins.map((o) => o.origin), ['https://meet.google.com']);
  assert.ok(muestraCorreo(`Ready to join?\n${CORREO.toUpperCase()}\nSwitch account`, CORREO));
  assert.ok(!muestraCorreo('Your name', CORREO));
});

test('sitio: pedirSesion solo acepta la sesión de la cuenta esperada', async () => {
  const respuesta = (cuerpo: unknown) => (async () => new Response(JSON.stringify(cuerpo), { status: 200 })) as unknown as typeof fetch;
  const pedir = (cuerpo: unknown) => new Sitio({ eventoUrl: 'https://x.cl/e', token: 'T'.repeat(43), fetch: respuesta(cuerpo), esperaBaseMs: 1 }).pedirSesion(CORREO);
  assert.deepEqual(await pedir({ ok: true, correo: CORREO, sesion: SESION }), SESION);
  assert.equal(await pedir({ ok: true, correo: 'otra@gmail.com', sesion: SESION }), null);
  assert.equal(await pedir({ ok: true, sesion: null, motivo: 'sin_sesion' }), null);
  assert.equal(await pedir({ ok: true, correo: CORREO, sesion: { cookies: [], origins: [] } }), null);
});

test('nombre del robot: "Notas Ps. Valentina Orellana" y no cuenta como humano', () => {
  assert.equal(NOMBRE_ROBOT, 'Notas Ps. Valentina Orellana');
  assert.ok(esNombreDeBot('Notas Ps. Valentina Orellana', 'otro nombre'));
  assert.ok(!esVale('Notas Ps. Valentina Orellana', ['Valentina Orellana']));
});

test('atraso de Vale: ningún robot empieza a grabar sin Vale; el respaldo por voz solo si la lista no se puede leer', () => {
  const base = { hayVale: false, ilegible: false, vozSeguida: 0, reemplazo: false };
  assert.equal(decidirInicio({ ...base, hayVale: true }), 'grabar');
  assert.equal(decidirInicio(base), 'esperar', 'el paciente llegó antes y espera solo: no se le graba');
  assert.equal(decidirInicio({ ...base, vozSeguida: 5 }), 'esperar', 'hay voz pero la lista se lee (y Vale no está): no');
  assert.equal(decidirInicio({ ...base, ilegible: true, vozSeguida: 1 }), 'esperar');
  assert.equal(decidirInicio({ ...base, ilegible: true, vozSeguida: 2 }), 'grabar_por_voz');
  assert.equal(decidirInicio({ ...base, ilegible: true, vozSeguida: 2, reemplazo: true }), 'esperar', 'un reemplazo nunca sin ver a Vale');
  assert.equal(decidirInicio({ ...base, hayVale: true, reemplazo: true }), 'grabar');
  // ¿La lista se puede leer?
  assert.equal(listaIlegible(null), true, 'la página no respondió');
  assert.equal(listaIlegible({ estructura: false, otros: 0, nombres: [] }), true, 'sin tiles de Meet');
  assert.equal(listaIlegible({ estructura: true, otros: 1, nombres: [] }), true, 'tiles sin nombres: cambió el DOM');
  assert.equal(listaIlegible({ estructura: true, otros: 0, nombres: [] }), false, 'el robot solo en la llamada');
  assert.equal(listaIlegible({ estructura: true, otros: 1, nombres: ['Diego Soto'] }), false);
});

test('atraso de Vale: antes de grabar el robot espera a Vale mientras haya alguien; sin nadie 30 min → nadie_llego', () => {
  const v = new Vigia(VIGIA);
  assert.equal(v.observar(0, ['Diego Soto']), null, 'el paciente llegó a la hora');
  assert.equal(v.observar(25 * 60_000, ['Diego Soto']), null, 'Vale 25 min atrasada: sigue esperando');
  assert.equal(v.observar(26 * 60_000, []), null, 'el paciente se fue a buscar el enlace');
  assert.equal(v.observar(50 * 60_000, []), null);
  assert.equal(v.observar(56 * 60_000, []), 'nadie_llego', '30 min sin nadie: sale (el próximo clic de Vale lo trae)');
  // Vale llega a los 28 min: empieza a grabar y desde ahí rigen solo / vale_salio.
  const w = new Vigia(VIGIA);
  assert.equal(w.observar(0, ['Diego Soto']), null);
  assert.equal(w.hayVale(['Diego Soto', 'Valentina Orellana']), true);
  w.observar(28 * 60_000, ['Diego Soto', 'Valentina Orellana']);
  w.empezoGrabacion();
  assert.equal(w.observar(29 * 60_000, []), null);
  assert.equal(w.observar(30 * 60_000, []), 'solo');
});
