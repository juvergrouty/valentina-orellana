// Pulido del transcriptor presencial (19 oct 2026, rama presencial-pulido). Sin red.
//   · Lista "grabaciones sin subir": el texto corresponde al estado real (errores definitivos).
//   · Seguir CON internet la misma sesión si iOS descartó la pestaña (una sesión = una transcripción).
// Las rutas reales (GET grabacion-finalizar?verificar=1, mismo gid con seq que sigue) están en
// presencialRutas.test.ts. Correr: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decidirSeguir, destinoPendiente, RETOMAR_MAX_MS, textoSinSubir } from './grabadorDatos';

const RAIZ = join(import.meta.dirname, '..', '..', '..');
const comp = readFileSync(join(RAIZ, 'src', 'components', 'admin', 'Grabador.astro'), 'utf8');
const AHORA = Date.parse('2026-10-19T19:30:00Z');
const g = (p: Record<string, unknown> = {}) => ({ estado: 'grabando', inicioMs: AHORA - 30 * 60_000, vivoMs: AHORA - 4 * 60_000, segmentos: [{ seq: 0, inicioMs: AHORA - 30 * 60_000, finMs: null }], ...p });

// ─── Lista "sin subir" ───────────────────────────────────────────────────────

test('sin subir: con un error definitivo no dice "Se está subiendo sola"', () => {
  assert.equal(textoSinSubir(1, 1, true), 'No se pudo subir: abajo está el motivo.');
  assert.equal(textoSinSubir(2, 2, true), 'No se pudieron subir: abajo está el motivo de cada una.');
  assert.doesNotMatch(textoSinSubir(1, 1, true), /subiendo sola/);
  assert.doesNotMatch(textoSinSubir(1, 1, false), /cuando vuelva internet/);
});

test('sin subir: sin errores, el texto de siempre; mezcla, dice cuáles', () => {
  assert.equal(textoSinSubir(1, 0, true), 'Se está subiendo sola.');
  assert.equal(textoSinSubir(1, 0, false), 'Se sube sola cuando vuelva internet.');
  assert.equal(textoSinSubir(3, 0, true), 'Se están subiendo solas.');
  assert.equal(textoSinSubir(2, 1, true), 'Una se está subiendo sola; la otra no se pudo subir (abajo está el motivo).');
  assert.equal(textoSinSubir(3, 1, false), '2 se suben solas cuando vuelva internet; 1 no se pudo subir (abajo está el motivo).');
  assert.equal(textoSinSubir(3, 2, true), 'Una se está subiendo sola; 2 no se pudieron subir (abajo está el motivo).');
  assert.equal(textoSinSubir(0, 0, true), '');
});

test('sin subir: con la sesión del panel vencida (401) tampoco dice que se sube sola', () => {
  assert.equal(textoSinSubir(1, 0, true, true), 'Se sube cuando vuelvas a entrar al panel (tu sesión venció).');
  assert.equal(textoSinSubir(2, 1, true, true), 'Una se sube cuando vuelvas a entrar al panel (tu sesión venció); la otra no se pudo subir (abajo está el motivo).');
  assert.equal(textoSinSubir(1, 0, false, true), 'Se sube sola cuando vuelva internet.', 'sin internet manda el aviso de internet');
});

test('sin subir: el componente usa el texto según los errores definitivos (no el texto fijo de antes)', () => {
  assert.doesNotMatch(comp, /navigator\.onLine \? 'Se está subiendo sola\.'/);
  assert.match(comp, /textoSinSubir\(otras\.length, conError, navigator\.onLine, sesionVencida\)/);
  assert.match(comp, /else sesionVencida = true; continue;/);
  assert.match(comp, /const conError = otras\.filter\(\(g\) => erroresDef\.has\(g\.gid\)\)\.length;/);
});

// ─── Seguir CON internet ─────────────────────────────────────────────────────

test('seguir con internet: una grabación cortada hace < 3 h se ofrece seguir (no se sube sola)', () => {
  assert.equal(destinoPendiente(g(), true, AHORA), 'ofrecer_seguir');
  assert.equal(destinoPendiente(g({ vivoMs: AHORA - RETOMAR_MAX_MS + 1000 }), true, AHORA), 'ofrecer_seguir');
});

test('seguir con internet: si no aplica, todo sigue como antes', () => {
  assert.equal(destinoPendiente(g({ vivoMs: AHORA - RETOMAR_MAX_MS - 1 }), true, AHORA), 'subir', 'más de 3 h: se sube tal cual');
  assert.equal(destinoPendiente(g({ estado: 'terminada' }), false, AHORA), 'subir', 'terminada (o "No seguir"): se sube');
  assert.equal(destinoPendiente(g(), false, AHORA), 'ninguno', 'la tiene esta u otra pestaña: no se toca');
  assert.equal(destinoPendiente(g({ segmentos: Array.from({ length: 1000 }, (_, i) => ({ seq: i, inicioMs: 0, finMs: 1 })) }), true, AHORA), 'subir', 'sin segmentos libres: se sube');
});

test('seguir con internet: el servidor decide (grabación abierta + consentimiento vigente)', () => {
  assert.equal(decidirSeguir({ ok: true, acepta_audio: true, puede_grabar: true }), 'seguir');
  assert.equal(decidirSeguir({ ok: true, acepta_audio: false, puede_grabar: false }), 'no_acepta');
  assert.equal(decidirSeguir({ ok: true, acepta_audio: true, puede_grabar: false, error: 'x' }), 'sin_consentimiento');
  // Sin respuesta (red inestable, 401, 503): como sin internet; subida-url y finalizar verifican igual.
  assert.equal(decidirSeguir(null), 'seguir');
  assert.equal(decidirSeguir({ ok: false }), 'seguir');
});

test('seguir con internet: el componente no sube lo que ofrece seguir, pregunta solo con GET y "No seguir" sube como antes', () => {
  const subir = comp.slice(comp.indexOf('async function subirPendientes('), comp.indexOf("$('gr-reintentar-subida').addEventListener"));
  assert.match(subir, /destinoPendiente\(g, g\.estado === 'grabando' && await abandonada\(g\), ahora\)/);
  assert.match(subir, /if \(d === 'subir'\) lista\.push\(g\);\s*else if \(d === 'ofrecer_seguir'\) seguir\.push\(g\);/);
  // La verificación es de solo lectura y NO crea otra grabación: misma gid, seq que sigue (retomar de la ronda 2).
  const ver = comp.slice(comp.indexOf('async function verificarSeguir('), comp.indexOf('async function noSeguir('));
  assert.match(ver, /grabacion-finalizar\?id=\$\{encodeURIComponent\(gid\)\}&verificar=1/);
  assert.doesNotMatch(ver, /grabacion-iniciar|method: 'POST'/);
  const retomar = comp.slice(comp.indexOf('async function retomar('), comp.indexOf('function tarjetaRetomar('));
  assert.match(retomar, /if \(!D\.sinInternet && !D\.demo && navigator\.onLine\)/);
  assert.match(retomar, /cerrarSegmentoCortado\(g, tiempos\)/);
  assert.doesNotMatch(retomar, /grabacion-iniciar/);
  const no = comp.slice(comp.indexOf('async function noSeguir('), comp.indexOf('async function pintarRetomarRed('));
  assert.match(no, /g\.estado = 'terminada';[\s\S]*subirPendientes\(\)/);
  assert.match(comp, /No seguir: subir lo grabado/);
  // Empezar otra grabación = no seguir la cortada (se sube como antes).
  const empezar = comp.slice(comp.indexOf('async function empezarGrabacion('), comp.indexOf('function tomarLock('));
  assert.match(empezar, /for \(const g of ofrecidas\) \{ g\.estado = 'terminada';/);
  // La página sin internet (pública) sigue sin nombres de pacientes en la tarjeta.
  assert.match(comp, /conRed \? `La grabación de \$\{g\.nombre\}/);
  assert.match(comp, /tarjetaRetomar\(g, hasta\)\)/);
});
