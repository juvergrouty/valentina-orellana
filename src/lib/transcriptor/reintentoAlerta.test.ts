// Pruebas del botón "Reintentar" del aviso (sin base ni red). Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ejecutarReintento, planReintento, type EstadoParaReintento, type OpsReintento } from './reintentoAlerta';
import { REINTENTABLES, destinoReintento } from './estados';
import { ESTADOS, type EstadoGrabacion } from './tipos';

const FIN_FUTURO = new Date(Date.now() + 3600_000).toISOString();
const g = (estado: EstadoGrabacion, antes: EstadoGrabacion | null = null, origen: 'presencial' | 'online' = 'online'): EstadoParaReintento =>
  ({ estado, estado_antes_error: antes, origen, hora_fin_prevista: origen === 'online' ? FIN_FUTURO : null });

test('desde error: vuelve exactamente a estado_antes_error (cada estado reintentable)', () => {
  const telefono = ['creada', 'grabando', 'pausada', 'subiendo'];
  for (const antes of REINTENTABLES) {
    for (const origen of ['presencial', 'online'] as const) {
      const p = planReintento(g('error', antes, origen), 'reintentar', false);
      if (origen === 'online' && telefono.includes(antes)) {
        assert.equal(p.tipo, 'manual', `${origen} ${antes}: el bot ya no está, no se deja quieta en ${antes}`);
        continue;
      }
      assert.equal(p.tipo, 'reintentar_error', `${origen} ${antes}`);
      if (p.tipo === 'reintentar_error') {
        assert.equal(p.destino, destinoReintento({ estado: 'error', estado_antes_error: antes }));
        assert.equal(p.reabrirResumen, false);
        assert.equal(!!p.enTelefono, telefono.includes(antes));
      }
    }
  }
  const sinAntes = planReintento(g('error', null), 'reintentar', false);
  assert.equal(sinAntes.tipo, 'manual');
});

test('reintentar resumen: si vuelve a resumiendo con el resumen en error, se reabre el resumen', () => {
  const p = planReintento(g('error', 'resumiendo'), 'reintentar_resumen', true);
  assert.deepEqual(p, { tipo: 'reintentar_error', destino: 'resumiendo', reabrirResumen: true });
  const p2 = planReintento(g('error', 'transcrita'), 'reintentar_resumen', true);
  assert.deepEqual(p2, { tipo: 'reintentar_error', destino: 'transcrita', reabrirResumen: false }, 'desde transcrita el orquestador crea el resumen');
  const p3 = planReintento(g('resumiendo'), 'reintentar_resumen', true);
  assert.deepEqual(p3, { tipo: 'soltar', estado: 'resumiendo', reabrirResumen: true });
});

test('cada estado tiene un plan definido y sensato', () => {
  const esperado: Partial<Record<EstadoGrabacion, string>> = {
    creada: 'soltar', bot_lanzando: 'soltar', subida: 'soltar', transcribiendo: 'soltar', transcrita: 'soltar', resumiendo: 'soltar',
    grabando: 'manual', pausada: 'manual', subiendo: 'manual', bot_en_lobby: 'manual',
    lista: 'nada', sin_audio: 'nada', cancelada: 'nada', bot_no_admitido: 'nada', sin_consentimiento: 'nada',
  };
  for (const e of ESTADOS) {
    if (e === 'error') continue;
    assert.equal(planReintento(g(e), 'reintentar', false).tipo, esperado[e], e);
  }
  // Presencial 'creada' = el audio sigue en el teléfono: no se puede desde el servidor.
  const p = planReintento(g('creada', null, 'presencial'), 'reintentar', false);
  assert.equal(p.tipo, 'manual');
  if (p.tipo === 'manual') assert.match(p.mensaje, /teléfono/);
});

function ops(estado: EstadoGrabacion, antes: EstadoGrabacion | null, resumenErrorId: string | null = null) {
  const llamadas: string[] = [];
  const o: OpsReintento = {
    async leer() { return { grabacion: g(estado, antes), resumenErrorId }; },
    async reintentar() { llamadas.push('reintentar'); return antes ? { estado: antes } : null; },
    async soltar() { llamadas.push('soltar'); return true; },
    async reabrirResumen(id) { llamadas.push(`reabrir:${id}`); return true; },
  };
  return { o, llamadas };
}

test('ejecución: error → reintentar(), resuelve la alerta y reabre el resumen si corresponde', async () => {
  const a = ops('error', 'resumiendo', 'r1');
  const r = await ejecutarReintento('g1', 'reintentar_resumen', a.o);
  assert.deepEqual(a.llamadas, ['reintentar', 'reabrir:r1']);
  assert.equal(r.ok, true); assert.equal(r.resolver, true); assert.equal(r.desde, 'error'); assert.equal(r.hacia, 'resumiendo');

  const b = ops('error', 'subida');
  const rb = await ejecutarReintento('g1', 'reintentar', b.o);
  assert.deepEqual(b.llamadas, ['reintentar']);
  assert.equal(rb.hacia, 'subida');
});

test('ejecución: atascada en paso del cron → soltar; teléfono → mensaje sin tocar nada; lista → solo cerrar', async () => {
  const a = ops('transcribiendo', null);
  assert.equal((await ejecutarReintento('g1', 'reintentar', a.o)).ok, true);
  assert.deepEqual(a.llamadas, ['soltar']);

  const b = ops('subiendo', null);
  const rb = await ejecutarReintento('g1', 'reintentar', b.o);
  assert.equal(rb.ok, false); assert.equal(rb.resolver, false);
  assert.deepEqual(b.llamadas, []);

  const c = ops('lista', null);
  const rc = await ejecutarReintento('g1', 'reintentar_resumen', c.o);
  assert.equal(rc.ok, true); assert.equal(rc.resolver, true);
  assert.deepEqual(c.llamadas, []);
});

test('ejecución: presencial desde error en subiendo → vuelve a subiendo y pide abrir el teléfono', async () => {
  const a = ops('error', 'subiendo');
  a.o.leer = async () => ({ grabacion: g('error', 'subiendo', 'presencial'), resumenErrorId: null });
  const r = await ejecutarReintento('g1', 'reintentar', a.o);
  assert.equal(r.ok, true); assert.equal(r.hacia, 'subiendo'); assert.match(r.mensaje, /teléfono/);
});

test('ejecución: con una toma vigente del cron no se suelta ni se cierra el aviso', async () => {
  const a = ops('transcribiendo', null);
  a.o.soltar = async () => false;
  const r = await ejecutarReintento('g1', 'reintentar', a.o);
  assert.equal(r.ok, false); assert.equal(r.resolver, false); assert.match(r.mensaje, /procesando/);
});

test('ejecución: si otro proceso ya movió la grabación, no se marca resuelta', async () => {
  const a = ops('error', 'subida');
  a.o.reintentar = async () => null;
  const r = await ejecutarReintento('g1', 'reintentar', a.o);
  assert.equal(r.ok, false); assert.equal(r.resolver, false);
  const sin = await ejecutarReintento('g1', 'reintentar', { ...a.o, leer: async () => null });
  assert.equal(sin.ok, false);
});

test('M3: bot caído antes de grabar → se relanza solo si la sesión online no ha terminado', () => {
  const ahora = new Date('2026-10-20T13:00:00Z');
  const enCurso = planReintento({ estado: 'error', estado_antes_error: 'bot_lanzando', origen: 'online', hora_fin_prevista: '2026-10-20T13:40:00Z' }, 'reintentar', false, ahora);
  assert.deepEqual(enCurso, { tipo: 'reintentar_error', destino: 'bot_lanzando', reabrirResumen: false });
  const terminada = planReintento({ estado: 'error', estado_antes_error: 'bot_lanzando', origen: 'online', hora_fin_prevista: '2026-10-20T12:50:00Z' }, 'reintentar', false, ahora);
  assert.equal(terminada.tipo, 'manual');
  if (terminada.tipo === 'manual') assert.match(terminada.mensaje, /ya terminó/);
});

test('M5: la misma lógica sirve al botón de la ficha (reintentar.ts) y al del aviso', async () => {
  // Desde la ficha se llama con accion 'reintentar': si falló el resumen, se reabre igual.
  const a = ops('error', 'resumiendo', 'r9');
  const r = await ejecutarReintento('g1', 'reintentar', a.o);
  assert.deepEqual(a.llamadas, ['reintentar', 'reabrir:r9']);
  assert.equal(r.hacia, 'resumiendo');
});
