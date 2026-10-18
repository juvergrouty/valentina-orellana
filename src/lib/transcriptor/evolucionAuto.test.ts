// Evolución autollenada desde el resumen IA (evolucionAuto.ts). Sin red: Supabase en memoria.
// Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';
import { ACCION_EVOLUCION_AUTO, autollenarEvolucion, reasignarEvolucion, type GrabacionParaEvolucion } from './evolucionAuto';
import { ENCABEZADO_EVOLUCION_IA, esEvolucionDesdeResumen, textoEvolucionDesdeResumen } from './panel';

const MD = '## Resumen de la sesión\n### Temas\n- **Trabajo**: sobrecarga.\n### Tareas\n- Registrar momentos de calma.';

function base() {
  const db = new SupabaseMemoria();
  const pid = randomUUID();
  db.tabla('patients').push({ id: pid, name: 'Camila Rojas', email: 'camila@ejemplo.cl' });
  const bid = randomUUID();
  db.tabla('bookings').push({ id: bid, session_date: '2026-10-20', session_time: '18:00', session_type: 'presencial', status: 'confirmed', patient_email: 'camila@ejemplo.cl' });
  const g = (o: Partial<GrabacionParaEvolucion> = {}): GrabacionParaEvolucion =>
    ({ id: randomUUID(), patient_id: pid, booking_id: bid, session_date: '2026-10-20', tipo: 'individual', origen: 'presencial', ...o });
  const notas = () => db.tabla('session_notes');
  const bitacora = () => db.tabla('transcriptor_auditoria').filter((a) => a.accion === ACCION_EVOLUCION_AUTO);
  return { db, pid, bid, g, notas, bitacora };
}

test('texto: mismo formato que "Usar como base de mi evolución" (encabezado + texto plano)', () => {
  const t = textoEvolucionDesdeResumen(MD);
  assert.equal(t, `${ENCABEZADO_EVOLUCION_IA}\nTEMAS\n• Trabajo: sobrecarga.\nTAREAS\n• Registrar momentos de calma.`);
  assert.ok(esEvolucionDesdeResumen(t));
  assert.ok(!esEvolucionDesdeResumen('Mi evolución escrita a mano.'));
  assert.equal(textoEvolucionDesdeResumen(''), '');
  assert.equal(textoEvolucionDesdeResumen(null), '');
});

test('sesión sin evolución → se guarda con las mismas columnas que add_note y queda en la bitácora sin contenido', async () => {
  const e = base();
  const g = e.g();
  assert.equal(await autollenarEvolucion({ db: e.db.cliente, grabacion: g, contenido: MD, version: 1 }), 'guardada');
  assert.equal(e.notas().length, 1);
  const n = e.notas()[0];
  assert.deepEqual(
    { patient_id: n.patient_id, booking_id: n.booking_id, session_date: n.session_date, session_type: n.session_type, content: n.content },
    { patient_id: e.pid, booking_id: e.bid, session_date: '2026-10-20', session_type: 'presencial', content: textoEvolucionDesdeResumen(MD) },
  );
  const b = e.bitacora();
  assert.equal(b.length, 1);
  assert.equal(b[0].actor, 'sistema');
  assert.equal(b[0].resultado, 'ok');
  assert.equal(b[0].grabacion_id, g.id);
  assert.ok(!JSON.stringify(b[0].detalle).includes('calma'), 'la bitácora no lleva texto clínico');
});

test('grabación sin reserva → se guarda por fecha, con el tipo de la grabación', async () => {
  const e = base();
  assert.equal(await autollenarEvolucion({ db: e.db.cliente, grabacion: e.g({ booking_id: null, tipo: 'pareja', origen: 'online' }), contenido: MD }), 'guardada');
  assert.equal(e.notas()[0].booking_id, null);
  assert.equal(e.notas()[0].session_type, 'pareja-online');
});

test('ya hay evolución de Vale (por reserva, por fecha o archivada) → no se pisa ni se anexa', async () => {
  for (const nota of [
    { booking_id: 'RESERVA', session_date: '2026-10-20' },
    { booking_id: null, session_date: '2026-10-20' },
    { booking_id: 'RESERVA', session_date: '2026-10-20', deleted_at: '2026-10-21T10:00:00Z' },
  ]) {
    const e = base();
    const propia = { id: randomUUID(), patient_id: e.pid, session_type: 'presencial', content: 'Escrita por Vale.', historial: [], ...nota, booking_id: nota.booking_id ? e.bid : null };
    e.notas().push(propia);
    assert.equal(await autollenarEvolucion({ db: e.db.cliente, grabacion: e.g(), contenido: MD }), 'ya_hay_evolucion');
    assert.equal(e.notas().length, 1);
    assert.equal(e.notas()[0].content, 'Escrita por Vale.');
  }
});

test('idempotente: reintentos y regeneraciones del resumen no duplican ni pisan', async () => {
  const e = base();
  const g = e.g();
  assert.equal(await autollenarEvolucion({ db: e.db.cliente, grabacion: g, contenido: MD, version: 1 }), 'guardada');
  assert.equal(await autollenarEvolucion({ db: e.db.cliente, grabacion: g, contenido: MD, version: 1 }), 'ya_hay_evolucion');
  assert.equal(await autollenarEvolucion({ db: e.db.cliente, grabacion: g, contenido: MD.replace('calma', 'paz'), version: 2 }), 'ya_hay_evolucion');
  // Otra grabación de la misma sesión tampoco agrega otra.
  assert.equal(await autollenarEvolucion({ db: e.db.cliente, grabacion: e.g(), contenido: MD }), 'ya_hay_evolucion');
  assert.equal(e.notas().length, 1);
  assert.match(e.notas()[0].content, /calma/);
});

test('no se puede asociar a una sesión → no hace nada', async () => {
  const e = base();
  // Sin paciente
  assert.equal(await autollenarEvolucion({ db: e.db.cliente, grabacion: e.g({ patient_id: null }), contenido: MD }), 'sin_sesion');
  // La reserva no existe
  assert.equal(await autollenarEvolucion({ db: e.db.cliente, grabacion: e.g({ booking_id: randomUUID() }), contenido: MD }), 'sin_sesion');
  // La reserva es de otra persona
  const otra = randomUUID();
  e.db.tabla('bookings').push({ id: otra, session_date: '2026-10-20', session_type: 'online', status: 'confirmed', patient_email: 'otra@ejemplo.cl' });
  assert.equal(await autollenarEvolucion({ db: e.db.cliente, grabacion: e.g({ booking_id: otra }), contenido: MD }), 'sin_sesion');
  // Reserva "sin fecha" (2099-12-31, cobro manual)
  const sinFecha = randomUUID();
  e.db.tabla('bookings').push({ id: sinFecha, session_date: '2099-12-31', session_type: 'online', status: 'confirmed', patient_email: 'camila@ejemplo.cl' });
  assert.equal(await autollenarEvolucion({ db: e.db.cliente, grabacion: e.g({ booking_id: sinFecha }), contenido: MD }), 'sin_sesion');
  // Resumen vacío
  assert.equal(await autollenarEvolucion({ db: e.db.cliente, grabacion: e.g(), contenido: '' }), 'vacio');
  assert.equal(e.notas().length, 0);
});

test('fallo aislado: si la base falla no lanza, no deja nota y registra el error (sin el mensaje)', async () => {
  const e = base();
  const real = e.db.from.bind(e.db);
  (e.db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
    if (t !== 'session_notes') return real(t);
    const q = real(t) as unknown as Record<string, unknown>;
    // insert devuelve un error con datos de la fila en el mensaje: no debe llegar a la bitácora.
    q.insert = () => Promise.resolve({ data: null, error: { code: '23514', message: 'Failing row contains (Registrar momentos de calma)' } });
    return q;
  };
  const r = await autollenarEvolucion({ db: e.db.cliente, grabacion: e.g(), contenido: MD });
  assert.equal(r, 'error');
  assert.equal(e.notas().length, 0);
  const b = e.bitacora();
  assert.equal(b.length, 1);
  assert.equal(b[0].resultado, 'error');
  assert.deepEqual(b[0].detalle, { etapa: 'guardar_nota', codigo: '23514' });

  // Y si la base lanza (no solo devuelve error), tampoco se propaga.
  (e.db as unknown as { from: () => never }).from = () => { throw new Error('caída total'); };
  assert.equal(await autollenarEvolucion({ db: e.db.cliente, grabacion: e.g(), contenido: MD }), 'error');
});

test('reasignar: la copia intacta se archiva en la ficha anterior y se autollena en la nueva; una editada no se toca', async () => {
  const cifFalso = { cifrar: async () => { throw new Error('no'); }, descifrar: async () => { throw new Error('no'); } } as never;
  for (const editada of [false, true]) {
    const e = base();
    const g = e.g();
    e.db.tabla('resumenes_ia').push({ id: randomUUID(), grabacion_id: g.id, version: 1, autor: 'ia', estado: 'listo', contenido: MD, contenido_cifrado: null });
    assert.equal(await autollenarEvolucion({ db: e.db.cliente, grabacion: g, contenido: MD, version: 1 }), 'guardada');
    if (editada) Object.assign(e.notas()[0], { content: 'Corregida por Vale.', historial: [{ content: 'x' }] });
    // Ficha correcta: otra persona con su reserva de la misma sesión.
    const nuevo = randomUUID();
    e.db.tabla('patients').push({ id: nuevo, name: 'Rosa Vidal', email: 'rosa@ejemplo.cl' });
    const bNuevo = randomUUID();
    e.db.tabla('bookings').push({ id: bNuevo, session_date: '2026-10-20', session_type: 'online', status: 'confirmed', patient_email: 'rosa@ejemplo.cl' });
    const r = await reasignarEvolucion({ db: e.db.cliente, grabacion: { ...g, patient_id: nuevo, booking_id: bNuevo }, anteriorPatientId: e.pid, cif: cifFalso });
    const anterior = e.notas().filter((n) => n.patient_id === e.pid);
    const nuevas = e.notas().filter((n) => n.patient_id === nuevo);
    assert.equal(anterior.length, 1, 'nunca se borra');
    if (editada) {
      assert.equal(r.archivada, false);
      assert.equal(anterior[0].deleted_at ?? null, null, 'la editada por Vale queda');
    } else {
      assert.equal(r.archivada, true);
      assert.ok(anterior[0].deleted_at, 'la copia intacta queda archivada');
    }
    assert.equal(r.nueva, 'guardada');
    assert.equal(nuevas.length, 1);
    assert.equal(nuevas[0].booking_id, bNuevo);
  }
});

test('reasignar: un fallo no lanza y queda en la bitácora', async () => {
  const e = base();
  (e.db as unknown as { from: () => never }).from = () => { throw new Error('caída'); };
  const r = await reasignarEvolucion({ db: e.db.cliente, grabacion: e.g(), anteriorPatientId: randomUUID() });
  assert.equal(r.nueva, 'error');
});
