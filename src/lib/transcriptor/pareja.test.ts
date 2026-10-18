// Pruebas de D (parejas: la reserva manda, link de la segunda persona, dos firmas de dos personas) y
// E (anexo: copia fiel del correo con el aviso v2) de 02-decisiones-16oct-noche.md. Sin red.
// Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';
import { evaluarConsentimientos, evaluarEnBase, type FilaConsentimiento } from './consentimiento';
import {
  esReservaPareja, estadoPareja, nombreDicePareja, FaltaMigracion0021, fichaConReservaPareja, fichaEsParejaPorReserva, mensajeWhatsAppPareja,
  pendienteOCrear, personaDe, rutYaFirmoEnFicha, soloPersona1, urlWhatsAppPareja,
} from './pareja';
import { avisoV2ParaCorreo, filaAnexo, htmlAvisoV2, registrarAvisoMostrado, sha256Html, anexosDeConsentimientos, type CorreoEnviado } from './avisoV2';

const HOY = '2026-10-16';
type F = FilaConsentimiento & { persona?: number; patient_id?: string; created_at?: string; token?: string };
const fila = (p: Partial<F>): F => ({
  id: randomUUID(), version: '2026-10-v3', signed_at: '2026-10-10T12:00:00Z', signer_name: 'Camila Rojas',
  signer_rut: '12.345.678-5', signer_email: null, accept_recording: true, revoked_at: null, recording_revoked_at: null, ...p,
});
const SIN_SVC = new Map<string, string>();

// ─── D: la reserva dice si es pareja ─────────────────────────────────────────

test('D: pareja por session_type o por el servicio reservado; nunca por la pantalla', () => {
  const svc = new Map([['s-par', 'pareja'], ['s-ind', 'individual']]);
  assert.equal(esReservaPareja({ session_type: 'pareja-presencial' }, SIN_SVC), true);
  assert.equal(esReservaPareja({ session_type: 'pareja-online' }, SIN_SVC), true);
  assert.equal(esReservaPareja({ session_type: 'presencial', service_id: 's-par' }, svc), true, 'servicio de pareja');
  assert.equal(esReservaPareja({ session_type: 'presencial', service_id: 's-ind' }, svc), false);
  assert.equal(esReservaPareja({ session_type: 'online', service_id: null }, svc), false);
  assert.equal(fichaConReservaPareja([{ session_type: 'online' }, { session_type: 'presencial', service_id: 's-par' }], svc), true);
  assert.equal(fichaConReservaPareja([], svc), false);
});

test('D (17 oct): el NOMBRE de la sesión o del servicio con "pareja" (sin mayúsculas ni tildes) hace la ficha de pareja', () => {
  assert.equal(nombreDicePareja('Terapia de PAREJA'), true);
  assert.equal(nombreDicePareja('Sesión párejá online'), true, 'sin tildes');
  assert.equal(nombreDicePareja('Individual'), false);
  assert.equal(nombreDicePareja(null), false);
  assert.equal(esReservaPareja({ session_type: 'presencial', custom_title: 'Sesión de Pareja' }, SIN_SVC), true, 'nombre de la sesión');
  const svc = new Map([['s1', { type: 'individual', name: 'Terapia de pareja online' }], ['s2', { type: 'individual', name: 'Psicoterapia adultos' }]]);
  assert.equal(esReservaPareja({ session_type: 'online', service_id: 's1' }, svc), true, 'nombre del servicio');
  assert.equal(esReservaPareja({ session_type: 'online', service_id: 's2' }, svc), false);
  assert.equal(esReservaPareja({ session_type: 'online', service_id: 's2', custom_title: 'Primera sesión' }, svc), false);
});

test('D (17 oct) en la base: servicio llamado "Terapia de Pareja" (tipo individual) → la regla única pide 2 firmas', async () => {
  const db = new SupabaseMemoria();
  const p = randomUUID(), s = randomUUID();
  db.tabla('patients').push({ id: p, name: 'Clara Ríos', email: 'clara@ejemplo.cl', birthdate: '1990-05-05', rut: '11.111.111-1' });
  db.tabla('services_catalog').push({ id: s, type: 'individual', name: 'Terapia de Pareja' });
  db.tabla('bookings').push({ id: randomUUID(), patient_email: 'clara@ejemplo.cl', session_type: 'presencial', service_id: s });
  db.tabla('consents').push({ ...fila({ signer_name: 'Clara Ríos', signer_rut: '11.111.111-1' }), patient_id: p });
  assert.equal(await fichaEsParejaPorReserva(db.cliente, 'clara@ejemplo.cl'), true);
  const r = await evaluarEnBase(p, 'individual', db.cliente);
  assert.deepEqual([r.puede, r.motivo, r.requeridas], [false, 'falta_segunda_firma', 2]);
  // Por el nombre de la sesión (custom_title), sin servicio.
  const db2 = new SupabaseMemoria();
  const p2 = randomUUID();
  db2.tabla('patients').push({ id: p2, name: 'Ana Pérez', email: 'ana@ejemplo.cl', birthdate: '1990-05-05', rut: null });
  db2.tabla('bookings').push({ id: randomUUID(), patient_email: 'ana@ejemplo.cl', session_type: 'online', service_id: null, custom_title: 'Sesión PAREJA' });
  assert.equal(await fichaEsParejaPorReserva(db2.cliente, 'ana@ejemplo.cl'), true);
});

function fichaBase(sessionType = 'presencial', tipoServicio: string | null = null) {
  const db = new SupabaseMemoria();
  const p = randomUUID(), s = randomUUID();
  db.tabla('patients').push({ id: p, name: 'Clara Ríos', email: 'clara@ejemplo.cl', birthdate: '1990-05-05', rut: '11.111.111-1' });
  if (tipoServicio) db.tabla('services_catalog').push({ id: s, type: tipoServicio });
  db.tabla('bookings').push({ id: randomUUID(), patient_email: 'clara@ejemplo.cl', session_type: sessionType, service_id: tipoServicio ? s : null });
  return { db, p };
}

test('D en la base: servicio de pareja (aunque session_type diga presencial) → individual con 1 firma no graba', async () => {
  const { db, p } = fichaBase('presencial', 'pareja');
  db.tabla('consents').push({ ...fila({ signer_name: 'Clara Ríos', signer_rut: '11.111.111-1' }), patient_id: p });
  assert.equal(await fichaEsParejaPorReserva(db.cliente, 'CLARA@ejemplo.cl'), true);
  const r = await evaluarEnBase(p, 'individual', db.cliente);
  assert.deepEqual([r.puede, r.motivo, r.requeridas, r.tipoEfectivo], [false, 'falta_segunda_firma', 2, 'pareja']);
});

test('D en la base: dos firmas de dos personas distintas (la segunda por su link, persona 2) → puede grabar', async () => {
  const { db, p } = fichaBase('pareja-presencial');
  db.tabla('consents').push(
    { ...fila({ signer_name: 'Clara Ríos', signer_rut: '11.111.111-1' }), patient_id: p },
    { ...fila({ signer_name: 'Luis Soto', signer_rut: '9.876.543-2', persona: 2 }), patient_id: p },
  );
  const r = await evaluarEnBase(p, 'individual', db.cliente);
  assert.equal(r.puede, true);
  assert.deepEqual(r.firmantes.sort(), ['Clara Ríos', 'Luis Soto']);
  assert.equal(r.consentIds.length, 2);
});

test('D: dos consentimientos de la MISMA persona (mismo RUT, aunque uno sea persona 2) no son dos firmas', () => {
  const filas = [fila({ signer_rut: '11.111.111-1' }), fila({ signer_rut: '11111111-1', persona: 2, signed_at: '2026-10-11T12:00:00Z' })];
  const r = evaluarConsentimientos({ patientId: 'p', tipo: 'pareja', fichaPareja: true, fechaNacimiento: '1990-05-05', filas, hoy: HOY });
  assert.deepEqual([r.puede, r.motivo], [false, 'falta_segunda_firma']);
});

test('D: link de la pareja pendiente (sin firmar) no cuenta como firma; su retiro bloquea', () => {
  const base = fila({ signer_rut: '11.111.111-1' });
  const pend = fila({ signed_at: null, signer_name: null, signer_rut: null, persona: 2 });
  assert.equal(evaluarConsentimientos({ patientId: 'p', tipo: 'pareja', fechaNacimiento: '1990-05-05', filas: [base, pend], hoy: HOY }).motivo, 'falta_segunda_firma');
  const retirada = fila({ signer_rut: '9.876.543-2', persona: 2, revoked_at: '2026-10-15T00:00:00Z' });
  assert.equal(evaluarConsentimientos({ patientId: 'p', tipo: 'pareja', fechaNacimiento: '1990-05-05', filas: [base, retirada], hoy: HOY }).motivo, 'revocado');
});

test('D: parejas que ya firmaron (dos firmas persona 1, v2) siguen pudiendo grabar igual que antes', () => {
  const filas = [fila({ version: '2026-10-v2' }), fila({ version: '2026-10-v2', signer_rut: '9.876.543-2', signer_name: 'Diego Pérez' })];
  assert.equal(evaluarConsentimientos({ patientId: 'p', tipo: 'pareja', fichaPareja: true, fechaNacimiento: '1990-05-05', filas, hoy: HOY }).puede, true);
});

// ─── D: link de la segunda persona ───────────────────────────────────────────

test('D: pendienteOCrear crea un consentimiento DISTINTO para la persona 2, ligado a la misma ficha, y lo reutiliza', async () => {
  const db = new SupabaseMemoria();
  const p = randomUUID();
  let k = 0;
  const tok = () => `tok${++k}`;
  const p1 = await pendienteOCrear(db.cliente, p, 1, '2026-10-v3', tok);
  const p2 = await pendienteOCrear(db.cliente, p, 2, '2026-10-v3', tok);
  assert.notEqual(p1.id, p2.id);
  assert.notEqual(p1.token, p2.token);
  const filas = db.tabla('consents');
  assert.deepEqual(filas.map((f) => [f.patient_id, personaDe(f)]), [[p, 1], [p, 2]]);
  assert.equal('persona' in filas[0], false, 'la persona 1 se inserta igual que antes de 0021 (sin la columna)');
  assert.deepEqual(await pendienteOCrear(db.cliente, p, 2, '2026-10-v3', tok), p2, 'el link ya enviado sigue sirviendo');
  assert.deepEqual(await pendienteOCrear(db.cliente, p, 1, '2026-10-v3', tok), p1, 'el link de la paciente no se mezcla con el de la pareja');
  assert.equal(db.tabla('consents').length, 2);
});

test('D: sin la migración 0021 el link de la pareja avisa y el de la paciente sigue funcionando', async () => {
  const db = new SupabaseMemoria();
  const insertar = db.from.bind(db);
  // Imita PostgREST sin la columna persona.
  (db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
    const q = insertar(t) as unknown as { insert: (v: Record<string, unknown>) => unknown };
    const orig = q.insert.bind(q);
    q.insert = (v: Record<string, unknown>) => ('persona' in v
      ? { select: () => ({ single: async () => ({ data: null, error: { code: 'PGRST204', message: "Could not find the 'persona' column" } }) }) }
      : orig(v));
    return q;
  };
  await assert.rejects(pendienteOCrear(db.cliente, 'p', 2, 'v3', () => 't2'), FaltaMigracion0021);
  assert.ok((await pendienteOCrear(db.cliente, 'p', 1, 'v3', () => 't1')).token);
});

test('D: estado de la pareja: falta / firmado por <nombre> / retirado; reconoce parejas antiguas por RUT de la ficha', () => {
  const clara = fila({ signer_name: 'Clara Ríos', signer_rut: '11.111.111-1', signed_at: '2026-10-01T12:00:00Z' });
  assert.equal(estadoPareja([clara], '11111111-1').firma, null);
  const pend = fila({ signed_at: null, signer_name: null, signer_rut: null, persona: 2, token: 'tp', created_at: '2026-10-02T00:00:00Z' });
  assert.equal(estadoPareja([clara, pend], '11111111-1').pendiente?.token, 'tp');
  const luis = fila({ signer_name: 'Luis Soto', signer_rut: '9.876.543-2', persona: 2, signed_at: '2026-10-05T12:00:00Z' });
  assert.equal(estadoPareja([clara, luis], '11111111-1').firma?.signer_name, 'Luis Soto');
  // Pareja que firmó antes de 0021 con dos links de la ficha (ambas persona 1):
  const antigua = fila({ signer_name: 'Diego Pérez', signer_rut: '9.876.543-2', signed_at: '2026-09-01T00:00:00Z' });
  assert.equal(estadoPareja([antigua, clara], '11.111.111-1').firma?.signer_name, 'Diego Pérez');
  assert.equal(estadoPareja([antigua, clara], null, 'Clara Ríos').firma?.signer_name, 'Diego Pérez', 'sin RUT en la ficha: por el nombre');
  const retiro = estadoPareja([clara, { ...luis, revoked_at: '2026-10-12T00:00:00Z' }], '11111111-1');
  assert.deepEqual([retiro.firma, retiro.retirada?.signer_name], [null, 'Luis Soto']);
});

test('D: la firma de la pareja nunca tapa el consentimiento propio de la paciente (vigente = solo persona 1)', () => {
  const filas = [fila({ signed_at: null }), fila({ persona: 2 })];
  assert.equal(soloPersona1(filas).length, 1);
  assert.equal(soloPersona1(filas).filter((f) => f.signed_at).length, 0, 'la paciente sigue sin firmar');
});

test('D: la pareja no puede firmar con el RUT de quien ya firmó en la ficha', () => {
  const filas = [fila({ signer_rut: '11.111.111-1' })];
  assert.equal(rutYaFirmoEnFicha('11111111-1', filas), true);
  assert.equal(rutYaFirmoEnFicha('22.222.222-2', filas, '22222222-2'), true, 'el RUT de la ficha');
  assert.equal(rutYaFirmoEnFicha('9876543-2', filas, '11111111-1'), false);
});

test('D: WhatsApp con el link (wa.me sin número: Vale elige a la persona)', () => {
  const url = 'https://www.valentinaorellana.cl/consentimiento/abc_DEF-123';
  const wa = urlWhatsAppPareja('Clara', url);
  assert.match(wa, /^https:\/\/wa\.me\/\?text=/);
  assert.equal(decodeURIComponent(wa.split('text=')[1]), mensajeWhatsAppPareja('Clara', url));
  assert.match(mensajeWhatsAppPareja('Clara', url), /terapia de pareja con Clara/);
  assert.ok(mensajeWhatsAppPareja('Clara', url).includes(url));
});

// ─── E: anexo = copia fiel del correo con el aviso v2 ────────────────────────

function fichaV2() {
  const db = new SupabaseMemoria();
  const p = randomUUID();
  db.tabla('settings').push({ key: 'transcriptor_activo', value: 'true' });
  db.tabla('patients').push({ id: p, name: 'Diego Soto', email: 'diego@ejemplo.cl', rut: '9.876.543-2', birthdate: '1990-05-05' });
  const c = { ...fila({ version: '2026-10-v2', signer_name: 'Diego Soto', signer_rut: '9.876.543-2', signer_email: 'diego@ejemplo.cl' }), patient_id: p, text_snapshot: 'texto v2', text_sha256: 'h' };
  db.tabla('consents').push(c);
  return { db, p, c };
}
const correoDe = (html: string): CorreoEnviado => ({ html, asunto: 'Sesión confirmada — Ps. Valentina Orellana', destinatario: 'diego@ejemplo.cl', enviadoAt: '2026-10-16T15:00:00.000Z', resendId: 're_123' });

test('E: el anexo guardado es IGUAL al HTML enviado (con su SHA-256), ligado a la firma', async () => {
  const { db, c } = fichaV2();
  const a = await avisoV2ParaCorreo('diego@ejemplo.cl', db.cliente);
  assert.ok(a);
  const html = `<div>Hola Diego Soto — confirmación ${'ñ'.repeat(3)}</div>${a!.html}`;
  assert.equal(await registrarAvisoMostrado(a!, null, db.cliente, correoDe(html)), 1);
  const [anexo] = db.tabla('consent_anexos');
  assert.equal(anexo.html, html, 'byte a byte');
  assert.equal(anexo.html_sha256, createHash('sha256').update(html, 'utf8').digest('hex'));
  assert.equal(anexo.html_sha256, sha256Html(html));
  assert.deepEqual([anexo.consent_id, anexo.tipo, anexo.asunto, anexo.destinatario, anexo.enviado_at, anexo.resend_id],
    [c.id, 'aviso_v2', 'Sesión confirmada — Ps. Valentina Orellana', 'diego@ejemplo.cl', '2026-10-16T15:00:00.000Z', 're_123']);
  assert.equal(anexo.aviso_id, null, 'M1: el anexo se guarda antes que el aviso');
  assert.equal(db.tabla('consent_avisos')[0].consent_id, c.id);
  const lista = await anexosDeConsentimientos([c.id], db.cliente);
  assert.equal(lista.length, 1);
  // Segunda confirmación: ya avisado, no hay aviso ni anexo nuevo.
  assert.equal(await avisoV2ParaCorreo('diego@ejemplo.cl', db.cliente), null);
  assert.equal(await registrarAvisoMostrado(a!, null, db.cliente, correoDe(html + 'otro')), 0);
  assert.equal(db.tabla('consent_anexos').length, 1);
});

test('E: las firmas v2 NO cambian (ni al avisar ni al guardar el anexo) y siguen habilitando grabar', async () => {
  const { db, p, c } = fichaV2();
  const antes = structuredClone(db.tabla('consents'));
  const a = await avisoV2ParaCorreo('diego@ejemplo.cl', db.cliente);
  await registrarAvisoMostrado(a!, null, db.cliente, correoDe(htmlAvisoV2()));
  assert.deepEqual(db.tabla('consents'), antes, 'consents intacta');
  const r = await evaluarEnBase(p, 'individual', db.cliente);
  assert.deepEqual([r.puede, r.consentIds], [true, [c.id]]);
});

test('M1: si falla guardar el anexo (sin 0021 o fallo transitorio), NO se registra el aviso y vuelve a ir en el próximo correo', async () => {
  const { db, c } = fichaV2();
  const desde = db.from.bind(db);
  let falla = true;
  (db as unknown as { from: (t: string) => unknown }).from = (t: string) => (t === 'consent_anexos' && falla
    ? { insert: async () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } }) }
    : desde(t));
  const a = await avisoV2ParaCorreo('diego@ejemplo.cl', db.cliente);
  assert.equal(await registrarAvisoMostrado(a!, null, db.cliente, correoDe('<p>x</p>')), 0);
  assert.equal(db.tabla('consent_avisos').length, 0, 'sin anexo no hay aviso registrado');
  // Próximo correo: el aviso corresponde de nuevo; ahora el anexo se guarda y luego el aviso.
  falla = false;
  const b = await avisoV2ParaCorreo('diego@ejemplo.cl', db.cliente);
  assert.deepEqual(b?.consentIds, [c.id]);
  assert.equal(await registrarAvisoMostrado(b!, null, db.cliente, correoDe('<p>y</p>')), 1);
  assert.equal(db.tabla('consent_anexos').length, 1);
  assert.equal(db.tabla('consent_anexos')[0].html, '<p>y</p>');
  assert.equal(db.tabla('consent_avisos').length, 1);
});

test('M1: el anexo se guarda ANTES que el aviso (orden de inserción)', async () => {
  const { db } = fichaV2();
  const orden: string[] = [];
  const desde = db.from.bind(db);
  (db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
    const q = desde(t) as { insert?: (...x: unknown[]) => unknown };
    if (q && typeof q.insert === 'function' && (t === 'consent_anexos' || t === 'consent_avisos')) {
      const ins = q.insert.bind(q);
      q.insert = (...x: unknown[]) => { orden.push(t); return ins(...x); };
    }
    return q;
  };
  const a = await avisoV2ParaCorreo('diego@ejemplo.cl', db.cliente);
  assert.equal(await registrarAvisoMostrado(a!, null, db.cliente, correoDe('<p>x</p>')), 1);
  assert.deepEqual(orden, ['consent_anexos', 'consent_avisos']);
});

test('E: sin datos del correo (llamada antigua) solo queda la constancia, sin anexo', async () => {
  const { db } = fichaV2();
  const a = await avisoV2ParaCorreo('diego@ejemplo.cl', db.cliente);
  assert.equal(await registrarAvisoMostrado(a!, null, db.cliente), 1);
  assert.equal(db.tabla('consent_anexos').length, 0);
});

test('E: pareja antigua con el mismo correo en las dos firmas → aviso y anexo solo para quien tiene el RUT de la ficha', async () => {
  const { db, p, c } = fichaV2();
  db.tabla('consents').push({ ...fila({ version: '2026-10-v2', signer_name: 'Ana Soto', signer_rut: '11.111.111-1', signer_email: 'diego@ejemplo.cl' }), patient_id: p });
  const a = await avisoV2ParaCorreo('diego@ejemplo.cl', db.cliente);
  assert.deepEqual(a!.consentIds, [c.id]);
});

test('E: filaAnexo arma la fila completa', () => {
  const f = filaAnexo({ patientId: 'p', consentIds: ['c'], html: '' }, 'c', 'av', 'b', correoDe('<b>hola</b>'));
  assert.deepEqual(f, {
    consent_id: 'c', aviso_id: 'av', patient_id: 'p', booking_id: 'b', tipo: 'aviso_v2', asunto: 'Sesión confirmada — Ps. Valentina Orellana',
    destinatario: 'diego@ejemplo.cl', enviado_at: '2026-10-16T15:00:00.000Z', resend_id: 're_123', html: '<b>hola</b>', html_sha256: sha256Html('<b>hola</b>'),
  });
});
