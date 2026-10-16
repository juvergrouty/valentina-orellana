// Pruebas de las utilidades puras del panel (P7). Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claveDeEtiqueta, costoMes, duracionTexto, estadoVisible, fechaLarga, fusionarMapaHablantes, lineasTranscripcion,
  nombreHablante, normalizarNombresVale, porcentajeTope, resumenAHtml, resumenATexto, sePuedeReintentar,
  textoProblema, validarAjuste,
} from './panel';
import { ESTADOS } from './tipos';
import { HABLANTE_SIN_SEPARAR } from './hablantes';

test('todo estado tiene texto y tono; solo error y sin_audio son "con problema"', () => {
  for (const e of ESTADOS) {
    const v = estadoVisible(e);
    assert.ok(v.texto.length > 0, e);
    assert.equal(v.tono === 'problema', e === 'error' || e === 'sin_audio', e);
  }
  assert.equal(estadoVisible('lista').tono, 'listo');
  assert.equal(estadoVisible('transcribiendo').tono, 'proceso');
  assert.equal(estadoVisible('inventado').tono, 'neutro');
});

test('textoProblema no expone el error técnico y orienta según dónde falló', () => {
  assert.match(textoProblema({ estado: 'error', estado_antes_error: 'resumiendo' })!, /resumen no se pudo generar/);
  assert.match(textoProblema({ estado: 'error', estado_antes_error: 'transcribiendo' })!, /transcribir/);
  assert.match(textoProblema({ estado: 'sin_audio', estado_antes_error: null })!, /sin audio/);
  assert.equal(textoProblema({ estado: 'lista', estado_antes_error: null }), null);
  assert.equal(sePuedeReintentar({ estado: 'error', estado_antes_error: 'resumiendo' }), true);
  assert.equal(sePuedeReintentar({ estado: 'error', estado_antes_error: null }), false);
  assert.equal(sePuedeReintentar({ estado: 'lista', estado_antes_error: null }), false);
});

test('fechas y duraciones legibles', () => {
  assert.equal(fechaLarga('2026-10-15'), 'jueves 15 de octubre de 2026');
  assert.equal(duracionTexto(3012), '50 min');
  assert.equal(duracionTexto(3900), '1 h 05 min');
  assert.equal(duracionTexto(40), '40 s');
  assert.equal(duracionTexto(null), '');
});

test('resumenAHtml escapa todo lo que viene del modelo', () => {
  const html = resumenAHtml('## Resumen automático (IA)\n### Temas <script>alert(1)</script>\n- <img src=x onerror=alert(1)> dijo «hola» [12:30]\n');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('Resumen automático (IA)'), 'el título lo pone la tarjeta');
});

test('resumenAHtml: secciones, viñetas, negrita, línea de datos y minutos enlazados', () => {
  const md = '## Resumen automático (IA)\n*Sesión individual · 15 oct 2026*\n\n### Atención\n- Mencionó **ideas** de muerte «a veces pienso» [23:40]\n\n### Tareas y acuerdos\n1. Registro diario\n';
  const html = resumenAHtml(md, (s) => `/x?t=${s}#t`);
  assert.match(html, /<p class="ia-meta">Sesión individual · 15 oct 2026<\/p>/);
  assert.match(html, /<h4>Atención<\/h4>/);
  assert.ok(!/class="[^"]*(alerta|riesgo|rojo)/.test(html), 'Atención sin estilos de alarma');
  assert.match(html, /<strong>ideas<\/strong>/);
  assert.match(html, /<a class="ia-min" href="\/x\?t=1420#t">\[23:40\]<\/a>/);
  assert.equal((html.match(/<ul>/g) ?? []).length, 2);
  assert.match(html, /<li>Registro diario<\/li>/);
});

test('resumenATexto deja texto plano para copiar a la nota', () => {
  const t = resumenATexto('## Resumen automático (IA)\n*Datos*\n\n### Puntos clave\n- Uno **fuerte**\n');
  assert.equal(t, 'Datos\n\nPUNTOS CLAVE\n• Uno fuerte');
});

test('claves de hablante coinciden con las de hablantes.ts (P2)', () => {
  assert.equal(claveDeEtiqueta('Hablante A'), 'A');
  assert.equal(claveDeEtiqueta('Hablante B (parte 2)'), '2-B');
  assert.equal(claveDeEtiqueta('Camila R.'), 'Camila R.');
  assert.equal(nombreHablante('Hablante A', { A: 'Ps. Valentina' }), 'Ps. Valentina');
  assert.equal(nombreHablante('Hablante B (parte 2)', { '2-B': 'Camila' }), 'Camila');
  assert.equal(nombreHablante('Camila R.', { 'Camila R.': 'Camila' }), 'Camila');
  assert.equal(nombreHablante('Hablante C', { A: 'X' }), 'Hablante C');
  assert.equal(nombreHablante(HABLANTE_SIN_SEPARAR, { [HABLANTE_SIN_SEPARAR]: 'X' }), HABLANTE_SIN_SEPARAR);
});

test('fusionarMapaHablantes valida, recorta y borra con nombre vacío', () => {
  const r = fusionarMapaHablantes({ A: 'Vale', B: 'Pac' }, { B: '  Camila  <b>', A: '' });
  assert.deepEqual(r, { ok: true, valor: { B: 'Camila b' } });
  assert.equal(fusionarMapaHablantes(null, {}).ok, false);
  assert.equal(fusionarMapaHablantes(null, ['x']).ok, false);
  assert.equal(fusionarMapaHablantes(null, { A: 'x'.repeat(61) }).ok, false);
  assert.equal(fusionarMapaHablantes(null, { [HABLANTE_SIN_SEPARAR]: 'x' }).ok, false);
  assert.equal(fusionarMapaHablantes(null, { A: 3 }).ok, false);
});

test('nombres de Vale en Meet', () => {
  assert.deepEqual(normalizarNombresVale(' Valentina Orellana | Vínculos que sostienen \nValentina Orellana'), { ok: true, valor: 'Valentina Orellana|Vínculos que sostienen' });
  assert.equal(normalizarNombresVale('').ok, false);
  assert.equal(normalizarNombresVale('a|b|c|d|e|f|g'.replace(/(\w)/g, '$1$1')).ok, false);
  assert.equal(normalizarNombresVale(5).ok, false);
});

test('validarAjuste solo deja los 3 ajustes del transcriptor', () => {
  assert.deepEqual(validarAjuste('transcriptor_activo', true), { ok: true, valor: { clave: 'transcriptor_activo', valor: 'true' } });
  assert.deepEqual(validarAjuste('transcriptor_bot_activo', 'false'), { ok: true, valor: { clave: 'transcriptor_bot_activo', valor: 'false' } });
  assert.equal(validarAjuste('transcriptor_alerta_riesgo', 'true').ok, false);
  assert.equal(validarAjuste('admin_tokens_revocados', '[]').ok, false);
  assert.equal(validarAjuste('transcriptor_activo', 'si').ok, false);
  assert.equal(validarAjuste('transcriptor_bot_nombres_vale', 'Valentina Orellana').ok, true);
});

test('costoMes con precios de 50-arquitectura §8 + IVA', () => {
  const c = costoMes({
    segmentos: [
      { audioSeg: 3600, modelo: 'universal-2', diarizacion: false },
      { audioSeg: 3600, modelo: 'universal-3-5-pro', diarizacion: true },
    ],
    usdResumenes: 0.05, usdPreguntas: 0.01, botDuraciones: [], usdClp: 950,
  });
  assert.ok(Math.abs(c.usd.transcripcion - 0.38) < 1e-9);
  assert.ok(Math.abs(c.usd.total - 0.44) < 1e-9);
  assert.equal(c.clp.total, Math.round(0.44 * 950 * 1.19));
  const b = costoMes({ segmentos: [], usdResumenes: 0, usdPreguntas: 0, botDuraciones: [3000], usdClp: 950 });
  assert.ok(b.usd.bot > 0 && b.clp.bot >= 0);
  assert.equal(porcentajeTope(17500, 35000), 50);
  assert.equal(porcentajeTope(1, 0), 0);
});

test('lineasTranscripcion intercala pausas y aplica nombres', () => {
  const l = lineasTranscripcion(
    [{ inicio_ms: 0, fin_ms: 5000, hablante: 'Hablante A', texto: 'Hola' }, { inicio_ms: 200000, fin_ms: 205000, hablante: 'Hablante B', texto: 'Sí' }],
    [{ desde_ms: 100000, hasta_ms: 220000 }],
    { A: 'Ps. Valentina' },
  );
  assert.deepEqual(l.map((x) => [x.tipo, x.marca, x.hablante ?? null]), [['tramo', '00:00', 'Ps. Valentina'], ['pausa', '01:40', null], ['tramo', '03:20', 'Hablante B']]);
  assert.match(l[1].texto, /2 min/);
});
