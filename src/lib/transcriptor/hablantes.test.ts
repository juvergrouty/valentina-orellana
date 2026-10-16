// Pruebas de hablantes.ts con fixtures (sin red). Correr: pnpm test:transcriptor
// Los fixtures imitan la forma de GET /v2/transcript/{id} de AssemblyAI (words en ms, speaker A/B/C).
// Texto ficticio, sin datos reales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HABLANTE_NO_IDENTIFICADO, HABLANTE_SIN_SEPARAR,
  armarTranscripcionClara, claveHablante, formatearTiempo, intervalosDesdeLinea, tramosATexto,
  unirPalabras, unirTranscripcion, validarLineaHablantes,
} from './hablantes';
import { normalizarResultado } from './assemblyai';
import type { Grabacion, ResultadoTranscripcion } from './tipos';

type G = Pick<Grabacion, 'origen' | 'tipo' | 'linea_hablantes' | 'mapa_hablantes' | 'pausas'>;

/** Arma un resultado "completed" desde [texto, start, end, speaker?]. */
function res(id: string, palabras: [string, number, number, string?][], durSeg?: number): ResultadoTranscripcion {
  return normalizarResultado({
    id, status: 'completed', text: 'NO SE USA', audio_duration: durSeg ?? Math.ceil((palabras.at(-1)?.[2] ?? 0) / 1000),
    words: palabras.map(([text, start, end, speaker]) => ({ text, start, end, confidence: 0.9, speaker: speaker ?? null })),
  });
}

test('formatearTiempo', () => {
  assert.equal(formatearTiempo(0), '00:00');
  assert.equal(formatearTiempo(65_400), '01:05');
  assert.equal(formatearTiempo(3_725_000), '1:02:05');
});

test('pareja presencial con diarización: A/B/C → tramos con nombres del mapa', () => {
  const g: G = { origen: 'presencial', tipo: 'pareja', linea_hablantes: null, pausas: [], mapa_hablantes: { A: 'Vale', B: 'Paciente 1' } };
  const r = res('t1', [
    ['Hola,', 0, 400, 'A'], ['¿cómo', 450, 700, 'A'], ['están?', 750, 1100, 'A'],
    ['Bien,', 1500, 1800, 'B'], ['gracias.', 1850, 2300, 'B'],
    ['Yo', 2600, 2800, 'C'], ['no', 2850, 3000, 'C'], ['tanto.', 3050, 3400, 'C'],
    ['Cuéntame', 4000, 4500, 'A'], ['más.', 4550, 4900, 'A'],
  ]);
  const tramos = unirTranscripcion({ grabacion: g, segmentos: [{ offset_ms: 0, resultado: r }] });
  assert.deepEqual(tramos.map((t) => [t.hablante, t.texto]), [
    ['Vale', 'Hola, ¿cómo están?'],
    ['Paciente 1', 'Bien, gracias.'],
    ['Hablante C', 'Yo no tanto.'],
    ['Vale', 'Cuéntame más.'],
  ]);
  assert.equal(tramos[3].inicio_ms, 4000);
  assert.match(tramosATexto(tramos), /^\[00:00\] Vale: Hola, ¿cómo están\?\n\[00:01\] Paciente 1: Bien, gracias\./);
});

test('presencial: dos segmentos por pausa → desfase y etiquetas por parte', () => {
  const g: G = {
    origen: 'presencial', tipo: 'pareja', linea_hablantes: null, mapa_hablantes: { A: 'Vale', '2-B': 'Vale' },
    pausas: [{ desde_ms: 10_000, hasta_ms: 70_000 }],
  };
  const s1 = res('t1', [['Partimos.', 1000, 1500, 'A'], ['Ok.', 9000, 9500, 'B']], 10);
  const s2 = res('t2', [['Seguimos.', 500, 1000, 'B'], ['Sí.', 2000, 2300, 'A']], 5);
  // offset_ms = 0 en ambos (P4 no lo conocía): se usa el fin de la pausa registrada.
  const tramos = unirTranscripcion({ grabacion: g, segmentos: [{ offset_ms: 0, resultado: s1 }, { offset_ms: 0, resultado: s2 }] });
  assert.deepEqual(tramos.map((t) => [formatearTiempo(t.inicio_ms), t.hablante]), [
    ['00:01', 'Vale'], ['00:09', 'Hablante B'], ['01:10', 'Vale'], ['01:12', 'Hablante A (parte 2)'],
  ]);
  assert.equal(claveHablante(1, 'A'), '2-A');
});

test('presencial individual sin diarización: un solo hablante genérico', () => {
  const g: G = { origen: 'presencial', tipo: 'individual', linea_hablantes: null, mapa_hablantes: null, pausas: [] };
  const tramos = unirTranscripcion({ grabacion: g, segmentos: [{ offset_ms: 0, resultado: res('t', [['Hola', 0, 300], ['todos.', 350, 700]]) }] });
  assert.deepEqual(tramos, [{ inicio_ms: 0, fin_ms: 700, hablante: HABLANTE_SIN_SEPARAR, texto: 'Hola todos.' }]);
});

test('online: línea de hablantes del bot asigna nombres; sin intervalo → no identificado', () => {
  const linea = validarLineaHablantes([
    { t_ms: 0, nombre: 'Valentina Orellana', on: true }, { t_ms: 2000, nombre: 'Valentina Orellana', on: false },
    { t_ms: 2300, nombre: 'Paciente X', on: true }, { t_ms: 5000, nombre: 'Paciente X', on: false },
    { t_ms: 100, nombre: 'Notas de Ps. Valentina Orellana', on: true }, // el bot se ignora
  ]);
  const g: G = { origen: 'online', tipo: 'individual', linea_hablantes: linea, pausas: [], mapa_hablantes: { 'Paciente X': 'P.' } };
  const r = res('t', [
    ['Buenas', 100, 500], ['tardes.', 550, 1000],
    ['Hola.', 2400, 2800], ['Todo', 3000, 3300], ['bien.', 3350, 3800],
    ['¿Sigues?', 9000, 9500], // nadie con tile cerca (> 600 ms)
  ]);
  const tramos = unirTranscripcion({ grabacion: g, segmentos: [{ offset_ms: 0, resultado: r }] });
  assert.deepEqual(tramos.map((t) => [t.hablante, t.texto]), [
    ['Valentina Orellana', 'Buenas tardes.'],
    ['P.', 'Hola. Todo bien.'],
    [HABLANTE_NO_IDENTIFICADO, '¿Sigues?'],
  ]);
});

test('online: tile con retraso (palabra justo antes del on) usa la tolerancia', () => {
  const linea = [{ t_ms: 1000, nombre: 'Ana', on: true }, { t_ms: 3000, nombre: 'Ana', on: false }];
  const g: G = { origen: 'online', tipo: 'individual', linea_hablantes: linea, pausas: [], mapa_hablantes: null };
  const tramos = unirTranscripcion({ grabacion: g, segmentos: [{ offset_ms: 0, resultado: res('t', [['Eh,', 500, 800], ['mira.', 1100, 1500]]) }] });
  assert.deepEqual(tramos.map((t) => [t.hablante, t.texto]), [['Ana', 'Eh, mira.']]);
});

test('online: dos tiles a la vez (solapamiento de voces) → continuidad o no identificado', () => {
  const linea = [
    { t_ms: 0, nombre: 'Ana', on: true }, { t_ms: 4000, nombre: 'Ana', on: false },
    { t_ms: 3000, nombre: 'Bruno', on: true }, { t_ms: 8000, nombre: 'Bruno', on: false },
    // Interrupción simultánea pura al inicio: ambos encendidos de entrada
    { t_ms: 20_000, nombre: 'Ana', on: true }, { t_ms: 20_000, nombre: 'Bruno', on: true },
    { t_ms: 22_000, nombre: 'Ana', on: false }, { t_ms: 22_000, nombre: 'Bruno', on: false },
  ];
  const g: G = { origen: 'online', tipo: 'pareja', linea_hablantes: linea, pausas: [], mapa_hablantes: null };
  const r = res('t', [
    ['Yo', 1000, 1300], ['creo', 1400, 1700], ['que', 3100, 3300], ['sí.', 3400, 3700], // 3100–3700: ambos → sigue Ana
    ['No', 5000, 5300], ['es', 5400, 5600], ['así.', 5700, 6000],                       // solo Bruno
    ['¡Espera!', 20_500, 21_000],                                                        // ambos, sin contexto → no identificado
  ]);
  const tramos = unirTranscripcion({ grabacion: g, segmentos: [{ offset_ms: 0, resultado: r }] });
  assert.deepEqual(tramos.map((t) => [t.hablante, t.texto]), [
    ['Ana', 'Yo creo que sí.'],
    ['Bruno', 'No es así.'],
    [HABLANTE_NO_IDENTIFICADO, '¡Espera!'],
  ]);
});

test('online: segmentos del bot que se solapan 3 s no duplican palabras', () => {
  // Segmento 0: 0–15 s. Segmento 1 empieza en 12 s (3 s de solapamiento) y repite "voy a contarte algo".
  const s0 = res('a', [['Bueno,', 10_000, 10_400], ['voy', 12_200, 12_400], ['a', 12_450, 12_500], ['contarte', 13_600, 14_000], ['algo', 14_100, 14_500]], 15);
  const s1 = res('b', [['voy', 210, 400], ['a', 460, 500], ['contarte', 1590, 2000], ['algo', 2110, 2500], ['importante.', 3000, 3600]], 900);
  const palabras = unirPalabras('online', [{ offset_ms: 12_000, resultado: s1 }, { offset_ms: 0, resultado: s0 }]);
  assert.deepEqual(palabras.map((w) => w.text), ['Bueno,', 'voy', 'a', 'contarte', 'algo', 'importante.']);
  assert.equal(palabras.at(-1)!.start, 15_000);
  const linea = [{ t_ms: 0, nombre: 'Vale', on: true }];
  const tramos = unirTranscripcion({
    grabacion: { origen: 'online', tipo: 'individual', linea_hablantes: linea, pausas: [], mapa_hablantes: null },
    segmentos: [{ offset_ms: 0, resultado: s0 }, { offset_ms: 12_000, resultado: s1 }],
  });
  assert.equal(tramos.length, 1);
  assert.equal(tramos[0].texto, 'Bueno, voy a contarte algo importante.');
});

test('intervalos: on sin off se cierra al final; off huérfano se ignora', () => {
  const iv = intervalosDesdeLinea([{ t_ms: 50, nombre: 'X', on: false }, { t_ms: 100, nombre: 'Y', on: true }, { t_ms: 200, nombre: 'Y', on: true }], 1000);
  assert.deepEqual(iv, [{ nombre: 'Y', desde: 100, hasta: 1000 }]);
});

test('validarLineaHablantes rechaza formatos inválidos', () => {
  assert.throws(() => validarLineaHablantes({}), /lista/);
  assert.throws(() => validarLineaHablantes([{ t_ms: -1, nombre: 'a', on: true }]), /t_ms/);
  assert.throws(() => validarLineaHablantes([{ t_ms: 1, nombre: ' ', on: true }]), /nombre/);
  assert.throws(() => validarLineaHablantes([{ t_ms: 1, nombre: 'a', on: 'si' }]), /on/);
});

test('silencio largo corta el tramo del mismo hablante', () => {
  const g: G = { origen: 'presencial', tipo: 'individual', linea_hablantes: null, mapa_hablantes: null, pausas: [] };
  const tramos = unirTranscripcion({ grabacion: g, segmentos: [{ offset_ms: 0, resultado: res('t', [['Uno.', 0, 500], ['Dos.', 6000, 6500]]) }] });
  assert.equal(tramos.length, 2);
});

test('segmento sin completar → error; armarTranscripcionClara arma v1', () => {
  const g = { origen: 'presencial' as const, tipo: 'pareja' as const, linea_hablantes: null, mapa_hablantes: null, pausas: [], modelo: 'universal-3-5-pro' as const };
  assert.throws(() => unirTranscripcion({ grabacion: g, segmentos: [{ offset_ms: 0, resultado: { id: 'x', status: 'processing' } }] }));
  const c = armarTranscripcionClara({ grabacion: g, segmentos: [{ offset_ms: 0, resultado: res('t', [['Hola.', 0, 400, 'A'], ['Hola.', 600, 900, 'B']], 62) }] });
  assert.equal(c.v, 1);
  assert.equal(c.idioma, 'es');
  assert.equal(c.duracion_s, 62);
  assert.deepEqual(c.hablantes, ['Hablante A', 'Hablante B']);
  assert.ok(!JSON.stringify(c).includes('NO SE USA')); // el `text` completo de AssemblyAI no se arrastra
});
