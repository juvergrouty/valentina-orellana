// Pruebas de las correcciones de docs/transcriptor/86-revision-cambios-nuevos.md (M2, B1–B5; M1 está
// en pareja.test.ts y el QR en qr.test.ts). Sin red: Supabase en memoria. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';
import { AVISO_FALTA_0020, consultarResumenes } from './archivo';
import { recopilarFicha } from './exportacion';
import { contextoSesionAnterior } from './resumen';
import { evaluarEnBase, fichaEsParejaEnBase } from './consentimiento';
import { enmascararCorreo } from './pareja';
import { armarCorreo, crearAlertas, type AlertaFila, type RepoAlertas, type SesionDeAlerta } from './alertas';
import type { AlmArchivo } from './archivo';

const fuente = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const GID = '11111111-2222-4333-8444-555555555555';

/** Base SIN la migración 0020: pedir archivo_* / archivado_at a resumenes_ia da 42703 (como PostgREST). */
function sin0020(db: SupabaseMemoria): { pedidasConArchivo: number } {
  const n = { pedidasConArchivo: 0 };
  const desde = db.from.bind(db);
  (db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
    const q = desde(t) as unknown as { select: (c?: string, o?: unknown) => unknown };
    if (t !== 'resumenes_ia') return q;
    const sel = q.select.bind(q);
    q.select = (c?: string, o?: unknown) => {
      if (!String(c ?? '').includes('archiv')) return sel(c, o);
      n.pedidasConArchivo++;
      const resp = { data: null, error: { code: '42703', message: 'column resumenes_ia.archivo_r2_key does not exist' } };
      const p: unknown = new Proxy({}, { get: (_x, k) => (k === 'then' ? (ok: (v: unknown) => unknown, mal: (e: unknown) => unknown) => Promise.resolve(resp).then(ok, mal) : () => p) });
      return p;
    };
    return q;
  };
  return n;
}

// ─── M2: sin 0020 los resúmenes se leen igual (o se avisa), nunca desaparecen en silencio ────────

test('M2: consultarResumenes repite sin columnas de archivo si falta 0020 y lo informa', async () => {
  const pedidas: string[] = [];
  const r = await consultarResumenes(async (cols) => {
    pedidas.push(cols);
    return cols ? { data: null, error: { code: '42703' } } : { data: [{ id: 'r1' }], error: null };
  });
  assert.deepEqual(pedidas, [', archivo_r2_key, archivo_b2_key, archivado_at', '']);
  assert.deepEqual([r.data, r.error, r.falta0020], [[{ id: 'r1' }], null, true]);
  const ok = await consultarResumenes(async () => ({ data: [{ id: 'r2' }], error: null }));
  assert.equal(ok.falta0020, false);
  const otro = await consultarResumenes(async () => ({ data: null, error: { code: '57014' } }));
  assert.deepEqual([otro.error?.code, otro.falta0020], ['57014', false], 'otros errores no se esconden');
  assert.match(AVISO_FALTA_0020, /migración 0020/);
});

function fichaSimple() {
  const db = new SupabaseMemoria();
  const p = randomUUID(), g1 = randomUUID(), g2 = randomUUID();
  db.tabla('patients').push({ id: p, name: 'Camila Rojas', rut: '12.345.678-5', email: 'camila@ejemplo.cl', created_at: '2026-09-01T12:00:00Z' });
  db.tabla('grabaciones').push(
    { id: g1, patient_id: p, origen: 'presencial', tipo: 'individual', estado: 'lista', session_date: '2026-10-01', inicio_at: null, duracion_seg: 3000, pausas: [], mapa_hablantes: null, consent_ids: [], excluir_ia_at: null },
    { id: g2, patient_id: p, origen: 'presencial', tipo: 'individual', estado: 'lista', session_date: '2026-10-08', inicio_at: null, duracion_seg: 3000, pausas: [], mapa_hablantes: null, consent_ids: [], excluir_ia_at: null },
  );
  db.tabla('resumenes_ia').push({ id: randomUUID(), grabacion_id: g1, patient_id: p, version: 1, autor: 'ia', estado: 'listo', modelo: 'm', listo_at: '2026-10-01T20:00:00Z', oculto_at: null,
    contenido: '### Tareas\n- Registro de pensamientos.\n\n### Para trabajar en la próxima sesión\n- Hablar de la jefa.', contenido_cifrado: null });
  return { db, p, g1, g2 };
}
const almNunca = { async leerCifrado() { throw new Error('no debería leer R2'); } } as unknown as AlmArchivo;

test('M2: la exportación sin 0020 NO falla (antes 502) y trae el resumen que está en la base', async () => {
  const { db, p } = fichaSimple();
  const n = sin0020(db);
  const f = await recopilarFicha(p, { db: db.cliente, alm: almNunca, leerTranscripcion: async () => { throw new Error('sin transcripción'); }, ahora: () => new Date('2026-10-16T15:00:00Z') } as never);
  assert.ok(n.pedidasConArchivo >= 1, 'primero pidió las columnas de 0020');
  assert.equal(f.sesiones_grabadas[0].resumenes[0].contenido, '### Tareas\n- Registro de pensamientos.\n\n### Para trabajar en la próxima sesión\n- Hablar de la jefa.');
});

test('M2: el contexto de la sesión anterior (para el resumen nuevo) no se pierde sin 0020', async () => {
  const { db, p, g2 } = fichaSimple();
  sin0020(db);
  const ctx = await contextoSesionAnterior({ id: g2, patient_id: p, session_date: '2026-10-08' }, db.cliente);
  assert.ok(ctx && ctx.includes('Registro de pensamientos.'), String(ctx));
});

test('M2: ficha, sesión y preguntas usan consultarResumenes; la ficha avisa en vez de quedar vacía', () => {
  // 17 oct: la carga de la ficha se movió a fichaNotas.ts (la usan la ficha y su historial bajo demanda).
  const carga = fuente('./fichaNotas.ts');
  assert.match(carga, /consultarResumenes\(\(cols\) => supabase\.from\('resumenes_ia'\)/);
  assert.match(carga, /else if \(falta0020\) avisoBase = AVISO_FALTA_0020/);
  assert.match(carga, /if \(er\) avisoBase = /);
  assert.match(fuente('../../pages/admin/pacientes/[id].astro'), /\{ia\.avisoBase && \(/);
  assert.match(fuente('../../pages/admin/pacientes/[id]/sesion/[gid].astro'), /consultarResumenes\(\(cols\)/);
  assert.match(fuente('../../pages/api/admin/transcriptor/preguntar.ts'), /consultarResumenes(<[^>]+>)?\(\(cols\)/);
  for (const f of ['../../pages/admin/pacientes/[id].astro', './fichaNotas.ts', '../../pages/admin/pacientes/[id]/sesion/[gid].astro', '../../pages/api/admin/transcriptor/preguntar.ts', './exportacion.ts', './resumen.ts']) {
    assert.doesNotMatch(fuente(f), /\$\{COLUMNAS_ARCHIVO\}/, `${f}: no pide las columnas de 0020 sin respaldo`);
  }
});

// ─── B1: una sola regla de "ficha de pareja" para grabar y para el link de la persona 2 ──────────

test('B1: ficha "Ana y Luis" sin reserva de pareja → pide 2 firmas Y tiene link de la pareja (misma fuente)', async () => {
  const db = new SupabaseMemoria();
  const p = randomUUID();
  db.tabla('patients').push({ id: p, name: 'Ana Pérez y Luis Soto', email: 'ana@ejemplo.cl', birthdate: '1990-05-05', rut: '11.111.111-1' });
  db.tabla('bookings').push({ id: randomUUID(), patient_email: 'ana@ejemplo.cl', session_type: 'presencial', service_id: null });
  db.tabla('consents').push({ id: randomUUID(), patient_id: p, version: '2026-10-v3', signed_at: '2026-10-10T12:00:00Z', signer_name: 'Ana Pérez', signer_rut: '11.111.111-1', signer_email: null, accept_recording: true, revoked_at: null, recording_revoked_at: null });
  const ev = await evaluarEnBase(p, 'individual', db.cliente);
  assert.deepEqual([ev.puede, ev.requeridas, ev.tipoEfectivo], [false, 2, 'pareja']);
  assert.equal(await fichaEsParejaEnBase(p, db.cliente), true, 'el link de la persona 2 se ofrece');

  const db2 = new SupabaseMemoria();
  const q = randomUUID();
  db2.tabla('patients').push({ id: q, name: 'Clara Ríos', email: 'clara@ejemplo.cl', birthdate: '1990-05-05', rut: '11.111.111-1' });
  assert.equal(await fichaEsParejaEnBase(q, db2.cliente), false);
  assert.equal((await evaluarEnBase(q, 'individual', db2.cliente)).requeridas, 1);
});

test('B1: api/admin/consent.ts y el bloque de la ficha usan fichaEsParejaEnBase (no otra regla)', () => {
  const api = fuente('../../pages/api/admin/consent.ts');
  const comp = fuente('./fichaConsentimientos.ts');
  assert.match(api, /fichaEsParejaEnBase\(patientId, supabase\)/);
  assert.match(comp, /await fichaEsParejaEnBase\(patient\.id\)/);
  assert.doesNotMatch(api + comp, /fichaEsParejaPorReserva/);
});

// ─── B2: acciones pareja_* con guardiaPanel y bitácora ──────────────────────────────────────────

test('B2: pareja_link/whatsapp/email pasan por guardiaPanel ANTES de crear nada y quedan en la bitácora', () => {
  const api = fuente('../../pages/api/admin/consent.ts');
  const bloque = api.slice(api.indexOf("if (action === 'pareja_link'"), api.indexOf("if (!['whatsapp', 'email', 'link'].includes(action))"));
  const iGuardia = bloque.indexOf('await guardiaPanel(ctx, action as AccionAuditoria)');
  assert.ok(iGuardia > 0, 'guardiaPanel en el bloque');
  assert.ok(iGuardia < bloque.indexOf('getOrCreatePendingConsent'), 'antes de crear el consentimiento');
  assert.ok(iGuardia < bloque.indexOf('sendConsentLinkEmail'), 'antes de mandar el correo');
  for (const canal of ["canal: 'link'", "canal: 'correo'", "canal: 'whatsapp'"]) assert.ok(bloque.includes(`bitacora({ ${canal}`), canal);
  assert.match(fuente('../../components/admin/ConsentimientosFicha.astro'), /'X-Panel': '1'/, 'la ficha manda la cabecera');
});

// ─── B3: el correo de la pareja no queda guardado (enmascarado en admin_logs y bitácora) ────────

test('B3: enmascararCorreo nunca deja el correo completo', () => {
  assert.equal(enmascararCorreo('luis.soto@gmail.com'), 'l•••@g•••.com');
  assert.equal(enmascararCorreo('a@b.cl'), 'a•••@b•••.cl');
  assert.equal(enmascararCorreo('raro'), '•••');
  assert.doesNotMatch(enmascararCorreo('luis.soto@gmail.com'), /soto|gmail/);
});

test('B3: el envío a la pareja registra el destinatario enmascarado (admin_logs y bitácora)', () => {
  const api = fuente('../../pages/api/admin/consent.ts');
  assert.match(api, /sendConsentLinkEmail\(\{ patientName: '', patientEmail: correoPareja, url: linkP2, destinatarioEnLog: enmascararCorreo\(correoPareja\) \}\)/);
  assert.match(api, /destinatario: enmascararCorreo\(correoPareja\)/);
  assert.match(fuente('../email.ts'), /logEmail\('email\/consentimiento', opts\.destinatarioEnLog \?\? opts\.patientEmail/);
});

// ─── B4: el correo del aviso trae el botón que repara ───────────────────────────────────────────

const sesionError = (antes: SesionDeAlerta['estado']): SesionDeAlerta => ({
  session_date: '2026-10-16', inicio_at: null, origen: 'presencial', estado: 'error', estado_antes_error: antes, patient_id: null, paciente: 'NO DEBE SALIR',
  hora_fin_prevista: null, bot_machine_id: null, segmentos_subidos: 0, b2_pendientes: 0,
});
const filaAviso = (clave: string, tipo: AlertaFila['tipo']): AlertaFila => ({
  id: 'aaaaaaaa-2222-4333-8444-555555555555', creada_at: '2026-10-16T12:00:00Z', tipo, titulo: 'Falló', detalle: null, grabacion_id: GID,
  accion: 'revisar', clave, veces: 1, ultima_vez: '2026-10-16T12:00:00Z', resuelta_at: null, resuelta_por: null, correo_enviado_at: null,
});

test('B4: con la sesión, el correo de un aviso nacido con accion=revisar trae el botón que repara', () => {
  const sinSesion = armarCorreo(filaAviso(`transcripcion:${GID}`, 'transcripcion'), 'https://www.valentinaorellana.cl/admin/transcriptor');
  assert.doesNotMatch(sinSesion.texto, /accion=reintentar/);
  const con = armarCorreo(filaAviso(`transcripcion:${GID}`, 'transcripcion'), 'https://www.valentinaorellana.cl/admin/transcriptor', sesionError('transcribiendo'));
  assert.match(con.texto, /accion=reintentar&|accion=reintentar$/m);
  assert.match(con.texto, /accion=revisar/);
  const sub = armarCorreo(filaAviso(`subida:${GID}`, 'subida'), 'https://www.valentinaorellana.cl/admin/transcriptor', sesionError('subida'));
  assert.match(sub.texto, /accion=rescatar/);
  assert.match(sub.html, /Cerrar la sesión como no grabada/);
  for (const c of [con, sub]) assert.doesNotMatch(c.html + c.texto, /NO DEBE SALIR/, 'sin datos del paciente en el correo');
});

test('B4: registrarAlerta lee la sesión para armar el correo', async () => {
  const filas: AlertaFila[] = [];
  const repo: RepoAlertas = {
    async abiertaPorClave(clave) { return filas.find((f) => f.clave === clave && !f.resuelta_at) ?? null; },
    async insertar(f) { const fila = { ...f, id: 'aaaaaaaa-2222-4333-8444-555555555555', creada_at: f.ultima_vez, resuelta_at: null, resuelta_por: null, correo_enviado_at: null } as AlertaFila; filas.push(fila); return { fila, conflicto: false }; },
    async sumarVez() { return null; },
    async ultimoCorreo() { return null; },
    async reclamarCorreo() { return true; },
    async liberarCorreo() {},
    async obtener() { return null; },
    async listarAbiertas() { return []; },
    async resolver() { return 0; },
    async correoDestino() { return 'vale@example.test'; },
    async leerSesion(gid) { assert.equal(gid, GID); return sesionError('resumiendo'); },
  };
  const correos: string[] = [];
  const s = crearAlertas({ repo, ahora: () => new Date('2026-10-16T12:00:00Z'), enviarCorreo: async (_p, c) => { correos.push(c.texto); return true; } });
  await s.registrarAlerta({ tipo: 'resumen', titulo: 'Claude respondió 529', grabacionId: GID, accion: 'revisar' });
  assert.equal(correos.length, 1);
  assert.match(correos[0], /accion=reintentar_resumen/);
});

// ─── B5: la exportación encuentra las reservas aunque el correo cambie de mayúsculas ────────────

test('B5: reservas del PDF legal por correo sin distinguir mayúsculas', async () => {
  const { db, p } = fichaSimple();
  db.tabla('bookings').push(
    { id: 'b1', patient_email: 'Camila@Ejemplo.CL', session_date: '2026-10-08', session_time: '16:00:00', session_type: 'presencial', status: 'confirmed' },
    { id: 'b2', patient_email: 'camila@ejemplo.cl', session_date: '2026-10-15', session_time: '16:00:00', session_type: 'presencial', status: 'confirmed' },
    { id: 'b3', patient_email: 'otra@ejemplo.cl', session_date: '2026-10-15', session_time: '17:00:00', session_type: 'presencial', status: 'confirmed' },
  );
  const f = await recopilarFicha(p, { db: db.cliente, alm: almNunca, leerTranscripcion: async () => { throw new Error('x'); }, ahora: () => new Date('2026-10-16T15:00:00Z') } as never);
  assert.deepEqual(f.sesiones_agendadas.map((b) => b.fecha), ['2026-10-08', '2026-10-15']);
});
