// Pruebas sin red del cliente de Claude. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_PREGUNTAS, CONFIG_RESUMEN, ErrorClaude, clasificarError, costoUsd, crearClienteClaude,
  llamarClaude, paramsMensaje, type ClienteMensajes,
} from './claude';

function mensaje(texto: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'msg_x', type: 'message', role: 'assistant', model: 'x',
    content: [{ type: 'text', text: texto }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...extra,
  };
}

/** Cliente falso: cada llamada consume la siguiente respuesta (o error) de la lista. */
function falso(respuestas: unknown[]) {
  const llamadas: unknown[] = [];
  const cliente: ClienteMensajes = {
    messages: {
      stream(params) {
        llamadas.push(params);
        const r = respuestas.shift();
        return { finalMessage: async () => { if (r instanceof Error || (r as { status?: number })?.status) throw r; return r as never; } };
      },
    },
  };
  return { cliente, llamadas };
}

const sinEspera = { dormir: async () => {} };
const errHttp = (status: number, retryAfter?: string) => Object.assign(new Error(`http ${status}`), {
  status, headers: { get: (k: string) => (k === 'retry-after' ? retryAfter ?? null : null) },
});

test('costoUsd: Sonnet 5.5 a precio normal (14k entrada + 2k salida = US$0,048)', () => {
  assert.equal(costoUsd('claude-sonnet-5-5', { entrada: 14_000, salida: 2_000, cacheEscritura: 0, cacheLectura: 0 }), 0.048);
});

test('costoUsd: Haiku 5.5 cambia de tarifa sobre 100k tokens de prompt', () => {
  const bajo = costoUsd('claude-haiku-5-5', { entrada: 90_000, salida: 500, cacheEscritura: 0, cacheLectura: 0 });
  const alto = costoUsd('claude-haiku-5-5', { entrada: 101_000, salida: 500, cacheEscritura: 0, cacheLectura: 0 });
  assert.equal(bajo, 0.00925);
  assert.equal(alto, 0.05175);
  // La caché cuenta para el umbral y se cobra a su tarifa.
  assert.equal(costoUsd('claude-haiku-5-5', { entrada: 1_000, salida: 0, cacheEscritura: 0, cacheLectura: 50_000 }), 0.0006);
});

test('costoUsd: modelo sin tarifa lanza (no se registra un costo inventado)', () => {
  assert.throws(() => costoUsd('claude-x', { entrada: 1, salida: 1, cacheEscritura: 0, cacheLectura: 0 }));
});

test('clasificarError: recuperables vs. definitivos por estado HTTP', () => {
  for (const s of [408, 409, 429, 500, 503, 529]) assert.equal(clasificarError({ status: s }).recuperable, true, `HTTP ${s}`);
  for (const s of [400, 401, 403, 404, 413]) assert.equal(clasificarError({ status: s }).recuperable, false, `HTTP ${s}`);
  assert.equal(clasificarError({ status: 401 }).codigo, 'autenticacion');
  assert.equal(clasificarError(new Error('x')).codigo, 'desconocido');
});

test('paramsMensaje: sin metadata ni datos fuera de system/messages; modelos y thinking correctos', () => {
  const p = paramsMensaje({ uso: CONFIG_RESUMEN, system: 's', messages: [{ role: 'user', content: 'u' }] });
  assert.deepEqual(Object.keys(p).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system', 'thinking']);
  assert.equal(p.model, 'claude-sonnet-5-5');
  assert.deepEqual(p.thinking, { type: 'between_tools' }); // Sonnet 5.5 rechaza 'disabled'
  assert.equal(p.output_config?.effort, 'medium');
  const q = paramsMensaje({ uso: CONFIG_PREGUNTAS, system: 's', messages: [{ role: 'user', content: 'u' }] });
  assert.equal(q.model, 'claude-haiku-5-5');
  assert.deepEqual(q.thinking, { type: 'disabled' });
});

test('llamarClaude: reintenta 529 y 429 con backoff y luego entrega texto, tokens y costo', async () => {
  const esperas: number[] = [];
  const { cliente, llamadas } = falso([errHttp(529), errHttp(429, '3'), mensaje('hola')]);
  const r = await llamarClaude(
    { uso: CONFIG_RESUMEN, system: 's', messages: [{ role: 'user', content: 'u' }] },
    { cliente, dormir: async (ms) => { esperas.push(ms); } },
  );
  assert.equal(r.texto, 'hola');
  assert.equal(r.intentos, 3);
  assert.equal(llamadas.length, 3);
  assert.deepEqual(r.uso, { entrada: 1000, salida: 200, cacheEscritura: 0, cacheLectura: 0 });
  assert.equal(r.costoUsd, 0.004);
  assert.ok(esperas[0] >= 2000 && esperas[1] >= 8000, 'backoff creciente');
});

test('llamarClaude: 400 no se reintenta', async () => {
  const { cliente, llamadas } = falso([errHttp(400), mensaje('no')]);
  await assert.rejects(
    llamarClaude({ uso: CONFIG_RESUMEN, system: 's', messages: [{ role: 'user', content: 'u' }] }, { cliente, ...sinEspera }),
    (e: unknown) => e instanceof ErrorClaude && e.codigo === 'peticion_invalida' && !e.recuperable,
  );
  assert.equal(llamadas.length, 1);
});

test('llamarClaude: se rinde tras el máximo de intentos con error recuperable', async () => {
  const { cliente, llamadas } = falso([errHttp(500), errHttp(500), errHttp(500), errHttp(500), errHttp(500)]);
  await assert.rejects(
    llamarClaude({ uso: CONFIG_PREGUNTAS, system: 's', messages: [{ role: 'user', content: 'u' }] }, { cliente, ...sinEspera }),
    (e: unknown) => e instanceof ErrorClaude && e.recuperable,
  );
  assert.equal(llamadas.length, 4);
});

test('llamarClaude: refusal es definitivo; max_tokens marca truncado', async () => {
  const a = falso([mensaje('', { stop_reason: 'refusal', content: [] })]);
  await assert.rejects(
    llamarClaude({ uso: CONFIG_RESUMEN, system: 's', messages: [{ role: 'user', content: 'u' }] }, { cliente: a.cliente, ...sinEspera }),
    (e: unknown) => e instanceof ErrorClaude && e.codigo === 'rechazo',
  );
  const b = falso([mensaje('parcial', { stop_reason: 'max_tokens' })]);
  const r = await llamarClaude({ uso: CONFIG_RESUMEN, system: 's', messages: [{ role: 'user', content: 'u' }] }, { cliente: b.cliente, ...sinEspera });
  assert.equal(r.truncado, true);
});

test('ErrorClaude no lleva contenido en el mensaje', () => {
  const e = new ErrorClaude('servidor', true, 503);
  assert.equal(e.message, 'Claude: servidor (HTTP 503)');
});

test('crearClienteClaude: Batch desactivado (decisión 16 oct)', async () => {
  const c = crearClienteClaude();
  await assert.rejects(c.crearBatch([]), /Batch está desactivado/);
  await assert.rejects(c.revisarBatch('b'), /Batch está desactivado/);
  await assert.rejects(c.leerResultados('b'), /Batch está desactivado/);
  await assert.rejects(c.borrarBatch('b'), /Batch está desactivado/);
});
