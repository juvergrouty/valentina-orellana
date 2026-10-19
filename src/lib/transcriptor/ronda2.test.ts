// Pruebas de la ronda 2 del transcriptor presencial (18 oct 2026), un bloque por punto. Sin red.
// Correr: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';
import { evaluarEnBase, verificarGrabacion } from './consentimiento';
import { ajustePermitidoSinPasskey } from './panel';
import {
  arregloBloqueo, cerrarSegmentoCortado, claveReutilizar, DATOS_SIN_INTERNET, esRetomable, etiquetaBloqueo,
  localYaEnServidor, RETOMAR_MAX_MS,
} from './grabadorDatos';

const RAIZ = join(import.meta.dirname, '..', '..', '..');
const leer = (...p: string[]) => readFileSync(join(RAIZ, ...p), 'utf8');
const AHORA = Date.parse('2026-10-18T19:30:00Z');

// ─── 1. Retomar sin internet ─────────────────────────────────────────────────

test('1: solo se retoma una grabación cortada en plena sesión, sin otra pestaña, reciente', () => {
  const g = (p: Record<string, unknown> = {}) => ({ estado: 'grabando', inicioMs: AHORA - 40 * 60_000, vivoMs: AHORA - 5 * 60_000, segmentos: [{ seq: 0, inicioMs: AHORA - 40 * 60_000, finMs: null }], ...p });
  assert.equal(esRetomable(g(), true, AHORA), true);
  assert.equal(esRetomable(g(), false, AHORA), false, 'otra pestaña la tiene (Web Lock)');
  assert.equal(esRetomable(g({ estado: 'terminada' }), true, AHORA), false, 'terminada: se sube, no se sigue');
  assert.equal(esRetomable(g({ vivoMs: AHORA - RETOMAR_MAX_MS - 1 }), true, AHORA), false, 'muy vieja: ya no es la misma sesión');
  assert.equal(esRetomable(g({ vivoMs: undefined, inicioMs: AHORA - 60_000 }), true, AHORA), true, 'sin latido usa el inicio');
});

test('1: al seguir, el segmento cortado se cierra con su último trozo y el seq continúa', () => {
  const g = { estado: 'grabando', inicioMs: 1000, segmentos: [{ seq: 0, inicioMs: 1000, finMs: 5000 }, { seq: 1, inicioMs: 6000, finMs: null as number | null }] };
  assert.equal(cerrarSegmentoCortado(g, [16000, 26000, 21000]), 2);
  assert.equal(g.segmentos[1].finMs, 26000);
  const vacio = { estado: 'grabando', inicioMs: 1000, segmentos: [{ seq: 0, inicioMs: 1000, finMs: null as number | null }] };
  assert.equal(cerrarSegmentoCortado(vacio, []), 1);
  assert.equal(vacio.segmentos[0].finMs, 1000, 'sin trozos: dura 0 y no se sube');
});

test('1: la página estática no lleva datos de pacientes y no puede crear grabaciones', () => {
  assert.deepEqual([DATOS_SIN_INTERNET.ventana, DATOS_SIN_INTERNET.otras, DATOS_SIN_INTERNET.pacientes, DATOS_SIN_INTERNET.recientes], [[], [], [], []]);
  assert.equal(DATOS_SIN_INTERNET.sinInternet, true);
  const comp = leer('src', 'components', 'admin', 'Grabador.astro');
  // Sin internet no se prepara ni se sube nada: solo retomar (gid ya autorizado) y volver al grabador con red.
  assert.match(comp, /if \(D\.sinInternet\) \{ iniciarSinInternet\(\); return; \}/);
  assert.match(comp, /if \(D\.sinInternet\) \{ pintarSinInternet\(\); return; \}/);
  assert.match(comp, /const volver = \(\) => \{ if \(modo === 'listo' \|\| modo === 'subir'\) location\.replace\('\/admin\/grabar'\); \};/, 'nunca recarga en plena grabación');
  // Retomar sigue la MISMA grabación: no llama a grabacion-iniciar.
  const retomar = comp.slice(comp.indexOf('async function retomar('), comp.indexOf('function tarjetaRetomar('));
  assert.doesNotMatch(retomar, /grabacion-iniciar|postJson|fetch\(/);
  assert.match(retomar, /abandonada\(x\)/); // registro releído de IndexedDB (19 oct)
});

// ─── 2. Menores: fecha de nacimiento obligatoria (presencial y robot) ────────

test('2: en la base, ficha sin fecha de nacimiento → se graba (no excluyente); menor de edad no', async () => {
  const db = new SupabaseMemoria();
  const p = randomUUID();
  db.tabla('settings').push({ key: 'transcriptor_activo', value: 'true' });
  db.tabla('patients').push({ id: p, name: 'Camila Rojas', email: 'camila@ejemplo.cl', birthdate: null, rut: '12.345.678-5' });
  db.tabla('consents').push({ id: randomUUID(), patient_id: p, version: '2026-10-v3', signed_at: '2026-10-10T12:00:00Z', signer_name: 'Camila Rojas', signer_rut: '12.345.678-5', accept_recording: true, revoked_at: null });
  const v = await verificarGrabacion(p, 'individual', db.cliente);
  assert.equal(v.puede, true);
  db.tabla('patients')[0].birthdate = '1991-03-02';
  assert.equal((await evaluarEnBase(p, 'individual', db.cliente)).puede, true);
  db.tabla('patients')[0].birthdate = '2010-03-02';
  assert.equal((await evaluarEnBase(p, 'individual', db.cliente)).motivo, 'menor_de_edad');
});

test('2: el grabador dice qué hacer y lleva al campo de la ficha', () => {
  assert.equal(etiquetaBloqueo('sin_fecha_nacimiento'), 'Falta la fecha de nacimiento en la ficha');
  const a = arregloBloqueo('sin_fecha_nacimiento', 'p1');
  assert.deepEqual([a.href, a.etiqueta, a.reintentar], ['/admin/pacientes/p1?tab=info#pf-nacimiento', 'Completar la ficha', true]);
  assert.equal(arregloBloqueo('menor_de_edad', 'p1').href, null, 'menor: no hay nada que enviar');
  assert.equal(arregloBloqueo('sin_consentimiento', 'p1').etiqueta, 'Enviar consentimiento');
  assert.match(leer('src', 'pages', 'admin', 'pacientes', '[id].astro'), /id="pf-nacimiento"/);
  // Robot: la nota de la grabación no enviada dice el motivo real.
  assert.match(leer('src', 'lib', 'transcriptor', 'pipeline.ts'), /nota_sistema: v\.puede \? null : notaRobotSinPermiso\(v\.motivo\)/);
});

// ─── 3. Passkey en asignar, ajustes e instrucciones ──────────────────────────

test('3: asignar, ajustes e instrucciones exigen sesión con passkey (ajustes: salvo apagar)', () => {
  for (const r of ['asignar', 'ajustes', 'instrucciones']) {
    assert.match(leer('src', 'pages', 'api', 'admin', 'transcriptor', `${r}.ts`), /exigirAccesoClinico\(ctx, '/, r);
  }
  assert.equal(ajustePermitidoSinPasskey('transcriptor_activo', 'false'), true);
  assert.equal(ajustePermitidoSinPasskey('transcriptor_bot_activo', 'false'), true);
  assert.equal(ajustePermitidoSinPasskey('transcriptor_activo', 'true'), false);
  assert.equal(ajustePermitidoSinPasskey('transcriptor_bot_nombres_vale', 'false'), false);
  const ui = leer('src', 'pages', 'admin', 'transcriptor.astro');
  assert.match(ui, /d\.motivo === 'passkey'/);
  assert.match(ui, /id="tx-sin-passkey"/);
});

// ─── 4. Agenda: "Grabar" solo en presenciales (online la graba el asistente) ─

test('4: la agenda oculta "Grabar" en reservas online y explica cómo crear el Meet si falta', () => {
  const a = leer('src', 'pages', 'admin', 'agenda.astro');
  assert.match(a, /grabarBtn\.style\.display = esHoy && !isOnlineSession \? '' : 'none';/);
  assert.match(a, /id="sp-grabar-sin-meet"/);
  assert.match(a, /grabarSinMeet\.style\.display = onlineSinMeet/);
  // Los eventos de Google (panel gp-) siguen igual.
  assert.match(a, /id="gp-btn-grabar"/);
});

// ─── 5. Textos: sin voz ──────────────────────────────────────────────────────

test('5: con "lista" sin resumen el grabador NO dice "El resumen está en la ficha"', () => {
  const comp = leer('src', 'components', 'admin', 'Grabador.astro');
  assert.match(comp, /const sinVoz = e === 'lista' && resumen === false;/);
  assert.match(comp, /No se reconoció voz; revisa|No se reconoció voz\. Revisa el aviso en el panel/);
  assert.match(leer('src', 'pages', 'api', 'admin', 'transcriptor', 'grabacion-finalizar.ts'), /resumenes_ia'\)\.select\('id'\)\.eq\('grabacion_id', id\)\.eq\('estado', 'listo'\)/);
});

// ─── 6. Dos dispositivos ─────────────────────────────────────────────────────

test('6: cada dispositivo reutiliza solo su preparación; sin `reutilizar` se crea una grabación nueva', () => {
  assert.equal(claveReutilizar('r:abc', '2026-10-18'), 'vo-grabar-prep:2026-10-18:r:abc');
  const ini = leer('src', 'pages', 'api', 'admin', 'transcriptor', 'grabacion-iniciar.ts');
  assert.match(ini, /body\.nueva === true \|\| !reutilizar \? \{ data: null, error: null \}/);
  assert.match(ini, /\.eq\('id', reutilizar/);
});

test('6: "ya cerrada" solo borra el audio local si lo del servidor es lo mismo', () => {
  const locales = [{ seq: 0, bytes: 100, sha256: 'a' }, { seq: 1, bytes: 50, sha256: null }];
  assert.equal(localYaEnServidor(locales, [{ seq: 0, bytes: 100, sha256: 'a' }, { seq: 1, bytes: 50, sha256: 'z' }]), true, 'mismo dispositivo (respuesta perdida)');
  assert.equal(localYaEnServidor(locales, [{ seq: 0, bytes: 100, sha256: 'a' }]), false, 'otro dispositivo subió menos');
  assert.equal(localYaEnServidor(locales, [{ seq: 0, bytes: 999, sha256: 'a' }, { seq: 1, bytes: 50, sha256: null }]), false, 'otro audio');
  assert.equal(localYaEnServidor([{ seq: 0, bytes: 100, sha256: 'a' }], [{ seq: 0, bytes: 100, sha256: 'b' }]), false, 'misma talla, otra huella');
  assert.equal(localYaEnServidor([], []), true, 'sin audio local: nada que perder');
  const sub = leer('src', 'pages', 'api', 'admin', 'transcriptor', 'subida-url.ts');
  assert.match(sub, /ya_finalizada: true, estado: g\.estado, segmentos: subidos \?\? \[\]/);
  assert.match(sub, /motivo: 'otro_dispositivo'/);
});

// ─── 7. Documento de seguridad ───────────────────────────────────────────────

test('7: 30-seguridad dice que las transcripciones son ficha y no se suprimen; solo el audio se borra', () => {
  const d = leer('docs', 'transcriptor', '30-seguridad.md');
  assert.match(d, /\*\*no se suprimen\*\*/);
  assert.match(d, /\*\*Solo el audio se borra\*\*/);
  assert.doesNotMatch(d, /Botón "Borrar transcripción"/);
});

// ─── 8. Los GET no cierran avisos ────────────────────────────────────────────

test('8: GET de alertas y la página accion.astro solo leen; cerrar es un POST explícito', () => {
  const api = leer('src', 'pages', 'api', 'admin', 'transcriptor', 'alertas.ts');
  const get = api.slice(api.indexOf('export const GET'));
  assert.doesNotMatch(get, /cerrarAlerta|resolver/);
  assert.match(get, /superada/);
  const accion = leer('src', 'pages', 'admin', 'transcriptor', 'accion.astro');
  const fm = accion.slice(0, accion.indexOf('\n---', 5));
  assert.doesNotMatch(fm, /cerrarAlerta\(/);
  assert.match(accion, /data-accion="revisar"/);
  assert.match(leer('src', 'components', 'admin', 'AlertasTranscriptor.astro'), /accion: 'revisar'/);
});
