// Grabador presencial (grabar.astro): auditoría del 17 oct 2026. Funciones puras de grabador.ts y
// comprobaciones del código de la página (su <script> corre solo en el navegador). Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cuentaComoSilencio, finGrabacionMs, UMBRAL_SILENCIO_RMS } from './grabador';

const PAGINA = readFileSync(new URL('../../pages/admin/grabar.astro', import.meta.url), 'utf8');

test('silencio: solo cuenta con medidor midiendo de verdad (AudioContext running)', () => {
  assert.equal(cuentaComoSilencio(0, true, 'running'), true);
  assert.equal(cuentaComoSilencio(UMBRAL_SILENCIO_RMS / 2, true, 'running'), true);
  assert.equal(cuentaComoSilencio(0.05, true, 'running'), false, 'voz');
  // iOS: AudioContext suspendido o interrumpido → el analizador da ceros aunque MediaRecorder grabe bien.
  assert.equal(cuentaComoSilencio(0, true, 'suspended'), false);
  assert.equal(cuentaComoSilencio(0, true, 'interrupted'), false);
  assert.equal(cuentaComoSilencio(0, true, undefined), false);
  assert.equal(cuentaComoSilencio(0, false, 'running'), false, 'sin fuente conectada');
  assert.match(PAGINA, /cuentaComoSilencio\(rms, !!fuente, audioCtx\?\.state\)/);
});

test('fin_at: el de "terminar"; si Safari se cerró grabando, el fin del último segmento (no la hora de subida)', () => {
  const inicio = Date.parse('2026-10-17T19:00:00Z');
  assert.equal(finGrabacionMs({ inicioMs: inicio, finMs: inicio + 3_000_000, segmentos: [] }), inicio + 3_000_000);
  const abandonada = { inicioMs: inicio, finMs: null, segmentos: [{ inicioMs: inicio + 500, finMs: inicio + 1_200_000 }, { inicioMs: inicio + 1_300_000, finMs: inicio + 2_900_000 }] };
  assert.equal(finGrabacionMs(abandonada), inicio + 2_900_000);
  assert.equal(finGrabacionMs({ inicioMs: inicio, finMs: null, segmentos: [{ inicioMs: inicio + 10, finMs: null }] }), inicio + 10);
  assert.equal(finGrabacionMs({ inicioMs: inicio, finMs: null, segmentos: [] }), inicio);
  assert.match(PAGINA, /fin_at: new Date\(finGrabacionMs\(g\)\)\.toISOString\(\)/);
  assert.doesNotMatch(PAGINA, /g\.finMs \?\? Date\.now\(\)/);
});

test('trozos: el índice es por segmento (un trozo tardío del recorder anterior no pisa la cabecera)', () => {
  assert.doesNotMatch(PAGINA, /trozoIdx/, 'sin contador global compartido entre segmentos');
  assert.match(PAGINA, /let idx = 0;\s*\n(?:\s*\/\/.*\n)*?\s*r\.ondataavailable = \(e\) => \{\s*\n\s*if \(!e\.data \|\| !e\.data\.size\) return;\s*\n\s*const i = idx\+\+/);
  assert.match(PAGINA, /r\.onerror = \(\) => \{ if \(recorder === r\) interrumpir\('ended'\); \}/);
});

test('cerrar segmento dos veces espera el cierre en curso (no da por terminado sin el último trozo)', () => {
  const cuerpo = PAGINA.slice(PAGINA.indexOf('function cerrarSegmento()'), PAGINA.indexOf('async function empezarGrabacion()'));
  const guarda = cuerpo.indexOf('if (!r && !seg) return cierreEnCurso;');
  assert.ok(guarda > 0, 'falta la guarda');
  assert.ok(guarda < cuerpo.indexOf('recorder = null; segActual = null;'), 'la guarda va antes de soltar el recorder');
});

test('subida: si cambió el tamaño se recalculan las partes y el sha256', () => {
  assert.match(PAGINA, /let n = Math\.ceil\(s\.bytes! \/ PARTE\);/);
  assert.match(PAGINA, /if \(blob\.size !== s\.bytes\) \{[^\n]*s\.sha256 = null; n = Math\.ceil\(blob\.size \/ PARTE\); \}/);
});

test('subida: un pedido durante otra vuelta no se pierde (se repite al terminar)', () => {
  assert.match(PAGINA, /if \(subiendo\) \{ otraVuelta = true; return; \}/);
  assert.match(PAGINA, /if \(otraVuelta\) \{ otraVuelta = false; setTimeout\(subirPendientes, 0\); return; \}/);
  assert.doesNotMatch(PAGINA, /if \(subiendo \|\| D\.demo\) return;/);
  // "Grabar otra sesión" durante la subida ya no es un botón muerto.
  assert.match(PAGINA, /irAOtra = true;/);
  assert.match(PAGINA, /if \(irAOtra\) \{ location\.href = '\/admin\/grabar'; return; \}/);
});

test('estado "error" del servidor: no promete reintento automático (ya se agotaron)', () => {
  assert.doesNotMatch(PAGINA, /Hubo un problema al procesar\. Se reintentará sola/);
  assert.match(PAGINA, /if \(e === 'error'\) \{[^\n]*toca Reintentar/);
  assert.match(PAGINA, /if \(e === 'cancelada'\)/);
});
