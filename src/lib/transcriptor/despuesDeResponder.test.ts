// Pruebas de despuesDeResponder (waitUntil de Vercel sin dependencia). Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextoVercel, despuesDeResponder } from './despuesDeResponder';

test('con waitUntil de Vercel: entrega la promesa y no lanza aunque el trabajo falle', async () => {
  const promesas: Promise<unknown>[] = [];
  let corrio = false;
  assert.equal(despuesDeResponder(async () => { corrio = true; }, { waitUntil: (p) => { promesas.push(p); } }), true);
  assert.equal(despuesDeResponder(async () => { throw new Error('falló'); }, { waitUntil: (p) => { promesas.push(p); } }), true);
  await Promise.all(promesas); // el error queda capturado
  assert.ok(corrio);
});

test('sin contexto de Vercel (local/pruebas): false y no corre nada', () => {
  let corrio = false;
  assert.equal(despuesDeResponder(async () => { corrio = true; }, {}), false);
  assert.equal(corrio, false);
});

test('lee el contexto del mismo símbolo que @vercel/functions', () => {
  const s = Symbol.for('@vercel/request-context');
  const g = globalThis as unknown as Record<symbol, unknown>;
  const antes = g[s];
  const wu = () => {};
  g[s] = { get: () => ({ waitUntil: wu }) };
  try { assert.equal(contextoVercel().waitUntil, wu); } finally { g[s] = antes; }
});
