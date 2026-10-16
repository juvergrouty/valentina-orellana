// Pruebas del control de acceso a contenido clínico y de los ajustes reservados (revisión de
// seguridad 16 oct: A1, M2, B2). Correr: pnpm test:transcriptor (sin red ni Supabase).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ADMIN_SECRET falso para firmar tokens de prueba (secretos.ts lo lee en tiempo de ejecución).
process.env.ADMIN_SECRET = 'secreto-de-prueba-solo-para-tests-0123456789';

const { crearTokenAdmin, tokenRevocado } = await import('../adminSession');
const {
  accesoClinico, decidirAccesoClinico, esAjusteReservado, esRutaTranscriptor, respuestaRechazo, URL_CONFIRMAR_PASSKEY,
} = await import('./acceso');
const { exigePasskeyObligatoria, motivoBloqueoActivacion } = await import('./panel');

const noRevocado = async () => false;

// ── 2. Contenido clínico solo con passkey ───────────────────────────────────
test('decidirAccesoClinico: solo nivel passkey, no revocada y con lista legible', () => {
  assert.deepEqual(decidirAccesoClinico('passkey', false), { ok: true });
  const sinPk = decidirAccesoClinico('contrasena', false);
  assert.equal(sinPk.ok, false);
  assert.equal(!sinPk.ok && sinPk.motivo, 'passkey');
  assert.equal(!sinPk.ok && sinPk.status, 401);
  const sinSesion = decidirAccesoClinico(null, false);
  assert.equal(!sinSesion.ok && sinSesion.motivo, 'sesion');
  const revocada = decidirAccesoClinico('passkey', true);
  assert.equal(!revocada.ok && revocada.motivo, 'sesion');
});

test('accesoClinico: token v1 (solo contraseña) se rechaza; v2 (passkey) pasa', async () => {
  assert.equal((await accesoClinico(crearTokenAdmin('contrasena'), { revocado: noRevocado })).ok, false);
  assert.equal((await accesoClinico(crearTokenAdmin('passkey'), { revocado: noRevocado })).ok, true);
  assert.equal((await accesoClinico('v2.9999999999999.firma-falsa', { revocado: noRevocado })).ok, false);
  assert.equal((await accesoClinico('', { revocado: noRevocado })).ok, false);
  // Un v1 no se convierte en v2 cambiando el prefijo (la firma cubre el prefijo).
  const v1 = crearTokenAdmin('contrasena');
  assert.equal((await accesoClinico(v1.replace(/^v1\./, 'v2.'), { revocado: noRevocado })).ok, false);
});

test('respuesta de rechazo por falta de passkey: 401, mensaje en español y enlace a Seguridad', async () => {
  const r = await accesoClinico(crearTokenAdmin('contrasena'), { revocado: noRevocado });
  assert.ok(!r.ok);
  const res = respuestaRechazo(r);
  assert.equal(res.status, 401);
  const j = await res.json() as { ok: boolean; motivo: string; confirmar: string; error: string };
  assert.equal(j.ok, false);
  assert.equal(j.motivo, 'passkey');
  assert.equal(j.confirmar, URL_CONFIRMAR_PASSKEY);
  assert.match(j.error, /passkey/);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
});

// ── 3. Falla CERRADO si Supabase no responde ────────────────────────────────
test('accesoClinico: si no se puede leer la lista de sesiones cerradas → 503 (no deja pasar)', async () => {
  const r = await accesoClinico(crearTokenAdmin('passkey'), { revocado: async () => { throw new Error('Supabase caído'); } });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.motivo, 'no_disponible');
  assert.equal(!r.ok && r.status, 503);
});

test('tokenRevocado estricto lanza si Supabase falla; el modo general sigue dejando pasar', async () => {
  // Sin SUPABASE_URL/SERVICE_ROLE en el entorno de pruebas, cargar Supabase falla = "Supabase no responde".
  const t = crearTokenAdmin('passkey');
  assert.equal(await tokenRevocado(t), false);                              // panel general: igual que antes
  await assert.rejects(() => tokenRevocado(t, { estricto: true }));          // transcriptor: falla cerrado
  // Y por defecto accesoClinico usa el modo estricto:
  const r = await accesoClinico(t);
  assert.equal(!r.ok && r.motivo, 'no_disponible');
});

test('esRutaTranscriptor: solo las rutas del transcriptor fallan cerrado en el middleware', () => {
  for (const p of ['/admin/grabar', '/admin/grabar/', '/admin/transcriptor', '/api/admin/transcriptor/preguntar',
    '/api/admin/transcriptor/ajustes', '/admin/pacientes/abc/sesion/123', '/admin/pacientes/abc/sesion']) {
    assert.equal(esRutaTranscriptor(p), true, p);
  }
  for (const p of ['/admin', '/admin/agenda', '/admin/pacientes', '/admin/pacientes/abc', '/api/admin/settings',
    '/api/admin/login', '/admin/grabaciones', '/admin/transcriptores', '/api/admin/transcriptorx']) {
    assert.equal(esRutaTranscriptor(p), false, p);
  }
});

// ── 2b. Decisión 3: no se enciende sin passkey obligatoria ──────────────────
test('exigePasskeyObligatoria: solo al ENCENDER transcriptor o bot', () => {
  assert.equal(exigePasskeyObligatoria('transcriptor_activo', 'true'), true);
  assert.equal(exigePasskeyObligatoria('transcriptor_bot_activo', 'true'), true);
  assert.equal(exigePasskeyObligatoria('transcriptor_activo', 'false'), false);
  assert.equal(exigePasskeyObligatoria('transcriptor_bot_nombres_vale', 'true'), false);
});

test('motivoBloqueoActivacion: exige passkey registrada, obligatoria y sesión con passkey; falla cerrado', () => {
  const listo = { cantidad: 2, obligatoria: true, migracionPendiente: false };
  assert.equal(motivoBloqueoActivacion(listo, 'passkey'), null);
  assert.match(motivoBloqueoActivacion({ ...listo, obligatoria: false }, 'passkey')!, /Passkey obligatoria/);
  assert.match(motivoBloqueoActivacion({ ...listo, cantidad: 0 }, 'passkey')!, /registra tu passkey/);
  assert.match(motivoBloqueoActivacion({ ...listo, migracionPendiente: true }, 'passkey')!, /migración/);
  assert.match(motivoBloqueoActivacion(listo, 'contrasena')!, /Confirma esta sesión/);
  assert.match(motivoBloqueoActivacion('error', 'passkey')!, /Intenta de nuevo/);
  assert.ok(motivoBloqueoActivacion(null, 'passkey'));
});

// ── 4. /api/admin/settings no toca claves reservadas ────────────────────────
test('esAjusteReservado: transcriptor_*, passkey_* y claves internas', () => {
  for (const k of ['transcriptor_activo', 'transcriptor_bot_activo', 'transcriptor_grabacion_requisito', 'transcriptor_alerta_riesgo',
    'transcriptor_resumen_modo', 'transcriptor_presupuesto_clp', 'transcriptor_bot_nombres_vale', 'passkey_obligatoria',
    'cron_interno_secret', 'admin_tokens_revocados', ' Transcriptor_Activo ', 'PASSKEY_OBLIGATORIA']) {
    assert.equal(esAjusteReservado(k), true, k);
  }
  for (const k of ['flow_enabled', 'manual_payment_enabled', 'review_auto_enabled', 'descanso_minutos', 'vitrina_titulo']) {
    assert.equal(esAjusteReservado(k), false, k);
  }
});
