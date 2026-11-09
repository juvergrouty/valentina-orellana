import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuardiaSilencio } from './silencio.js';

const nueva = () => new GuardiaSilencio({ umbral: 0.02, repararTras: 2, avisarTras: 4, maxReparaciones: 3 });

test('silencio con 2 personas: repara a la lectura 2 (30 s), avisa a la 4 (60 s, una vez), vuelve a reparar a la 6', () => {
  const g = nueva();
  const r = [1, 2, 3, 4, 5, 6, 7, 8].map(() => g.observar(0, 2));
  assert.deepEqual(r, ['nada', 'reparar', 'nada', 'avisar', 'nada', 'reparar', 'nada', 'reparar']);
  assert.equal(g.observar(0, 2), 'nada'); // máx 3 reparaciones
});

test('voz reinicia la cuenta; con una sola persona no cuenta', () => {
  const g = nueva();
  assert.equal(g.observar(0, 2), 'nada');
  assert.equal(g.observar(0.3, 2), 'nada');
  assert.equal(g.observar(0, 2), 'nada');
  assert.equal(g.observar(0, 1), 'nada');
  assert.equal(g.observar(0, 2), 'nada');
  assert.equal(g.observar(0, 2), 'reparar');
});

test('el aviso sale una sola vez por sesión', () => {
  const g = nueva();
  const r = Array.from({ length: 12 }, () => g.observar(0, 3));
  assert.equal(r.filter((x) => x === 'avisar').length, 1);
});

test('tras volver la voz se puede reparar y avisar de nuevo', () => {
  const g = nueva();
  for (let i = 0; i < 4; i++) g.observar(0, 2); // repara y avisa
  g.observar(0.5, 2); // vuelve la voz
  const r = [1, 2, 3, 4].map(() => g.observar(0, 2));
  assert.deepEqual(r, ['nada', 'reparar', 'nada', 'avisar']);
});
