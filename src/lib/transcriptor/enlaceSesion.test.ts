// Enlace propio de la sesión online (/sesion/<código>, pedido de Vale 18 oct 2026). Sin red.
// Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  bloqueEntrarSesion, codigoSesion, destinoMeet, enlacePacienteSesion, enlaceParaSesion, enlaceValeSesion, esVisitaAutomatica,
  ETIQUETA_ENLACE_VALE, filaEnlaceVale, lineaEntrarWhatsApp, meetDeNotas, quitarLineaEnlacePropio, reservaDeEventId,
  reservaDesdeCodigo, traeEnlacePropio, urlSesion,
} from '../enlaceSesion';
import { readFileSync } from 'node:fs';
import { abrirEnlaceSesion, ACCION_ENLACE, cercaDeLaHora, inicioChileMs, llamarAsistentePanel, MAX_DESPACHOS_ENLACE, MAX_INVALIDOS_IP, valeConSesionPanel, type DepsEnlace } from './enlaceSesionRuta';
import { crearPipeline, enVentanaEnlace, previaReintentablePorEnlace, VENTANA_ENLACE_ANTES_MS, VENTANA_ENLACE_DESPUES_MS } from './pipeline';
import { crearBot } from './bot';
import { evaluarEnBase } from './consentimiento';
import { NOTA_NADIE_LLEGO } from './botReconexion';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';
import { stepsItems } from '../stepsContent';

const S = 'secreto-de-prueba-del-panel-0123456789';
const MEET = 'https://meet.google.com/abc-defg-hij';

// ─── Código ──────────────────────────────────────────────────────────────────

test('código: ≥128 bits, determinista, ida y vuelta, distinto por reserva y por secreto', () => {
  const id = randomUUID();
  const c = codigoSesion(id, S)!;
  assert.match(c, /^[A-Za-z0-9_-]{43}$/); // 32 bytes: 16 cifrados + 16 de firma (128 bits)
  assert.equal(codigoSesion(id, S), c);
  assert.equal(reservaDesdeCodigo(c, S), id);
  assert.ok(!c.includes(id.replace(/-/g, '').slice(0, 8)), 'el id de la reserva no se ve en la URL');
  assert.notEqual(codigoSesion(randomUUID(), S), c);
  assert.equal(reservaDesdeCodigo(c, 'otro-secreto-distinto-0123456789abcd'), null);
  assert.notEqual(codigoSesion(id, 'otro-secreto-distinto-0123456789abcd'), c);
});

test('código: inválidos, alterados, no canónicos y sin secreto → null', () => {
  const id = randomUUID();
  const c = codigoSesion(id, S)!;
  for (const malo of [undefined, null, 42, '', 'abc', c.slice(0, 42), `${c}A`, `${c.slice(0, 42)}!`, '../../admin', id]) {
    assert.equal(reservaDesdeCodigo(malo, S), null, String(malo));
  }
  // Cambiar un solo carácter (firma o bloque cifrado) invalida el código.
  for (const i of [0, 10, 21, 30, 41]) {
    const otro = c.slice(0, i) + (c[i] === 'A' ? 'B' : 'A') + c.slice(i + 1);
    assert.equal(reservaDesdeCodigo(otro, S), null, `posición ${i}`);
  }
  assert.equal(codigoSesion(id, ''), null);
  assert.equal(reservaDesdeCodigo(c, ''), null);
  assert.equal(codigoSesion('no-es-uuid', S), null);
});

test('URL propia y respaldo al Meet cuando no hay secreto', () => {
  const id = randomUUID();
  assert.equal(urlSesion(id, S), `https://www.valentinaorellana.cl/sesion/${codigoSesion(id, S)}`);
  assert.equal(urlSesion(null, S), null);
  assert.equal(enlaceParaSesion(id, MEET, S), urlSesion(id, S));
  assert.equal(enlaceParaSesion(id, `${MEET}?authuser=0`, ''), MEET); // sin secreto: el Meet (normalizado)
  assert.equal(enlaceParaSesion(id, 'https://evil.example/x', ''), null);
  assert.equal(reservaDeEventId(id.replace(/-/g, '')), id);
  assert.equal(reservaDeEventId('evencuadrado1'), null);
});

test('destino: solo https://meet.google.com/<sala>, nada de redirección abierta', () => {
  assert.equal(destinoMeet(MEET), MEET);
  assert.equal(destinoMeet('https://MEET.google.com/ABC-DEFG-HIJ?x=1#y'), MEET);
  assert.equal(destinoMeet(MEET, 'vinculosquesostienen@gmail.com'), `${MEET}?authuser=vinculosquesostienen%40gmail.com`);
  assert.equal(destinoMeet(MEET, 'x"><script>'), MEET); // authuser raro: se ignora
  for (const malo of ['http://meet.google.com/abc-defg-hij', 'https://meet.google.com.evil.com/abc-defg-hij', 'https://evil.com/?u=https://meet.google.com/abc-defg-hij',
    'javascript:alert(1)', '//meet.google.com/abc-defg-hij', 'https://meet.google.com/', 'https://meet.google.com/lookup/abc', null, undefined]) {
    assert.equal(destinoMeet(malo as string), null, String(malo));
  }
  assert.equal(meetDeNotas(`Folio 12\nMeet: https://meet.google.com/aaa-bbbb-ccc\nMeet: ${MEET}`), MEET);
  assert.equal(meetDeNotas('nota del paciente: meet https://meet.google.com/zzz-zzzz-zzz'), null); // solo la marca del sistema
});

test('vistas previas y robots no mandan el robot de notas', () => {
  for (const ua of ['WhatsApp/2.23.20.0', 'facebookexternalhit/1.1', 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'TelegramBot (like TwitterBot)', 'Slackbot-LinkExpanding 1.0', 'curl/8.4.0', '', null]) {
    assert.equal(esVisitaAutomatica(ua), true, String(ua));
  }
  for (const ua of ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36']) {
    assert.equal(esVisitaAutomatica(ua), false, ua);
  }
});

// ─── Ventana ────────────────────────────────────────────────────────────────

test('ventana: desde 30 min antes del inicio hasta 60 min después del término agendado (Vale atrasada)', () => {
  const inicio = '2026-10-20T13:00:00.000Z', fin = '2026-10-20T13:50:00.000Z';
  const en = (iso: string) => enVentanaEnlace(inicio, fin, new Date(iso));
  assert.equal(VENTANA_ENLACE_ANTES_MS, 30 * 60_000);
  assert.equal(VENTANA_ENLACE_DESPUES_MS, 60 * 60_000);
  assert.equal(en('2026-10-20T12:29:59.000Z'), false);
  assert.equal(en('2026-10-20T12:30:00.000Z'), true);
  assert.equal(en('2026-10-20T13:20:00.000Z'), true);
  assert.equal(en('2026-10-20T13:50:00.000Z'), true);
  assert.equal(en('2026-10-20T14:49:59.000Z'), true);
  assert.equal(en('2026-10-20T14:50:00.000Z'), false);
  assert.equal(enVentanaEnlace('x', fin, new Date()), false);
  // Hora de Chile → UTC (octubre: UTC−3) y filtro previo barato.
  assert.equal(new Date(inicioChileMs('2026-10-20', '10:00:00')).toISOString(), inicio);
  assert.equal(cercaDeLaHora({ session_date: '2026-10-20', session_time: '10:00' }, new Date('2026-10-20T12:00:00Z')), true);
  assert.equal(cercaDeLaHora({ session_date: '2026-10-22', session_time: '10:00' }, new Date('2026-10-20T12:00:00Z')), false);
  assert.equal(cercaDeLaHora({ session_date: '2099-12-31', session_time: null }, new Date()), false);
});

test('qué intento anterior se repite al abrir el enlace', () => {
  assert.equal(previaReintentablePorEnlace({ estado: 'sin_audio', estado_antes_error: null, nota_sistema: NOTA_NADIE_LLEGO }), 'liberar');
  assert.equal(previaReintentablePorEnlace({ estado: 'error', estado_antes_error: 'bot_lanzando' }), 'reintentar');
  assert.equal(previaReintentablePorEnlace({ estado: 'sin_consentimiento', estado_antes_error: null }), 'sin_consentimiento');
  // Salidas antes de grabar sin decisión de nadie (Vale atrasada): solo y hora_fin también se repiten.
  for (const m of ['error', 'solo', 'hora_fin']) {
    assert.equal(previaReintentablePorEnlace({ estado: 'error', estado_antes_error: 'bot_lanzando', ultimo_error: `El asistente de notas terminó antes de grabar (${m})` }), 'reintentar', m);
  }
  // Nunca: con audio, decisión de Vale (no admitido, retirado, cancelada) o error con audio de por medio.
  for (const p of [
    { estado: 'sin_audio', estado_antes_error: null, nota_sistema: 'El asistente de notas fue retirado de la reunión' },
    { estado: 'bot_no_admitido', estado_antes_error: null }, { estado: 'cancelada', estado_antes_error: null },
    { estado: 'subida', estado_antes_error: null }, { estado: 'lista', estado_antes_error: null },
    { estado: 'error', estado_antes_error: 'transcribiendo' }, { estado: 'grabando', estado_antes_error: null },
  ] as const) assert.equal(previaReintentablePorEnlace(p as never), null, p.estado);
});

// ─── Ruta /sesion/<código> ────────────────────────────────────────────────────

function ruta(opc: { ahora?: string; reserva?: Record<string, unknown> | null; meetCal?: string | null; despacho?: string | Error; vale?: boolean } = {}) {
  const db = new SupabaseMemoria();
  const ahora = new Date(opc.ahora ?? '2026-10-20T12:50:00Z'); // 09:50 en Chile, sesión 10:00
  db.ahora = () => ahora;
  const id = randomUUID();
  if (opc.reserva !== null) {
    db.tabla('bookings').push({
      id, session_type: 'online', status: 'confirmed', created_by_admin: false, google_event_id: id.replace(/-/g, ''),
      session_date: '2026-10-20', session_time: '10:00:00', notes: `Meet: ${MEET}`, ...(opc.reserva ?? {}),
    });
  }
  const pendientes: Promise<unknown>[] = [];
  const despachos: unknown[] = [];
  const deps: DepsEnlace = {
    db: db.cliente, ahora: () => ahora, secreto: S,
    enSegundoPlano: (t) => { pendientes.push(t()); },
    despachar: async (ref) => { despachos.push(ref); if (opc.despacho instanceof Error) throw opc.despacho; return opc.despacho ?? 'lanzado'; },
    meetDeCalendario: async () => opc.meetCal ?? null,
  };
  const pedir = async (codigo: unknown, o: { ua?: string; ip?: string; metodo?: string; authuser?: string; vale?: boolean; panel?: boolean } = {}) => {
    const request = new Request('https://www.valentinaorellana.cl/sesion/x', {
      method: o.metodo ?? 'GET',
      headers: { 'user-agent': o.ua ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1', 'x-forwarded-for': o.ip ?? '200.1.1.1' },
    });
    // Por defecto lo abre Vale (con su sesión del panel); vale: false = el paciente.
    const r = await abrirEnlaceSesion({ codigo, metodo: o.metodo ?? 'GET', request, authuser: o.authuser ?? null, esVale: async () => o.vale ?? opc.vale ?? true, desdePanel: o.panel }, deps);
    await Promise.all(pendientes.splice(0));
    return r;
  };
  const bitacora = () => db.tabla('transcriptor_auditoria').filter((f) => f.accion === ACCION_ENLACE);
  return { db, id, codigo: codigoSesion(id, S)!, pedir, despachos, bitacora, deps };
}

test('Vale, 18 oct: el robot entra solo cuando entra Vale — el paciente con el enlace solo es redirigido', async () => {
  const e = ruta();
  assert.deepEqual(await e.pedir(e.codigo, { vale: false }), { tipo: 'redirigir', url: MEET });
  assert.equal(e.despachos.length, 0, 'el paciente no manda el robot');
  assert.equal(e.bitacora().at(-1)!.detalle.despacho, 'no_vale');
  assert.deepEqual(await e.pedir(e.codigo), { tipo: 'redirigir', url: MEET });
  assert.equal(e.despachos.length, 1, 'Vale (sesión del panel) sí');
  // Botón del panel (?panel=1): ya pidió el robot por POST; el enlace no lo pide de nuevo.
  await e.pedir(e.codigo, { panel: true });
  assert.equal(e.despachos.length, 1);
  assert.equal(e.bitacora().at(-1)!.detalle.despacho, 'panel');
  // Sin forma de saber quién abre (sin esVale): no despacha.
  const sin = ruta();
  const request = new Request('https://www.valentinaorellana.cl/sesion/x', { headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari/604.1', 'x-forwarded-for': '200.1.1.1' } });
  await abrirEnlaceSesion({ codigo: sin.codigo, metodo: 'GET', request }, { ...sin.deps, enSegundoPlano: (t) => { void t(); } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sin.despachos.length, 0);
  // Cookie del panel: token inválido o ausente → no es Vale (sin tocar la base).
  assert.equal(await valeConSesionPanel(undefined), false);
  assert.equal(await valeConSesionPanel('v1.123.firma-falsa'), false);
});

test('botones del panel (POST llamar-asistente): mismas reglas y cupo que el enlace, con texto para Vale', async () => {
  const e = ruta();
  const request = new Request('https://www.valentinaorellana.cl/api/admin/transcriptor/llamar-asistente', { method: 'POST' });
  const r = await llamarAsistentePanel(e.id, { request }, e.deps);
  assert.deepEqual([r.status, r.despacho], [200, 'lanzado']);
  assert.match(r.texto, /va en camino/);
  assert.equal(e.despachos.length, 1);
  assert.equal(e.bitacora().at(-1)!.detalle.via, 'panel');
  assert.equal((await llamarAsistentePanel(randomUUID(), { request }, e.deps)).status, 404);
  const fuera = ruta({ ahora: '2026-10-22T12:50:00Z' });
  assert.equal((await llamarAsistentePanel(fuera.id, { request }, fuera.deps)).despacho, 'fuera_de_ventana');
  assert.equal(fuera.despachos.length, 0);
  const presencial = ruta({ reserva: { session_type: 'presencial' } });
  assert.equal((await llamarAsistentePanel(presencial.id, { request }, presencial.deps)).despacho, 'sin_meet');
  for (let i = 0; i < MAX_DESPACHOS_ENLACE + 2; i++) await llamarAsistentePanel(e.id, { request }, e.deps);
  assert.equal(e.despachos.length, MAX_DESPACHOS_ENLACE);
});

test('código válido en la ventana: redirige YA al Meet y despacha el robot una vez (en segundo plano)', async () => {
  const e = ruta();
  const r = await e.pedir(e.codigo);
  assert.deepEqual(r, { tipo: 'redirigir', url: MEET });
  assert.deepEqual(e.despachos, [{ bookingId: e.id, googleEventId: e.id.replace(/-/g, '') }]);
  const b = e.bitacora();
  assert.equal(b.length, 2); // cupo reservado antes de despachar + resultado
  assert.ok(b.every((f) => f.actor === 'sistema' && f.resultado === 'ok'));
  assert.deepEqual(b[0].detalle, { reserva: e.id, intento: 'si' });
  assert.deepEqual(b[1].detalle, { reserva: e.id, con_meet: true, despacho: 'lanzado' });
  // Nada del Meet ni del código en la bitácora.
  assert.ok(!JSON.stringify(b).includes('meet.google.com') && !JSON.stringify(b).includes(e.codigo));
  // El panel de Vale: misma redirección, con la cuenta del negocio.
  assert.deepEqual(await e.pedir(e.codigo, { authuser: 'vinculosquesostienen@gmail.com' }), { tipo: 'redirigir', url: `${MEET}?authuser=vinculosquesostienen%40gmail.com` });
});

test('siempre redirige: fuera de hora, vista previa, reserva vencida, HEAD, despacho con error', async () => {
  for (const [nombre, e, o, motivo] of [
    ['fuera de hora', ruta({ ahora: '2026-10-22T12:50:00Z' }), {}, 'fuera_de_ventana'],
    ['vista previa', ruta(), { ua: 'WhatsApp/2.23.20.0' }, 'vista_previa'],
    ['vencida', ruta({ reserva: { status: 'expired' } }), {}, 'reserva_no_vigente'],
    ['HEAD', ruta(), { metodo: 'HEAD' }, 'no_get'],
  ] as const) {
    assert.deepEqual(await e.pedir(e.codigo, o), { tipo: 'redirigir', url: MEET }, nombre);
    assert.equal(e.despachos.length, 0, nombre);
    assert.equal(e.bitacora()[0].detalle.despacho, motivo, nombre);
  }
  const conError = ruta({ despacho: new Error('Google Calendar no está conectado') });
  assert.deepEqual(await conError.pedir(conError.codigo), { tipo: 'redirigir', url: MEET });
  assert.equal(conError.bitacora().at(-1)!.resultado, 'error');
});

test('sin Meet en las notas: lo busca en Calendar; si no hay, página de espera (sin robot)', async () => {
  const e = ruta({ reserva: { notes: 'Folio 33' }, meetCal: 'https://meet.google.com/xyz-abcd-efg' });
  assert.deepEqual(await e.pedir(e.codigo), { tipo: 'redirigir', url: 'https://meet.google.com/xyz-abcd-efg' });
  const sin = ruta({ reserva: { notes: null } });
  assert.deepEqual(await sin.pedir(sin.codigo), { tipo: 'sin_meet' });
  assert.equal(sin.despachos.length, 0);
});

test('código inválido o reserva borrada: 404 sin datos; límite por IP en la bitácora', async () => {
  const e = ruta();
  assert.deepEqual(await e.pedir('codigo-falso'), { tipo: 'no_encontrado' });
  const otro = ruta({ reserva: null });
  assert.deepEqual(await otro.pedir(otro.codigo), { tipo: 'no_encontrado' });
  assert.equal(e.bitacora()[0].resultado, 'denegado');
  assert.equal(e.bitacora()[0].ip, '200.1.1.1');
  for (let i = 0; i < MAX_INVALIDOS_IP + 10; i++) assert.equal((await e.pedir(`x${i}`)).tipo, 'no_encontrado');
  assert.equal(e.bitacora().length, MAX_INVALIDOS_IP); // pasado el límite ya no se escribe más
  // Tope global: muchas IP distintas tampoco llenan la bitácora.
  const g = ruta();
  g.db.tabla('transcriptor_auditoria').push(...Array.from({ length: 200 }, (_, i) => ({ id: i + 1, at: '2026-10-20T12:45:00Z', accion: ACCION_ENLACE, resultado: 'denegado', ip: `10.0.${i >> 8}.${i & 255}` })));
  await g.pedir('codigo-falso', { ip: '201.2.2.2' });
  assert.equal(g.bitacora().length, 200);
  // Un código bueno desde esa misma IP igual entra (nunca se bloquea la sesión).
  assert.equal((await e.pedir(e.codigo)).tipo, 'redirigir');
  assert.equal(e.despachos.length, 1);
});

test('límite de despachos por enlace: después solo redirige', async () => {
  const e = ruta({ despacho: 'activo' });
  for (let i = 0; i < MAX_DESPACHOS_ENLACE + 3; i++) assert.equal((await e.pedir(e.codigo)).tipo, 'redirigir');
  assert.equal(e.despachos.length, MAX_DESPACHOS_ENLACE);
  assert.equal(e.bitacora().at(-1)!.detalle.despacho, 'limite');
});

// ─── Despacho real (pipeline + bot con Calendar y Fly falsos) ─────────────────

function despacho() {
  const db = new SupabaseMemoria();
  let t = Date.parse('2026-10-20T12:40:00Z'); // 20 min antes de la sesión de las 13:00 UTC
  db.ahora = () => new Date(t);
  const ahora = () => new Date(t);
  const eventos: Record<string, unknown>[] = [];
  const maquinas: string[] = [];
  const fetchFalso = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith('https://www.googleapis.com/calendar/v3/')) return new Response(JSON.stringify({ items: eventos }), { status: 200 });
    if (u.endsWith('/apps/vo-bot/machines') && init?.method === 'POST') { const id = `maq${maquinas.length + 1}abc`; maquinas.push(id); return new Response(JSON.stringify({ id }), { status: 200 }); }
    return new Response('no simulado', { status: 500 });
  }) as typeof fetch;
  const bot = crearBot({
    db: db.cliente, fetch: fetchFalso, calendario: async () => ({ token: 'tok', calendarId: 'primary' }),
    env: { FLY_API_TOKEN: 'fly', FLY_APP_BOT: 'vo-bot', FLY_IMAGEN: 'registry.fly.io/vo-bot:v1', BOT_TOKEN_SECRET: 'secreto-del-bot-de-prueba-0123456789abcdef', PUBLIC_SITE_URL: 'https://www.valentinaorellana.cl' },
  });
  const pipeline = crearPipeline({
    db: db.cliente, bot, almacenamiento: {} as never, aai: {} as never,
    puedeGrabar: (p, tipo) => evaluarEnBase(p, tipo, db.cliente),
    alertas: { registrarAlerta: async () => {}, resolverAlertasDe: async () => {} },
  });
  db.tabla('settings').push({ key: 'transcriptor_activo', value: 'true' }, { key: 'transcriptor_bot_activo', value: 'true' });
  const pid = randomUUID();
  db.tabla('patients').push({ id: pid, name: 'Diego Soto', email: 'diego@ejemplo.cl', active: true, birthdate: '1990-05-05' });
  db.tabla('consents').push({ id: randomUUID(), patient_id: pid, version: '2026-11-v3', signed_at: '2026-10-10T12:00:00Z', signer_name: 'Diego Soto', signer_rut: '15.555.555-5', signer_email: null, accept_recording: true, revoked_at: null });
  const bookingId = randomUUID();
  const eventoId = bookingId.replace(/-/g, '');
  db.tabla('bookings').push({ id: bookingId, google_event_id: eventoId, session_type: 'online', status: 'confirmed', patient_email: 'diego@ejemplo.cl', notes: `Meet: ${MEET}` });
  eventos.push({ id: eventoId, status: 'confirmed', start: { dateTime: '2026-10-20T13:00:00.000Z' }, end: { dateTime: '2026-10-20T13:50:00.000Z' }, hangoutLink: MEET, attendees: [{ email: 'diego@ejemplo.cl' }] });
  const ref = { bookingId, googleEventId: eventoId };
  const grabs = () => db.tabla('grabaciones');
  return { db, pipeline, ref, maquinas, grabs, avanzar: (min: number) => { t += min * 60_000; }, ahora, pid };
}

test('despacho por enlace: lanza el robot ya (20 min antes) y no duplica con clics ni con el cron', async () => {
  const e = despacho();
  assert.equal(await e.pipeline.despacharPorEnlace(e.ref, e.ahora()), 'lanzado');
  assert.equal(e.maquinas.length, 1);
  assert.equal(e.grabs().length, 1);
  assert.deepEqual([e.grabs()[0].estado, e.grabs()[0].meet_url, e.grabs()[0].patient_id, e.grabs()[0].google_event_id], ['bot_lanzando', MEET, e.pid, e.ref.googleEventId]);
  // Más clics y el cron del minuto: el robot ya va, nada nuevo.
  assert.equal(await e.pipeline.despacharPorEnlace(e.ref, e.ahora()), 'activo');
  e.avanzar(16); // 4 min antes: el cron también lo vería
  assert.equal(await e.pipeline.despacharBots(e.ahora()), 0);
  assert.equal(e.maquinas.length, 1);
  assert.equal(e.grabs().length, 1);
});

test('despacho por enlace: fuera de ventana no lanza; apagado no lanza', async () => {
  const e = despacho();
  e.avanzar(-31); // 51 min antes
  assert.equal(await e.pipeline.despacharPorEnlace(e.ref, e.ahora()), 'sin_sesion'); // aún no está en el rango de Calendar
  e.avanzar(162); // 14:51 UTC: terminó hace 61 min (pasó la hora de margen por atraso)
  assert.equal(await e.pipeline.despacharPorEnlace(e.ref, e.ahora()), 'fuera');
  assert.equal(e.maquinas.length, 0);
  const off = despacho();
  off.db.tabla('settings').find((s) => s.key === 'transcriptor_bot_activo')!.value = 'false';
  assert.equal(await off.pipeline.despacharPorEnlace(off.ref, off.ahora()), 'apagado');
  assert.equal(off.maquinas.length, 0);
});

test('despacho por enlace: si el robot salió porque nadie llegó, un clic lo vuelve a mandar; con audio, nunca', async () => {
  const e = despacho();
  await e.pipeline.despacharPorEnlace(e.ref, e.ahora());
  const g = e.grabs()[0];
  Object.assign(g, { estado: 'sin_audio', nota_sistema: NOTA_NADIE_LLEGO, fin_at: e.ahora().toISOString(), bot_machine_id: 'maq1abc' });
  e.avanzar(25); // 5 min después del inicio: alguien abre el enlace
  assert.equal(await e.pipeline.despacharPorEnlace(e.ref, e.ahora()), 'lanzado');
  assert.equal(e.maquinas.length, 2);
  assert.equal(e.grabs().length, 2);
  assert.match(String(g.google_event_id), /~movido-/); // la fila vieja liberó el evento (índice único)
  // Con audio (ya grabó y se cerró): no se manda otro.
  const g2 = e.grabs()[1];
  Object.assign(g2, { estado: 'subida', bot_machine_id: 'maq2abc' });
  assert.equal(await e.pipeline.despacharPorEnlace(e.ref, e.ahora()), 'existe');
  // Rechazado por Vale en la sala de espera: tampoco.
  Object.assign(g2, { estado: 'bot_no_admitido' });
  assert.equal(await e.pipeline.despacharPorEnlace(e.ref, e.ahora()), 'existe');
  assert.equal(e.maquinas.length, 2);
});

test('despacho por enlace: falla técnica antes de entrar se reintenta; si Vale lo sacó o había un tercero, no', async () => {
  for (const [motivo, esperado, maquinas] of [['error', 'lanzado', 2], ['solo', 'lanzado', 2], ['hora_fin', 'lanzado', 2], ['expulsado', 'existe', 1], ['participantes_extra', 'existe', 1], ['vale_salio', 'existe', 1]] as const) {
    const e = despacho();
    await e.pipeline.despacharPorEnlace(e.ref, e.ahora());
    const g = e.grabs()[0];
    Object.assign(g, { estado: 'error', estado_antes_error: 'bot_lanzando', bot_machine_id: null, ultimo_error: `El asistente de notas terminó antes de grabar (${motivo})` });
    e.avanzar(5);
    assert.equal(await e.pipeline.despacharPorEnlace(e.ref, e.ahora()), esperado, motivo);
    assert.equal(e.maquinas.length, maquinas, motivo);
  }
  // Fly falló al crear la máquina: se reintenta, pero con el mismo tope de robots por grabación.
  const f = despacho();
  await f.pipeline.despacharPorEnlace(f.ref, f.ahora());
  const g = f.grabs()[0];
  for (let i = 0; i < 4; i++) f.db.tabla('transcriptor_auditoria').push({ id: 900 + i, at: f.ahora().toISOString(), accion: 'bot_lanzar', grabacion_id: g.id, resultado: 'ok' });
  Object.assign(g, { estado: 'error', estado_antes_error: 'bot_lanzando', bot_machine_id: null, ultimo_error: 'Fly respondió 500' });
  assert.equal(await f.pipeline.despacharPorEnlace(f.ref, f.ahora()), 'existe');
});

test('despacho por enlace: sin consentimiento no lanza ni repite filas; al firmar, el clic sí lo manda', async () => {
  const e = despacho();
  e.db.tabla('consents').splice(0);
  assert.equal(await e.pipeline.despacharPorEnlace(e.ref, e.ahora()), 'sin_consentimiento');
  assert.equal(await e.pipeline.despacharPorEnlace(e.ref, e.ahora()), 'sin_consentimiento');
  assert.equal(e.grabs().length, 1);
  assert.equal(e.maquinas.length, 0);
  e.db.tabla('consents').push({ id: randomUUID(), patient_id: e.pid, version: '2026-11-v3', signed_at: '2026-10-20T12:41:00Z', signer_name: 'Diego Soto', signer_rut: '15.555.555-5', signer_email: null, accept_recording: true, revoked_at: null });
  assert.equal(await e.pipeline.despacharPorEnlace(e.ref, e.ahora()), 'lanzado');
  assert.equal(e.maquinas.length, 1);
});

// ─── Textos: qué enlace va en cada salida (Vale, 19 oct 2026) ────────────────
// "A la gente solamente le debe llegar el enlace de Google Meet para las sesiones online. A mí mándame
// el otro enlace para que el robot entre de inmediato." Paciente = meet.google.com; Vale = /sesion/.

const fuente = (ruta: string) => readFileSync(new URL(`../../${ruta}`, import.meta.url), 'utf8');
/** Cuerpo de una función exportada de un archivo (desde su firma hasta la siguiente función exportada). */
function cuerpo(src: string, nombre: string): string {
  const i = src.indexOf(`export async function ${nombre}(`);
  assert.ok(i >= 0, `no está ${nombre}`);
  const j = src.indexOf('\nexport ', i + 10);
  return src.slice(i, j < 0 ? undefined : j);
}

test('paciente: el botón de los correos solo lleva el Meet directo (nunca /sesion/)', () => {
  const id = randomUUID();
  assert.equal(enlacePacienteSesion({ session_type: 'pareja-online' }, `${MEET}?authuser=0`), MEET);
  assert.equal(enlacePacienteSesion({ session_type: 'presencial' }, MEET), null);
  assert.equal(enlacePacienteSesion({ session_type: 'online' }, urlSesion(id, S)), null, 'el enlace propio no sirve como Meet');
  assert.equal(enlacePacienteSesion({ session_type: 'online' }, null), null);
  const html = bloqueEntrarSesion(MEET);
  assert.ok(html.includes(`href="${MEET}"`) && html.includes('Entrar a la sesión'));
  assert.ok(!html.includes('/sesion/'));
  assert.equal(bloqueEntrarSesion(urlSesion(id, S)), '', 'con el enlace propio no se arma el botón');
  assert.equal(bloqueEntrarSesion('https://evil.example/x'), '');
  assert.equal(bloqueEntrarSesion(null), '');
});

test('paciente: el WhatsApp del link de pago lleva el Meet directo', () => {
  const id = randomUUID();
  assert.equal(lineaEntrarWhatsApp(MEET), `\n🔗 Entrar a la sesión (Google Meet): ${MEET}`);
  assert.equal(lineaEntrarWhatsApp(urlSesion(id, S)), '');
  assert.equal(lineaEntrarWhatsApp(null), '');
  const pl = fuente('pages/api/admin/payment-link.ts');
  assert.ok(!/enlaceParaSesion|urlSesion/.test(pl), 'payment-link no arma el enlace propio');
  assert.match(pl, /lineaEntrarWhatsApp\(meetPaciente\)/);
  assert.match(pl, /meetLink:\s+meetPaciente/); // vista en Cobros = el mismo Meet
});

test('paciente: los correos de confirmación, recordatorio y cambio de hora usan el Meet de la reserva', () => {
  const email = fuente('lib/email.ts');
  for (const f of ['sendConfirmationToClient', 'sendSessionUpdatedEmail', 'sendReminderEmail']) {
    const c = cuerpo(email, f);
    assert.match(c, /await meetPacienteDeReserva\(data\)/, f);
    assert.ok(!/enlaceValeSesion|urlSesion|enlaceParaSesion/.test(c), `${f} no usa el enlace propio`);
  }
  // Sin Meet todavía: el texto de siempre (está en la invitación del calendario), sin botón.
  assert.match(email, /el enlace de Google Meet está en la invitación de tu calendario/);
});

test('paciente: el evento de Google Calendar no lleva el enlace propio (ubicación ni descripción)', () => {
  const cal = fuente('lib/syncCalendar.ts');
  assert.ok(!/urlSesion|enlaceParaSesion|enlaceValeSesion|lineaEntrarCalendario/.test(cal));
  // Eventos del 18–19 oct con el enlace propio: se limpian al reagendar y al mandar el recordatorio.
  assert.match(cuerpo(cal, 'rescheduleBookingInCalendar'), /limpiarEnlacePropioDelEvento/);
  // Al pagar (se invita a la paciente) se limpia antes de invitarla.
  const pagado = cuerpo(cal, 'markBookingPaidInCalendar');
  assert.ok(pagado.indexOf('limpiarEnlacePropioDelEvento') > 0 && pagado.indexOf('limpiarEnlacePropioDelEvento') < pagado.indexOf('setCalendarEventPaidState('));
  // Cron: una vez por reserva online, fuera del bloque del correo (aunque no tenga correo o recordatorio).
  const rem = fuente('pages/api/cron/reminders.ts');
  assert.match(rem, /limpiarEnlacePropioDelEvento\(b\.id, b\.google_event_id\)/);
  assert.ok(rem.indexOf('limpiarEnlacePropioDelEvento(b.id') < rem.indexOf('doEmail: {'), 'la limpieza no depende del correo');
  const enlace = urlSesion(randomUUID(), S)!;
  assert.ok(traeEnlacePropio(enlace) && traeEnlacePropio(`Online · ${enlace}`));
  assert.ok(!traeEnlacePropio(MEET) && !traeEnlacePropio('') && !traeEnlacePropio(null));
  const desc = `Sesión con Ps. Valentina Orellana\nPaciente: Ana\nTipo: Sesión Individual Online\nEntrar a la sesión: ${enlace}`;
  assert.equal(quitarLineaEnlacePropio(desc), 'Sesión con Ps. Valentina Orellana\nPaciente: Ana\nTipo: Sesión Individual Online');
  assert.equal(quitarLineaEnlacePropio(`Entrar a la sesión: ${MEET}`), `Entrar a la sesión: ${MEET}`, 'no toca un Meet');
});

test('paciente: agenda (Copiar link de Meet y WhatsApp) manda el Meet directo; Pasos a seguir habla del Meet', () => {
  const agenda = fuente('pages/admin/agenda.astro');
  assert.match(agenda, /Te comparto el link para entrar a tu sesión por Google Meet: \$\{meet\}`/);
  assert.match(agenda, /copiarEnlace\('sp-meet-copy', false\)/);
  assert.match(agenda, /paraVale \? enlaceDe\(id, meet\) : meet/);
  const online = stepsItems('').find((p) => p.titulo === 'Si tu sesión es online')!;
  assert.match(online.texto, /enlace de Google Meet te llega en el correo de confirmación, en el recordatorio y en la invitación/);
  assert.ok(!online.texto.includes('/sesion/'));
});

test('Vale: su correo de reserva nueva o reagendada lleva su enlace propio, con etiqueta clara', () => {
  const id = randomUUID();
  const enlace = enlaceValeSesion({ session_type: 'pareja-online', sesion_id: id }, S)!;
  assert.equal(enlace, urlSesion(id, S));
  assert.ok(enlace.startsWith('https://www.valentinaorellana.cl/sesion/'));
  assert.equal(enlaceValeSesion({ session_type: 'online', booking_id: id }, S), enlace);
  assert.equal(enlaceValeSesion({ session_type: 'presencial', sesion_id: id }, S), null);
  assert.equal(enlaceValeSesion({ session_type: 'online' }, S), null);
  assert.equal(ETIQUETA_ENLACE_VALE, 'Tu enlace para entrar (llama al asistente de notas)');
  const fila = filaEnlaceVale(enlace);
  assert.ok(fila.includes(ETIQUETA_ENLACE_VALE) && fila.includes(`href="${enlace}"`));
  assert.equal(filaEnlaceVale(MEET), '', 'la fila de Vale es solo para su enlace propio');
  assert.equal(filaEnlaceVale(null), '');
  const email = fuente('lib/email.ts');
  for (const f of ['sendNotificationToAdmin', 'sendRescheduleAdminAlert']) {
    assert.match(cuerpo(email, f), /filaEnlaceVale\(enlaceValeSesion\(data\)\)|filaEnlaceVale\(enlaceVale\)/, f);
  }
  assert.match(fuente('pages/api/reschedule.ts'), /booking_id:\s+booking\.id/);
});

test('Vale: panel (Ingresar, Copiar mi enlace, calendario, sala online) usa el enlace propio o llama al asistente', () => {
  const agenda = fuente('pages/admin/agenda.astro');
  assert.match(agenda, /const link = enlaceDe\(id, meet\);/); // Ingresar a Google Meet
  assert.match(agenda, /void llamarAsistente\(id\)/);
  assert.match(agenda, /copiarEnlace\('sp-meet-copy-vale', true\)/);
  assert.match(fuente('pages/admin/calendario.astro'), /urlSesion\(reservaDeEventId\(ev\.id\)\)\}\?panel=1/);
  assert.match(fuente('pages/admin/sala-online.astro'), /\/api\/admin\/transcriptor\/llamar-asistente/);
  assert.match(fuente('pages/api/admin/generate-meet.ts'), /enlace: meetLink \? enlaceParaSesion\(id, meetLink\) : null/);
});

test('orden de envíos: el evento de Calendar (crea el Meet) va antes de la confirmación', () => {
  const t = fuente('lib/tareasEnvio.ts');
  assert.match(t, /ORDEN: TareaPago\[\] = \['calendario', 'confirmacion', 'aviso_admin'/);
  assert.match(t, /esNueva \? \['calendario', 'confirmacion', 'aviso_admin', 'boleta'\]/); // camino directo de flow/confirm
  const cm = fuente('pages/api/bookings/confirm-manual.ts');
  assert.ok(cm.indexOf('syncBookingToCalendar(') < cm.indexOf('sendConfirmationToClient(emailData)'));
});
