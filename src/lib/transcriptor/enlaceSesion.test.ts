// Enlace propio de la sesión online (/sesion/<código>, pedido de Vale 18 oct 2026). Sin red.
// Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  bloqueEntrarSesion, codigoSesion, destinoMeet, enlaceEntradaSesion, enlaceParaSesion, esVisitaAutomatica,
  lineaEntrarCalendario, lineaEntrarWhatsApp, meetDeNotas, reservaDeEventId, reservaDesdeCodigo, urlSesion,
} from '../enlaceSesion';
import { abrirEnlaceSesion, ACCION_ENLACE, cercaDeLaHora, inicioChileMs, MAX_DESPACHOS_ENLACE, MAX_INVALIDOS_IP, type DepsEnlace } from './enlaceSesionRuta';
import { crearPipeline, enVentanaEnlace, previaReintentablePorEnlace, VENTANA_ENLACE_ANTES_MS } from './pipeline';
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

test('ventana: desde 30 min antes del inicio hasta el término', () => {
  const inicio = '2026-10-20T13:00:00.000Z', fin = '2026-10-20T13:50:00.000Z';
  const en = (iso: string) => enVentanaEnlace(inicio, fin, new Date(iso));
  assert.equal(VENTANA_ENLACE_ANTES_MS, 30 * 60_000);
  assert.equal(en('2026-10-20T12:29:59.000Z'), false);
  assert.equal(en('2026-10-20T12:30:00.000Z'), true);
  assert.equal(en('2026-10-20T13:20:00.000Z'), true);
  assert.equal(en('2026-10-20T13:49:59.000Z'), true);
  assert.equal(en('2026-10-20T13:50:00.000Z'), false);
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
  // Nunca: con audio, decisión de Vale (no admitido, retirado, cancelada) o error con audio de por medio.
  for (const p of [
    { estado: 'sin_audio', estado_antes_error: null, nota_sistema: 'El asistente de notas fue retirado de la reunión' },
    { estado: 'bot_no_admitido', estado_antes_error: null }, { estado: 'cancelada', estado_antes_error: null },
    { estado: 'subida', estado_antes_error: null }, { estado: 'lista', estado_antes_error: null },
    { estado: 'error', estado_antes_error: 'transcribiendo' }, { estado: 'grabando', estado_antes_error: null },
  ] as const) assert.equal(previaReintentablePorEnlace(p as never), null, p.estado);
});

// ─── Ruta /sesion/<código> ────────────────────────────────────────────────────

function ruta(opc: { ahora?: string; reserva?: Record<string, unknown> | null; meetCal?: string | null; despacho?: string | Error } = {}) {
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
  const pedir = async (codigo: unknown, o: { ua?: string; ip?: string; metodo?: string; authuser?: string } = {}) => {
    const request = new Request('https://www.valentinaorellana.cl/sesion/x', {
      method: o.metodo ?? 'GET',
      headers: { 'user-agent': o.ua ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1', 'x-forwarded-for': o.ip ?? '200.1.1.1' },
    });
    const r = await abrirEnlaceSesion({ codigo, metodo: o.metodo ?? 'GET', request, authuser: o.authuser ?? null }, deps);
    await Promise.all(pendientes.splice(0));
    return r;
  };
  const bitacora = () => db.tabla('transcriptor_auditoria').filter((f) => f.accion === ACCION_ENLACE);
  return { db, id, codigo: codigoSesion(id, S)!, pedir, despachos, bitacora };
}

test('código válido en la ventana: redirige YA al Meet y despacha el robot una vez (en segundo plano)', async () => {
  const e = ruta();
  const r = await e.pedir(e.codigo);
  assert.deepEqual(r, { tipo: 'redirigir', url: MEET });
  assert.deepEqual(e.despachos, [{ bookingId: e.id, googleEventId: e.id.replace(/-/g, '') }]);
  const b = e.bitacora();
  assert.equal(b.length, 1);
  assert.equal(b[0].actor, 'sistema');
  assert.equal(b[0].resultado, 'ok');
  assert.deepEqual(b[0].detalle, { reserva: e.id, con_meet: true, intento: 'si', despacho: 'lanzado' });
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
  assert.equal(conError.bitacora()[0].resultado, 'error');
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
  e.avanzar(102); // 13:51 UTC: terminó hace 1 min
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

// ─── Textos ─────────────────────────────────────────────────────────────────

test('textos: correos, WhatsApp, Calendar y Pasos a seguir llevan el enlace propio', () => {
  const id = randomUUID();
  const enlace = enlaceEntradaSesion({ session_type: 'pareja-online', sesion_id: id }, S)!;
  assert.equal(enlace, urlSesion(id, S));
  assert.equal(enlaceEntradaSesion({ session_type: 'presencial', sesion_id: id }, S), null);
  assert.equal(enlaceEntradaSesion({ session_type: 'online', booking_id: id }, S), enlace);
  assert.equal(enlaceEntradaSesion({ session_type: 'online' }, S), null);
  const html = bloqueEntrarSesion(enlace);
  assert.ok(html.includes(`href="${enlace}"`) && html.includes('Entrar a la sesión') && !html.includes('meet.google.com'));
  assert.equal(lineaEntrarWhatsApp(enlace), `\n🔗 Entrar a la sesión (Google Meet): ${enlace}`);
  assert.equal(lineaEntrarWhatsApp(null), '');
  assert.equal(lineaEntrarCalendario(enlace), `\nEntrar a la sesión: ${enlace}`);
  const online = stepsItems('').find((p) => p.titulo === 'Si tu sesión es online')!;
  assert.match(online.texto, /correo de confirmación, en el recordatorio y en la invitación/);
});
