// Pruebas puras de la segunda ronda del robot (r2, 18 oct). Las de punta a punta están en
// pipeline.test.ts (reemplazo, máquina caída, nadie llegó, consentimiento, ventana, evento movido).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combinarLinea, maquinaMuerta, notaCierre, NOTA_RECONECTADO, NOTA_RECONECTANDO, eventIdLiberado } from './botReconexion';
import { crearBot, idEventoBot, parsearEventoBot } from './bot';

const GID = '3f2b8a1e-0c4d-4e5f-9a6b-7c8d9e0f1a2b';

test('r2: idEventoBot distingue al robot de reemplazo (su fin no se toma por repetido)', () => {
  const fin = { tipo: 'fin' as const, motivo: 'vale_salio' as const, linea_hablantes: [] };
  assert.equal(idEventoBot(GID, fin), `${GID}:fin:`);
  assert.notEqual(idEventoBot(GID, fin, 'aaaaaaaaaaaa'), idEventoBot(GID, fin, 'bbbbbbbbbbbb'));
  assert.equal(idEventoBot(GID, { tipo: 'segmento_subido', seq: 3, bytes: 1, offset_ms: 0, duracion_ms: 1 }, 'x'), `${GID}:segmento_subido:3`);
});

test('r2: fin acepta nadie_llego y sin_consentimiento', () => {
  for (const motivo of ['nadie_llego', 'sin_consentimiento']) {
    const r = parsearEventoBot({ tipo: 'fin', motivo, linea_hablantes: [] });
    assert.ok(r.ok && r.evento.tipo === 'fin' && r.evento.motivo === motivo);
  }
  assert.equal(parsearEventoBot({ tipo: 'fin', motivo: 'otro', linea_hablantes: [] }).ok, false);
});

test('r2: estado de máquina de Fly (docs.fly.io/machines/machine-states)', async () => {
  assert.equal(maquinaMuerta(404, undefined), true);
  for (const s of ['stopped', 'failed', 'destroying', 'destroyed', 'launch_failed']) assert.equal(maquinaMuerta(200, s), true, s);
  for (const s of ['started', 'starting', 'created', 'stopping', 'replacing']) assert.equal(maquinaMuerta(200, s), false, s);
  assert.equal(maquinaMuerta(500, undefined), null);
  assert.equal(maquinaMuerta(200, undefined), null);
  const urls: string[] = [];
  const respuestas = [new Response(JSON.stringify({ state: 'stopped' })), new Response('', { status: 404 }), new Response('', { status: 503 })];
  const bot = crearBot({
    fetch: (async (u: string) => { urls.push(u); return respuestas.shift()!; }) as unknown as typeof fetch,
    env: { FLY_API_TOKEN: 't', FLY_APP_BOT: 'vo-bot-meet' },
  });
  assert.equal(await bot.estadoMaquina('e2865013a1b2c3'), 'muerta');
  assert.equal(await bot.estadoMaquina('e2865013a1b2c3'), 'muerta');
  assert.equal(await bot.estadoMaquina('e2865013a1b2c3'), null);
  assert.equal(await bot.estadoMaquina('../x'), null, 'id raro: ni se consulta');
  assert.equal(urls[0], 'https://api.machines.dev/v1/apps/vo-bot-meet/machines/e2865013a1b2c3');
  assert.equal(urls.length, 3);
});

test('r2: línea combinada, nota de reconexión e id de evento liberado', () => {
  const a = [{ t_ms: 0, nombre: 'A', on: true }];
  const b = [{ t_ms: 9, nombre: 'B', on: true }];
  assert.deepEqual(combinarLinea(a, b), [...a, ...b]);
  assert.deepEqual(combinarLinea(null, b), b);
  assert.deepEqual(combinarLinea([{ basura: 1 }], b), b);
  assert.equal(notaCierre(null, null), null);
  assert.equal(notaCierre(null, 'x'), 'x');
  assert.equal(notaCierre(NOTA_RECONECTANDO, null), NOTA_RECONECTADO);
  assert.equal(notaCierre(NOTA_RECONECTANDO, 'x'), `${NOTA_RECONECTADO} x`);
  assert.equal(eventIdLiberado('abc', GID), 'abc~movido-3f2b8a1e');
});
