// Pruebas de la franja "Pendientes" de la ficha (17 oct 2026). Sin red. Correr: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';
import {
  calcularPendientes, claveValida, estaGestionado, leerGestionados, marcarGestionado, separarPendientes, textoValido,
  ID_PANEL_PAREJA, type EntradaPendientes,
} from './pendientes';

const base = (p: Partial<EntradaPendientes> = {}): EntradaPendientes => ({
  nombre: 'Camila Rojas', activo: true, email: 'c@ejemplo.cl', consentimientoPropio: true, faltaPareja: false,
  pasosEnviadosAt: '2026-10-01T00:00:00Z', tieneSesiones: true, faltanDatos: [], hrefInfo: '/admin/pacientes/x?tab=info', ...p,
});

test('sin nada pendiente: franja vacía', () => {
  assert.deepEqual(calcularPendientes(base()), []);
});

test('falta la firma de la pareja: una línea con "Enviar" que abre las opciones de la pareja', () => {
  const [p] = calcularPendientes(base({ faltaPareja: true }));
  assert.equal(p.clave, 'consentimiento_pareja');
  assert.equal(p.texto, 'Falta el consentimiento de la pareja');
  assert.deepEqual(p.accion, { tipo: 'consentimiento', panel: ID_PANEL_PAREJA });
  assert.equal(calcularPendientes(base({ faltaPareja: true, nombrePareja: 'Tomás Fuentes' }))[0].texto, 'Falta el consentimiento de Tomás');
});

test('consentimiento propio, pasos a seguir y datos de la ficha (pasos solo si se sabe que no se enviaron)', () => {
  const ps = calcularPendientes(base({ consentimientoPropio: false, pasosEnviadosAt: null, faltanDatos: ['RUT', 'comuna'] }));
  assert.deepEqual(ps.map((p) => p.clave), ['consentimiento_propio', 'pasos_a_seguir', 'datos_ficha:RUT,comuna']);
  assert.equal(ps[0].texto, 'Falta el consentimiento de Camila');
  assert.equal(calcularPendientes(base({ pasosEnviadosAt: undefined })).length, 0, 'columna ausente: no se inventa');
  assert.equal(calcularPendientes(base({ pasosEnviadosAt: null, activo: false })).length, 0, 'archivada: sin pasos');
  assert.equal(calcularPendientes(base({ pasosEnviadosAt: null, tieneSesiones: false })).length, 0);
});

test('"Ya está hecho": sale de la franja pero sigue abierto; si vuelve a faltar después (retiro), reaparece', () => {
  const todos = calcularPendientes(base({ faltaPareja: true }));
  const g = [{ clave: 'consentimiento_pareja', texto: 'x', gestionado_at: '2026-10-10T12:00:00Z' }];
  const r = separarPendientes(todos, g);
  assert.equal(r.visibles.length, 0);
  assert.equal(r.gestionadosAbiertos[0].clave, 'consentimiento_pareja');
  // Retiró la firma DESPUÉS de marcarlo: vuelve a aparecer.
  const tras = calcularPendientes(base({ faltaPareja: true, retiroPareja: '2026-10-12T00:00:00Z' }));
  assert.equal(separarPendientes(tras, g).visibles.length, 1);
  // Cuando la firma llega, el pendiente desaparece solo (ya no se calcula).
  assert.equal(calcularPendientes(base({ faltaPareja: false })).length, 0);
  assert.equal(estaGestionado({ clave: 'datos_ficha:RUT', desde: null }, [{ clave: 'datos_ficha:RUT,comuna', texto: '', gestionado_at: '2026-10-10' }]), false, 'otros datos faltantes: no cuenta');
});

test('validación de clave y texto del endpoint', () => {
  assert.equal(claveValida('consentimiento_pareja'), true);
  assert.equal(claveValida('datos_ficha:RUT,teléfono'), true);
  assert.equal(claveValida('cualquier_cosa'), false);
  assert.equal(claveValida('datos_ficha:<script>'), false);
  assert.equal(textoValido('  a\n b '), 'a b');
  assert.equal(textoValido(''), null);
  assert.equal(textoValido('x'.repeat(400))?.length, 300);
});

test('base: marcar y leer el historial; sin la tabla (0023) se lee vacío y marcar avisa', async () => {
  const db = new SupabaseMemoria();
  const p = randomUUID();
  await marcarGestionado(db.cliente, p, 'consentimiento_pareja', 'Falta el consentimiento de la pareja');
  const h = await leerGestionados(db.cliente, p);
  assert.equal(h.length, 1);
  assert.equal(h[0].clave, 'consentimiento_pareja');
  assert.deepEqual(await leerGestionados({ from: () => { throw new Error('sin tabla'); } } as never, p), []);
});

test('ronda 2: falta la fecha de nacimiento: pendiente con Completar que lleva al campo (sin ella no se graba)', () => {
  const [p] = calcularPendientes(base({ faltaNacimiento: true }));
  assert.equal(p.clave, 'fecha_nacimiento');
  assert.match(p.detalle ?? '', /no se graba/);
  assert.deepEqual(p.accion, { tipo: 'ir', href: '/admin/pacientes/x?tab=info#pf-nacimiento', etiqueta: 'Completar' });
  assert.equal(claveValida('fecha_nacimiento'), true);
  assert.deepEqual(calcularPendientes(base({ faltaNacimiento: false })), []);
});
