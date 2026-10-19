// Pruebas del chequeo de consentimiento para grabar (P4). Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { edadEn, esVersionGrabacion, evaluarConsentimientos, identidadFirmante, numeroVersion, type FilaConsentimiento } from './consentimiento';

const HOY = '2026-10-16';
let n = 0;
const fila = (p: Partial<FilaConsentimiento>): FilaConsentimiento => ({
  id: `c${++n}`, version: '2026-11-v3', signed_at: '2026-10-10T12:00:00Z', signer_name: 'Camila Rojas',
  signer_rut: '12.345.678-5', signer_email: null, accept_recording: true, revoked_at: null, ...p,
});
const evaluar = (tipo: 'individual' | 'pareja' | 'sin_tipo', filas: FilaConsentimiento[], fechaNacimiento: string | null = '1990-05-05') =>
  evaluarConsentimientos({ patientId: 'p1', tipo, fechaNacimiento, filas, hoy: HOY });

test('versiones (decisión de Vale 19 oct): v1, v2, v3 y posteriores sirven para grabar', () => {
  assert.equal(numeroVersion('2026-10-v2'), 2);
  assert.equal(numeroVersion('2026-11-v3'), 3);
  assert.equal(numeroVersion('raro'), null);
  assert.equal(esVersionGrabacion('2026-10-v1'), true);
  assert.equal(esVersionGrabacion('2026-10-v2'), true);
  assert.equal(esVersionGrabacion('2026-11-v3'), true);
  assert.equal(esVersionGrabacion('2027-03-v4'), true);
  assert.equal(esVersionGrabacion(null), false);
});

// v4 corta (17 oct): la versión que firman los pacientes nuevos también habilita grabar, y las
// firmas v2/v3 previas siguen valiendo. Se lee CONSENT_VERSION del archivo (consent.ts importa
// supabase, que exige variables de entorno) para que la prueba falle si la versión vigente no cuenta.
test('v4 vigente (consent.ts) habilita grabar; v2 y v3 ya firmadas siguen valiendo', () => {
  const fuente = readFileSync(new URL('../consent.ts', import.meta.url), 'utf8');
  const vigente = /export const CONSENT_VERSION = '([^']+)'/.exec(fuente)?.[1];
  assert.equal(vigente, '2026-10-v4');
  assert.equal(numeroVersion(vigente), 4);
  assert.equal(esVersionGrabacion(vigente), true);
  assert.equal(evaluar('individual', [fila({ version: vigente })]).puede, true);
  assert.equal(evaluar('individual', [fila({ version: vigente, accept_recording: false })]).puede, false);
  for (const v of ['2026-10-v2', '2026-10-v3']) assert.equal(evaluar('individual', [fila({ version: v })]).puede, true, v);
  // Pareja con firmas de distinta versión (v3 previa + v4 nueva): ambas cuentan.
  assert.equal(evaluar('pareja', [fila({ version: '2026-10-v3' }), fila({ version: vigente, signer_rut: '9.876.543-2', signer_name: 'Diego Pérez' })]).puede, true);
});

test('individual con v3 firmada y grabación autorizada → puede', () => {
  const r = evaluar('individual', [fila({})]);
  assert.equal(r.puede, true);
  assert.equal(r.consentIds.length, 1);
});

test('individual con v2 y accept_recording=true → puede (decisión 9)', () => {
  const r = evaluar('individual', [fila({ version: '2026-10-v2' })]);
  assert.equal(r.puede, true);
  assert.equal(r.consentIds.length, 1);
});

test('individual con v2 sin autorizar grabación → sin_consentimiento; v2 revocada → revocado', () => {
  const r = evaluar('individual', [fila({ version: '2026-10-v2', accept_recording: false })]);
  assert.deepEqual([r.puede, r.motivo], [false, 'sin_consentimiento']);
  assert.equal(evaluar('individual', [fila({ version: '2026-10-v2', revoked_at: '2026-10-14T00:00:00Z' })]).motivo, 'revocado');
});

test('individual solo con v1 y grabación autorizada → puede (pacientes antiguos, decisión de Vale 19 oct)', () => {
  const r = evaluar('individual', [fila({ version: '2026-10-v1' })]);
  assert.equal(r.puede, true);
  assert.equal(evaluar('individual', [fila({ version: '2026-10-v1', accept_recording: false })]).motivo, 'sin_consentimiento');
});

test('revisión 8112bc1: el motivo version_antigua ya no aparece para firmas con grabación autorizada (v1, sin versión o versión rara)', () => {
  for (const version of ['2026-10-v1', 'v1', null, 'raro', '']) {
    const r = evaluar('individual', [fila({ version })]);
    assert.equal(r.puede, true, `versión ${String(version)}`);
    assert.notEqual(r.motivo, 'version_antigua');
  }
  // Pareja: v1 + v1, ambas con grabación autorizada → se graba; ninguna combinación da version_antigua.
  const par = evaluar('pareja', [fila({ version: '2026-10-v1' }), fila({ signer_rut: '9.876.543-2', version: '2026-10-v1' })]);
  assert.equal(par.puede, true);
  assert.equal(par.firmantes.length, 2);
  // Una sola v1 en pareja → falta la segunda firma (no "versión antigua").
  assert.equal(evaluar('pareja', [fila({ version: '2026-10-v1' })]).motivo, 'falta_segunda_firma');
  // Retiro de solo la grabación en una v1 → revocado.
  assert.equal(evaluar('individual', [fila({ version: '2026-10-v1', recording_revoked_at: '2026-10-18T00:00:00Z' })]).motivo, 'revocado');
});

test('textos de bloqueo: ninguno habla de "versión" ni de v1/v2 (decisión de Vale 19 oct)', () => {
  const fuente = readFileSync(new URL('./consentimiento.ts', import.meta.url), 'utf8');
  const cuerpo = fuente.slice(fuente.indexOf('export function textoMotivo'), fuente.indexOf('// ─── Con base de datos'));
  assert.doesNotMatch(cuerpo, /versi[oó]n que firm|consentimiento actual|\bv[12]\b/i);
});

test('v2 antigua + v3 nueva de la misma persona → vale la última', () => {
  const r = evaluar('individual', [
    fila({ version: '2026-10-v1', signed_at: '2026-10-01T00:00:00Z' }),
    fila({ version: '2026-11-v3', signed_at: '2026-11-01T00:00:00Z', signer_rut: '12345678-5' }),
  ]);
  assert.equal(r.puede, true);
});

test('sin firmas o sin ficha', () => {
  assert.equal(evaluar('individual', []).motivo, 'sin_consentimiento');
  assert.equal(evaluar('individual', [fila({ signed_at: null })]).motivo, 'sin_consentimiento');
  assert.equal(evaluarConsentimientos({ patientId: null, tipo: 'individual', fechaNacimiento: null, filas: [fila({})], hoy: HOY }).motivo, 'sin_ficha');
});

test('revocada → revocado; última firma sin autorizar grabación → sin_consentimiento', () => {
  assert.equal(evaluar('individual', [fila({ revoked_at: '2026-10-12T00:00:00Z' })]).motivo, 'revocado');
  const r = evaluar('individual', [
    fila({ signed_at: '2026-10-01T00:00:00Z' }),
    fila({ signed_at: '2026-10-05T00:00:00Z', accept_recording: false }),
  ]);
  assert.deepEqual([r.puede, r.motivo], [false, 'sin_consentimiento']);
});

test('pareja: una sola persona firmó → falta_segunda_firma; dos personas → puede', () => {
  assert.equal(evaluar('pareja', [fila({})]).motivo, 'falta_segunda_firma');
  // Dos filas de la MISMA persona no cuentan como dos firmas.
  assert.equal(evaluar('pareja', [fila({}), fila({ signer_rut: '12345678-5', signed_at: '2026-10-11T00:00:00Z' })]).motivo, 'falta_segunda_firma');
  const r = evaluar('pareja', [fila({}), fila({ signer_name: 'Diego Pérez', signer_rut: '9.876.543-2' })]);
  assert.equal(r.puede, true);
  assert.deepEqual(r.firmantes, ['Camila Rojas', 'Diego Pérez']);
  assert.equal(r.consentIds.length, 2);
});

test('pareja: v3 + v2 con grabación autorizada → puede; segunda v1 autorizada → puede; revocó → revocado', () => {
  assert.equal(evaluar('pareja', [fila({}), fila({ signer_rut: '9.876.543-2', version: '2026-10-v2' })]).puede, true);
  assert.equal(evaluar('pareja', [fila({}), fila({ signer_rut: '9.876.543-2', version: '2026-10-v1' })]).puede, true);
  assert.equal(evaluar('pareja', [fila({}), fila({ signer_rut: '9.876.543-2', version: '2026-10-v2', accept_recording: false })]).motivo, 'sin_consentimiento');
  assert.equal(evaluar('pareja', [fila({}), fila({ signer_rut: '9.876.543-2', revoked_at: '2026-10-13T00:00:00Z' })]).motivo, 'revocado');
});

test('ficha con dos personas: si una no autorizó la grabación, tampoco se graba eligiendo individual', () => {
  const r = evaluar('individual', [fila({}), fila({ signer_rut: '9.876.543-2', version: '2026-10-v1', accept_recording: false })]);
  assert.equal(r.puede, false);
});

test('menores de 18 nunca se graban (aunque tengan firma)', () => {
  assert.equal(evaluar('individual', [fila({})], '2010-01-01').motivo, 'menor_de_edad');
  assert.equal(evaluar('individual', [fila({})], '2008-10-17').motivo, 'menor_de_edad'); // cumple 18 mañana
  assert.equal(evaluar('individual', [fila({})], '2008-10-16').puede, true);            // cumple 18 hoy
  assert.equal(evaluar('individual', [fila({})], '16-10-2012').motivo, 'menor_de_edad');
  assert.equal(edadEn('basura', HOY), null);
});

test('sin fecha de nacimiento (o ilegible) SÍ se graba si hay consentimiento (decisión de Vale 18 oct)', async () => {
  const { textoMotivo, enlaceArreglo, notaRobotSinPermiso } = await import('./consentimiento');
  for (const f of [null, '', 'basura', '31-02']) {
    const r = evaluar('individual', [fila({})], f);
    assert.equal(r.puede, true, String(f));
  }
  // Sin firmas, el motivo es el consentimiento, no la fecha.
  assert.equal(evaluar('individual', [], null).motivo, 'sin_consentimiento');
  assert.match(textoMotivo('sin_fecha_nacimiento', 'Ana Soto'), /fecha de nacimiento en la ficha de Ana Soto.*Complétala/);
  assert.deepEqual(enlaceArreglo('sin_fecha_nacimiento', 'p1'), { href: '/admin/pacientes/p1?tab=info#pf-nacimiento', etiqueta: 'Completar la ficha' });
  assert.equal(enlaceArreglo('menor_de_edad', 'p1'), null);
  assert.equal(enlaceArreglo('sin_consentimiento', 'p1')?.etiqueta, 'Enviar consentimiento');
  assert.match(notaRobotSinPermiso('sin_fecha_nacimiento'), /fecha de nacimiento/);
  // Desde el 18 oct la fecha no bloquea: ningún texto puede decir que sin ella no se graba.
  for (const t of [notaRobotSinPermiso('sin_fecha_nacimiento'), textoMotivo('sin_fecha_nacimiento', 'Ana Soto')]) {
    assert.doesNotMatch(t, /sin ella|así que no se graba/i);
    assert.match(t, /si es menor de 18 no se graba/);
  }
  assert.match(notaRobotSinPermiso('sin_consentimiento'), /consentimiento/);
});

test('identidad del firmante: RUT normalizado, luego correo, luego nombre', () => {
  assert.equal(identidadFirmante({ id: 'x', signer_rut: '12.345.678-k', signer_email: null, signer_name: null }), 'rut:12345678K');
  assert.equal(identidadFirmante({ id: 'x', signer_rut: null, signer_email: 'A@B.cl', signer_name: null }), 'correo:a@b.cl');
  assert.equal(identidadFirmante({ id: 'x', signer_rut: null, signer_email: null, signer_name: 'José  Pérez' }), 'nombre:jose perez');
});
