// Pruebas del indicador "Sin consentimiento firmado" (pedido de Vale, 19 oct). Correr: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  estadoConsentimiento, estadosConsentimientoEnBase, estadosConsentimientoSeguro, etiquetaConsentimiento,
  hrefEnviarConsentimiento, vigentePropio, type FilaEstado,
} from './estadoConsentimiento';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';

let n = 0;
const fila = (p: Partial<FilaEstado>): FilaEstado => ({
  id: `c${++n}`, version: '2026-10-v4', signed_at: '2026-10-10T12:00:00Z', signer_name: 'Camila Rojas',
  signer_rut: '12.345.678-5', signer_email: null, accept_treatment: true, accept_recording: true, revoked_at: null, persona: 1, ...p,
});
const est = (filas: FilaEstado[], fichaPareja = false, nombre = 'Camila Rojas', rut: string | null = '12.345.678-5') =>
  estadoConsentimiento({ filas, fichaPareja, nombre, rut });

test('sin filas, solo link enviado o firma retirada → sin_firma', () => {
  assert.equal(est([]), 'sin_firma');
  assert.equal(est([fila({ signed_at: null })]), 'sin_firma');
  assert.equal(est([fila({ revoked_at: '2026-10-12T00:00:00Z' })]), 'sin_firma');
});

test('firmado con grabación autorizada (cualquier versión, también v1) → firmado', () => {
  for (const version of ['2026-10-v1', '2026-10-v2', '2026-11-v3', '2026-10-v4']) assert.equal(est([fila({ version })]), 'firmado', version);
});

test('firmó sin autorizar grabación, o retiró solo la grabación → sin_grabacion', () => {
  assert.equal(est([fila({ accept_recording: false })]), 'sin_grabacion');
  assert.equal(est([fila({ version: '2026-10-v1', recording_revoked_at: '2026-10-18T00:00:00Z' })]), 'sin_grabacion');
});

test('la firma de la pareja (persona 2) no tapa la falta del consentimiento propio', () => {
  assert.equal(est([fila({ persona: 2, signer_rut: '9.876.543-2', signer_name: 'Luis Soto' })], true), 'sin_firma');
});

test('ficha de pareja: falta la segunda firma → falta_pareja; con las dos → firmado; la 2.ª no autoriza → sin_grabacion', () => {
  assert.equal(est([fila({})], true), 'falta_pareja');
  const dos = [fila({}), fila({ persona: 2, signer_rut: '9.876.543-2', signer_name: 'Luis Soto', version: '2026-10-v1' })];
  assert.equal(est(dos, true), 'firmado');
  assert.equal(est([fila({}), fila({ persona: 2, signer_rut: '9.876.543-2', signer_name: 'Luis Soto', accept_recording: false })], true), 'sin_grabacion');
  // La pareja retiró su consentimiento completo → vuelve a faltar su firma.
  assert.equal(est([fila({}), fila({ persona: 2, signer_rut: '9.876.543-2', signer_name: 'Luis Soto', revoked_at: '2026-10-15T00:00:00Z' })], true), 'falta_pareja');
});

test('etiquetas y enlace', () => {
  assert.equal(etiquetaConsentimiento('sin_firma'), 'Sin consentimiento firmado');
  assert.equal(etiquetaConsentimiento('sin_grabacion'), 'Consentimiento sin autorización de grabación');
  assert.equal(etiquetaConsentimiento('falta_pareja'), 'Falta el consentimiento de la pareja');
  assert.equal(etiquetaConsentimiento('firmado'), null);
  assert.equal(etiquetaConsentimiento(undefined), null);
  assert.equal(hrefEnviarConsentimiento('abc'), '/admin/pacientes/abc#consentimiento');
});

test('vigentePropio: el último firmado de la persona 1, si no fue retirado (misma regla de consent.ts)', () => {
  const vieja = fila({ signed_at: '2026-10-01T00:00:00Z' });
  const nueva = fila({ signed_at: '2026-10-05T00:00:00Z' });
  assert.equal(vigentePropio([vieja, nueva])?.id, nueva.id);
  assert.equal(vigentePropio([vieja, fila({ signed_at: '2026-10-06T00:00:00Z', revoked_at: '2026-10-07T00:00:00Z' })]), null);
  const fuente = readFileSync(new URL('../consent.ts', import.meta.url), 'utf8');
  assert.match(fuente, /return vigentePropio\(rows\)/, 'consent.ts → vigente debe reutilizar la regla (sin duplicarla)');
});

test('en lote con la base: cada ficha con su estado; reserva de pareja y v1 autorizada', async () => {
  const db = new SupabaseMemoria();
  db.tabla('services_catalog').push({ id: 's-par', type: 'pareja', name: 'Terapia de pareja' }, { id: 's-ind', type: 'individual', name: 'Sesión individual' });
  db.tabla('bookings').push(
    { patient_email: 'ANA@ejemplo.cl', session_type: 'presencial', service_id: 's-par', custom_title: null },
    { patient_email: 'camila@ejemplo.cl', session_type: 'presencial', service_id: 's-ind', custom_title: null },
  );
  db.tabla('consents').push(
    { ...fila({ signer_name: 'Camila Rojas', version: '2026-10-v1' }), patient_id: 'p-cam' },
    { ...fila({ signer_name: 'Ana Pérez', signer_rut: '11.111.111-1' }), patient_id: 'p-ana' },
    { ...fila({ signer_name: 'Tomás Díaz', signer_rut: '13.333.333-3', accept_recording: false }), patient_id: 'p-tom' },
    { ...fila({ signed_at: null }), patient_id: 'p-sin' },
  );
  const m = await estadosConsentimientoEnBase([
    { id: 'p-cam', name: 'Camila Rojas', email: 'camila@ejemplo.cl', rut: '12.345.678-5' },
    { id: 'p-ana', name: 'Ana Pérez', email: 'ana@ejemplo.cl', rut: '11.111.111-1' },
    { id: 'p-tom', name: 'Tomás Díaz', email: null },
    { id: 'p-sin', name: 'Sofía Paz', email: 'sofia@ejemplo.cl' },
    { id: 'p-nada', name: 'Nadie', email: null },
  ], db.cliente);
  assert.equal(m.get('p-cam'), 'firmado');
  assert.equal(m.get('p-ana'), 'falta_pareja');
  assert.equal(m.get('p-tom'), 'sin_grabacion');
  assert.equal(m.get('p-sin'), 'sin_firma');
  assert.equal(m.get('p-nada'), 'sin_firma');
});

test('en lote: si no se pueden leer los consentimientos, la versión segura no inventa indicadores', async () => {
  const roto = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: 'caída' } }) }) }) };
  await assert.rejects(estadosConsentimientoEnBase([{ id: 'p1' }], roto as never));
  const m = await estadosConsentimientoSeguro([{ id: 'p1' }], roto as never);
  assert.equal(m.size, 0);
});

test('el indicador está en la lista, la ficha, la agenda (bloques y paneles), el calendario y el grabador', () => {
  const leer = (r: string) => readFileSync(new URL(r, import.meta.url), 'utf8');
  const lista = leer('../../pages/admin/pacientes.astro');
  assert.match(lista, /estadosConsentimientoSeguro\(/);
  assert.match(lista, /<IndicadorConsentimiento estado=\{estadoConsent\.get\(p\.id\)\}/);
  const ficha = leer('../../pages/admin/pacientes/[id].astro');
  assert.match(ficha, /estadoConsentimiento\(\{ filas: filasConsent, fichaPareja: pareja\.esPareja/);
  assert.match(ficha, /<IndicadorConsentimiento estado=\{estadoConsent\}/);
  const agenda = leer('../../pages/admin/agenda.astro');
  assert.match(agenda, /consent_estado: cs\.estado/);
  assert.match(agenda, /id="sp-consent"/);
  assert.match(agenda, /id="gp-consent"/);
  assert.match(agenda, /pintarConsentPanel\(document\.getElementById\('sp-consent'\)/);
  assert.match(agenda, /pintarConsentPanel\(document\.getElementById\('gp-consent'\)/);
  assert.match(leer('../../pages/admin/calendario.astro'), /<IndicadorConsentimiento /);
  const grabar = leer('../../pages/admin/grabar.astro');
  assert.match(grabar, /c\.consentEstado = c\.patientId/);
  const grabador = leer('../../components/admin/Grabador.astro');
  assert.match(grabador, /chipConsent\(c\.consentEstado\)/);
  assert.match(grabador, /chipConsent\(p\.consent\)/);
  assert.match(grabador, /id="gr-sel-indicador"/);
  // El grabador (navegador) solo importa los textos, sin la lógica ni la base.
  assert.doesNotMatch(grabador, /estadoConsentimiento'/);
  assert.doesNotMatch(leer('./etiquetaConsentimiento.ts'), /^import /m);
});

test('en lote: si fallan las señales de pareja, nadie sale "firmado" (pero lo que falta se sigue mostrando)', async () => {
  const db = new SupabaseMemoria();
  db.tabla('consents').push(
    { ...fila({ signer_name: 'Camila Rojas' }), patient_id: 'p-ok' },
    { ...fila({ signed_at: null }), patient_id: 'p-sin' },
  );
  const cliente = {
    from: (tabla: string) => tabla === 'services_catalog'
      ? { select: async () => ({ data: null, error: { message: 'caída' } }) }
      : db.from(tabla),
  };
  const m = await estadosConsentimientoEnBase([{ id: 'p-ok', name: 'Camila Rojas' }, { id: 'p-sin', name: 'Sofía Paz' }], cliente as never);
  assert.equal(m.has('p-ok'), false);
  assert.equal(m.get('p-sin'), 'sin_firma');
});

test('aviso del panel: solo con sesión vigente (horas anuladas no cuentan)', async () => {
  const { tieneSesionVigente } = await import('./etiquetaConsentimiento');
  const vigentes = new Set(['diego@x.cl']);
  assert.equal(tieneSesionVigente('Diego@X.cl ', vigentes), true);
  assert.equal(tieneSesionVigente('edinson@x.cl', vigentes), false);
  assert.equal(tieneSesionVigente(null, vigentes), false);
});
