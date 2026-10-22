// Pruebas de la lista de comunas y su limpieza (21 oct 2026). Sin red. Correr: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMUNAS, COMUNAS_POR_REGION, normalizarComuna } from './comunas';

test('346 comunas, sin repetidas', () => {
  assert.equal(COMUNAS.length, 346);
  assert.equal(new Set(COMUNAS).size, 346);
  assert.equal(COMUNAS_POR_REGION.length, 16);
});

test('caso real: lo que escribió el autocompletar', () => {
  assert.equal(normalizarComuna('Las Condes, Metropolitana de Santiago'), 'Las Condes');
});

test('tildes, mayúsculas, espacios y "comuna de"', () => {
  assert.equal(normalizarComuna('nunoa'), 'Ñuñoa');
  assert.equal(normalizarComuna('  LAS CONDES  '), 'Las Condes');
  assert.equal(normalizarComuna('Comuna de Providencia'), 'Providencia');
  assert.equal(normalizarComuna('penalolen, Región Metropolitana'), 'Peñalolén');
  assert.equal(normalizarComuna('Santiago Centro'), 'Santiago');
  assert.equal(normalizarComuna('Til Til'), 'Tiltil');
  assert.equal(normalizarComuna("O'Higgins"), "O'Higgins");
  assert.equal(normalizarComuna('O’Higgins'), "O'Higgins");
  assert.equal(normalizarComuna('Vitacura - Santiago'), 'Vitacura');
  assert.equal(normalizarComuna('Chicureo'), 'Colina');
  assert.equal(normalizarComuna('La Dehesa'), 'Lo Barnechea');
  assert.equal(normalizarComuna('Reñaca'), 'Viña del Mar');
  assert.equal(normalizarComuna('Llay-Llay'), 'Llaillay');
});

test('no reconocidas o vacías → null', () => {
  assert.equal(normalizarComuna(''), null);
  assert.equal(normalizarComuna(null), null);
  assert.equal(normalizarComuna('Buenos Aires'), null);
  assert.equal(normalizarComuna('Las Condes 123'), null);
});
