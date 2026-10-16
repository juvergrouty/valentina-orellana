// Pruebas de la máquina de estados (sin base). Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSICIONES, TERMINALES, TransicionInvalidaError,
  destinoReintento, esTransicionValida, estadoParaReintentar, leaseVencido, origenesValidos,
  transicionar, validarTransicion, limpiezaReintento, reintentar,
} from './estados';
import { ESTADOS, type EstadoGrabacion } from './tipos';

// Camino feliz presencial y online (diagrama de 50-arquitectura §4).
const PRESENCIAL: EstadoGrabacion[] = ['creada', 'grabando', 'pausada', 'grabando', 'subiendo', 'subida', 'transcribiendo', 'transcrita', 'resumiendo', 'lista'];
const ONLINE: EstadoGrabacion[] = ['creada', 'bot_lanzando', 'bot_en_lobby', 'grabando', 'subiendo', 'subida', 'transcribiendo', 'transcrita', 'resumiendo', 'lista'];

test('caminos felices válidos', () => {
  for (const camino of [PRESENCIAL, ONLINE])
    for (let i = 1; i < camino.length; i++)
      assert.ok(esTransicionValida(camino[i - 1], camino[i]), `${camino[i - 1]} → ${camino[i]}`);
});

test('transiciones inválidas se rechazan', () => {
  const invalidas: [EstadoGrabacion, EstadoGrabacion][] = [
    ['creada', 'lista'], ['grabando', 'transcribiendo'], ['subida', 'lista'], ['lista', 'grabando'],
    ['cancelada', 'grabando'], ['sin_audio', 'subida'], ['bot_no_admitido', 'grabando'],
    ['transcrita', 'transcribiendo'], ['bot_lanzando', 'grabando'], ['sin_consentimiento', 'grabando'],
    ['error', 'lista'], ['error', 'sin_audio'], ['grabando', 'grabando'],
  ];
  for (const [de, a] of invalidas) {
    assert.equal(esTransicionValida(de, a), false, `${de} → ${a}`);
    assert.throws(() => validarTransicion(de, a), TransicionInvalidaError);
  }
});

test('estados desconocidos se rechazan', () => {
  assert.equal(esTransicionValida('volando' as EstadoGrabacion, 'lista'), false);
  assert.equal(esTransicionValida('creada', 'volando' as EstadoGrabacion), false);
  assert.throws(() => validarTransicion('creada', 'volando' as EstadoGrabacion), TransicionInvalidaError);
});

test('todo estado está en la tabla y solo apunta a estados conocidos', () => {
  for (const e of ESTADOS) {
    assert.ok(Array.isArray(TRANSICIONES[e]), e);
    for (const a of TRANSICIONES[e]) assert.ok((ESTADOS as readonly string[]).includes(a));
  }
});

test('terminales sin salida (salvo lista → resumiendo para regenerar)', () => {
  for (const t of TERMINALES) {
    const salidas = TRANSICIONES[t];
    if (t === 'lista') assert.deepEqual([...salidas], ['resumiendo']);
    else assert.equal(salidas.length, 0, t);
  }
});

test('desde error: solo cancelar o volver a un estado reintentable', () => {
  assert.ok(esTransicionValida('error', 'cancelada'));
  assert.ok(esTransicionValida('error', 'transcribiendo'));
  assert.ok(!esTransicionValida('error', 'lista'));
  assert.equal(destinoReintento({ estado: 'error', estado_antes_error: 'transcribiendo' }), 'transcribiendo');
  assert.equal(destinoReintento({ estado: 'error', estado_antes_error: null }), null);
  assert.equal(destinoReintento({ estado: 'lista', estado_antes_error: 'subida' }), null);
  assert.equal(destinoReintento({ estado: 'error', estado_antes_error: 'lista' }), null);
  assert.equal(estadoParaReintentar('bot_en_lobby'), 'bot_lanzando');
  assert.equal(estadoParaReintentar('subiendo'), 'subiendo');
});

test('origenesValidos', () => {
  assert.deepEqual(origenesValidos('subiendo').sort(), ['grabando', 'pausada'].sort());
  assert.deepEqual(origenesValidos('lista'), ['resumiendo']);
});

test('leaseVencido (10 min)', () => {
  const ahora = new Date('2026-10-15T12:00:00Z');
  assert.equal(leaseVencido(null, ahora), true);
  assert.equal(leaseVencido('2026-10-15T11:55:00Z', ahora), false);
  assert.equal(leaseVencido('2026-10-15T11:50:00Z', ahora), true);
  assert.equal(leaseVencido('basura', ahora), true);
});

test('transicionar rechaza transiciones inválidas ANTES de tocar la base', async () => {
  const sinUsar = new Proxy({}, { get() { throw new Error('no debía llamar a la base'); } }) as never;
  await assert.rejects(transicionar('x', ['creada'], 'lista', {}, sinUsar), TransicionInvalidaError);
  await assert.rejects(transicionar('x', ['grabando', 'subida'], 'subiendo', {}, sinUsar), TransicionInvalidaError);
  await assert.rejects(transicionar('x', [], 'grabando', {}, sinUsar));
  await assert.rejects(transicionar('x', ['grabando'], 'error', {}, sinUsar));
  await assert.rejects(transicionar('x', ['error'], 'subida', {}, sinUsar));
});

test('transicionar arma el update condicional y no deja pisar estado', async () => {
  const llamadas: unknown[][] = [];
  const q: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ['from', 'update', 'eq', 'in', 'select']) q[m] = (...a: unknown[]) => { llamadas.push([m, ...a]); return q; };
  q.maybeSingle = async () => ({ data: { id: 'g1', estado: 'subiendo' }, error: null });
  const fila = await transicionar('g1', ['grabando', 'pausada'], 'subiendo', { estado: 'lista', fin_at: 'T' } as never, q as never);
  assert.deepEqual(fila, { id: 'g1', estado: 'subiendo' });
  assert.deepEqual(llamadas.find((l) => l[0] === 'update'), ['update', { fin_at: 'T', estado: 'subiendo' }]);
  assert.deepEqual(llamadas.find((l) => l[0] === 'in'), ['in', 'estado', ['grabando', 'pausada']]);
});

// ─── Correcciones 82-revision-codigo (M2, M3) ────────────────────────────────

test('M2: Reintentar reinicia intentos y backoff (y M3: hacia bot_lanzando suelta la máquina vieja)', async () => {
  const { SupabaseMemoria } = await import('./pruebas/supabaseMemoria');
  const db = new SupabaseMemoria();
  db.tabla('grabaciones').push(
    { id: 'g1', estado: 'error', estado_antes_error: 'subida', intentos: 6, proximo_intento_at: '2026-10-20T15:00:00Z', ultimo_error: 'x', tomada_en: null },
    { id: 'g2', estado: 'error', estado_antes_error: 'bot_lanzando', intentos: 3, bot_machine_id: 'maq1', ultimo_error: 'x', tomada_en: null },
  );
  const r1 = await reintentar('g1', db.cliente);
  assert.equal(r1?.estado, 'subida');
  const g1 = db.tabla('grabaciones')[0];
  assert.deepEqual([g1.intentos, g1.proximo_intento_at, g1.ultimo_error, g1.estado_antes_error], [0, null, null, null]);
  assert.equal(g1.bot_machine_id, undefined, 'solo hacia bot_lanzando se toca bot_machine_id');
  const r2 = await reintentar('g2', db.cliente);
  assert.equal(r2?.estado, 'bot_lanzando');
  assert.equal(db.tabla('grabaciones')[1].bot_machine_id, null);
  assert.equal(db.tabla('grabaciones')[1].intentos, 0);
  assert.deepEqual(limpiezaReintento('resumiendo'), { estado_antes_error: null, ultimo_error: null, tomada_en: null, intentos: 0, proximo_intento_at: null });
});
