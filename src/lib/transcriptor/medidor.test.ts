// Pruebas del medidor del grabador. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barrasDesdeDb, dbDesdeRms, dbSuavizado } from './medidor';

test('voz normal a ~2 m (−54…−45 dBFS) enciende 2–3 barras; voz cercana 4–5', () => {
  for (const db of [-53, -50, -46]) assert.ok([2, 3].includes(barrasDesdeDb(db)), `${db} dB → ${barrasDesdeDb(db)}`);
  for (const db of [-44, -40]) assert.equal(barrasDesdeDb(db), 3);
  for (const db of [-35, -30, -25, -20, -10, 0]) assert.ok([4, 5].includes(barrasDesdeDb(db)), `${db} dB`);
  assert.equal(barrasDesdeDb(-20), 5);
});

test('ruido de fondo y silencio: 0 barras; límites 0–5', () => {
  assert.equal(barrasDesdeDb(-100), 0);
  assert.equal(barrasDesdeDb(-70), 0);
  assert.equal(barrasDesdeDb(-64), 0);
  assert.equal(barrasDesdeDb(Number.NaN), 0);
  assert.equal(barrasDesdeDb(20), 5);
});

test('antes (1 barra con voz a 1–2 m) vs ahora: la voz de la prueba real se ve', () => {
  const antes = (db: number) => Math.max(0, Math.min(5, Math.round((db + 60) / 10)));
  assert.equal(antes(-50), 1);
  assert.equal(barrasDesdeDb(-50), 2);
});

test('el umbral de silencio (RMS 0,004) sigue siendo ≈ −48 dBFS', () => {
  assert.ok(Math.abs(dbDesdeRms(0.004) - -47.96) < 0.01);
  assert.equal(dbDesdeRms(0), -100);
});

test('suavizado: sube al instante, baja 6 dB cada 100 ms', () => {
  assert.equal(dbSuavizado(-60, -30, 16), -30);
  assert.equal(dbSuavizado(-30, -80, 100), -36);
  assert.equal(dbSuavizado(-99, -100, 1000), -100);
});
