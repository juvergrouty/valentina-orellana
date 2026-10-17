// Pruebas de tabla de la regla fija de modelo. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elegirModelo, origenDesdeSessionType, tipoDesdeSessionType } from './reglas';
import type { Origen, TipoSesion } from './tipos';

type Fila = [TipoSesion, Origen, boolean, string, boolean, number | null];
// tipo, origen, ruido → modelo, diarización, hablantes esperados
const TABLA: Fila[] = [
  ['pareja',     'presencial', false, 'universal-3-5-pro', true,  3],
  ['pareja',     'presencial', true,  'universal-3-5-pro', true,  3],
  ['pareja',     'online',     false, 'universal-3-5-pro', true,  3],
  ['pareja',     'online',     true,  'universal-3-5-pro', true,  3],
  ['individual', 'presencial', false, 'universal-2',       true,  2],
  ['individual', 'presencial', true,  'universal-3-5-pro', true,  2],
  ['individual', 'online',     false, 'universal-2',       false, null],
  ['individual', 'online',     true,  'universal-3-5-pro', false, null],
  ['sin_tipo',   'presencial', false, 'universal-2',       true,  null],
  ['sin_tipo',   'presencial', true,  'universal-3-5-pro', true,  null],
  ['sin_tipo',   'online',     false, 'universal-2',       false, null],
  ['sin_tipo',   'online',     true,  'universal-3-5-pro', false, null],
];

for (const [tipo, origen, ruido, modelo, diar, hablantes] of TABLA) {
  test(`elegirModelo ${tipo} · ${origen} · ruido=${ruido} → ${modelo}${diar ? ' + diarización' : ''}`, () => {
    const d = elegirModelo({ tipo, origen, lugarConRuido: ruido });
    assert.equal(d.modelo, modelo);
    assert.equal(d.diarizacion, diar);
    assert.equal(d.hablantesEsperados, hablantes);
    assert.ok(d.motivo.length > 0);
  });
}

test('online individual / sin tipo no paga diarización; pareja online sí (recuadro compartido)', () => {
  assert.equal(elegirModelo({ tipo: 'pareja', origen: 'online', lugarConRuido: false }).diarizacion, true);
  for (const tipo of ['individual', 'sin_tipo'] as const)
    for (const ruido of [true, false])
      assert.equal(elegirModelo({ tipo, origen: 'online', lugarConRuido: ruido }).diarizacion, false);
});

test('toda grabación presencial lleva diarización (17 oct: individual salía en un solo bloque)', () => {
  for (const tipo of ['pareja', 'individual', 'sin_tipo'] as const)
    for (const ruido of [true, false])
      assert.equal(elegirModelo({ tipo, origen: 'presencial', lugarConRuido: ruido }).diarizacion, true);
});

test('entradas inválidas se rechazan', () => {
  assert.throws(() => elegirModelo({ tipo: 'grupo' as TipoSesion, origen: 'online', lugarConRuido: false }));
  assert.throws(() => elegirModelo({ tipo: 'pareja', origen: 'telefono' as Origen, lugarConRuido: false }));
  assert.throws(() => elegirModelo({ tipo: 'pareja', origen: 'online', lugarConRuido: 'si' as unknown as boolean }));
});

test('tipoDesdeSessionType', () => {
  assert.equal(tipoDesdeSessionType('pareja-online'), 'pareja');
  assert.equal(tipoDesdeSessionType('pareja-presencial'), 'pareja');
  assert.equal(tipoDesdeSessionType('pareja'), 'pareja');
  assert.equal(tipoDesdeSessionType('online'), 'individual');
  assert.equal(tipoDesdeSessionType('presencial'), 'individual');
  assert.equal(tipoDesdeSessionType(''), 'sin_tipo');
  assert.equal(tipoDesdeSessionType(null), 'sin_tipo');
  assert.equal(tipoDesdeSessionType('taller'), 'sin_tipo');
});

test('origenDesdeSessionType', () => {
  assert.equal(origenDesdeSessionType('pareja-online'), 'online');
  assert.equal(origenDesdeSessionType('online'), 'online');
  assert.equal(origenDesdeSessionType('pareja-presencial'), 'presencial');
  assert.equal(origenDesdeSessionType('presencial'), 'presencial');
  assert.equal(origenDesdeSessionType(undefined), null);
});
