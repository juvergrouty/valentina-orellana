// Pruebas de "hora libre" al agendar/reagendar y de la boleta al marcar pagado (20 oct 2026).
// Correr: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizarHora, sesionesQueSeCruzan, avisosHora, debeEmitirBoleta, avisoBoletaPanel,
  pagoDelPanel, esPagoDelPanel, carrilesDelDia,
} from './horaLibre';

const leer = (ruta: string) => readFileSync(new URL(ruta, import.meta.url), 'utf8');

test('hora libre: acepta cualquier minuto (7:53), no solo múltiplos de 5 o 15', () => {
  assert.equal(normalizarHora('07:53'), '07:53');
  assert.equal(normalizarHora('7:53'), '07:53');
  assert.equal(normalizarHora('07:53:00'), '07:53');
  assert.equal(normalizarHora('23:59'), '23:59');
  assert.equal(normalizarHora('00:01'), '00:01');
});

test('hora libre: rechaza horas inválidas', () => {
  for (const t of ['', '24:00', '07:60', '7', 'abc', '07:5', null, undefined]) assert.equal(normalizarHora(t as string), null, String(t));
});

test('hora libre: detecta cruces con su duración y no cuenta la propia sesión', () => {
  const dia = [
    { id: 'a', session_time: '07:00:00', duration_min: 50, patient_name: 'Ana' },  // 07:00–07:50
    { id: 'b', session_time: '09:00', duration_min: null, patient_name: 'Bea' },    // 09:00–09:50 (50 por defecto)
  ];
  assert.deepEqual(sesionesQueSeCruzan('07:53', 50, dia), []);                     // justo después: no se cruza
  assert.deepEqual(sesionesQueSeCruzan('07:49', 50, dia).map((s) => s.id), ['a']);   // 1 minuto encima
  assert.deepEqual(sesionesQueSeCruzan('08:11', 50, dia).map((s) => s.id), ['b']);   // termina 09:01
  assert.deepEqual(sesionesQueSeCruzan('08:10', 50, dia), []);                     // termina 09:00 justo
  assert.deepEqual(sesionesQueSeCruzan('07:30', 50, dia, 'a'), []);                // reagendar la misma
});

test('hora libre: los avisos explican fuera de horario y cruces, y vacío si no hay nada', () => {
  assert.deepEqual(avisosHora({ hora: '07:53', primeraFecha: '2026-10-21', fueraDeHorario: false, cruces: [] }), []);
  assert.deepEqual(avisosHora({ hora: '07:53', primeraFecha: '2026-10-21', fueraDeHorario: null, cruces: [] }), []);
  const a = avisosHora({
    hora: '07:53', primeraFecha: '2026-10-21', fueraDeHorario: true,
    cruces: [{ id: 'x', session_date: '2026-10-28', session_time: '07:30:00', duration_min: 50, patient_name: 'Ana Pérez' }],
  });
  assert.equal(a.length, 2);
  assert.match(a[0], /07:53 del 21-10 no es una de tus horas disponibles/);
  assert.match(a[1], /Ana Pérez \(07:30–08:20\) el 28-10/);
});

test('boleta al marcar pagado: se emite con monto > 0 y casilla marcada, nunca en Sin costo ni $0', () => {
  assert.equal(debeEmitirBoleta({ medio: 'Transferencia', casillaMarcada: true, monto: 55000 }), true);
  assert.equal(debeEmitirBoleta({ medio: 'Efectivo', casillaMarcada: true, monto: 1 }), true);
  assert.equal(debeEmitirBoleta({ medio: 'Transferencia', casillaMarcada: false, monto: 55000 }), false);
  assert.equal(debeEmitirBoleta({ medio: 'Sin costo', casillaMarcada: true, monto: 55000 }), false);
  assert.equal(debeEmitirBoleta({ medio: 'Transferencia', casillaMarcada: true, monto: 0 }), false);
  assert.equal(debeEmitirBoleta({ medio: 'Transferencia', casillaMarcada: true, monto: null }), false);
});

test('boleta al marcar pagado: el panel dice claro qué pasó', () => {
  assert.equal(avisoBoletaPanel({ ok: true }, 123), 'boleta=emitida');
  assert.equal(avisoBoletaPanel({ ok: true }, null), 'boleta=emitida');
  const sinRut = decodeURIComponent(avisoBoletaPanel({ ok: true, nota: 'Falta el RUT del paciente.' }, null));
  assert.match(sinRut, /^error=boleta_failed&detail=falta el RUT de la paciente\. Agrégalo en su ficha/);
  const reintento = decodeURIComponent(avisoBoletaPanel({ ok: false, error: 'SII no responde' }, null));
  assert.equal(reintento, 'error=boleta_reintento&detail=SII no responde');
  assert.match(avisoBoletaPanel(null, null), /^error=boleta_reintento/);
  assert.equal(avisoBoletaPanel({ ok: true, nota: 'La boleta se emitirá automáticamente el día de la sesión (21-10).' }, null), 'boleta=programada');
});

test('boleta al marcar pagado: el pago del panel tiene su propio nombre en la cola', () => {
  const p = pagoDelPanel('2026-10-20T15:00:00.000Z');
  assert.equal(p, `panel-${Date.parse('2026-10-20T15:00:00.000Z')}`);
  assert.equal(esPagoDelPanel(`boleta#${p}`), true);
  assert.equal(esPagoDelPanel('boleta#123456'), false); // pago de Flow
  assert.equal(esPagoDelPanel('pasos#sincosto-1'), false);
});

// ── Lo que ve Valentina: los formularios del panel aceptan cualquier minuto ──
test('formularios del panel: ningún campo de hora para agendar/reagendar obliga a múltiplos de 5 o 15 min', () => {
  const agenda = leer('../pages/admin/agenda.astro');
  const ficha = leer('../pages/admin/pacientes/[id].astro');
  const cobros = leer('../pages/admin/cobros.astro');
  for (const [nombre, html, id] of [
    ['Agendar hora', agenda, 'bp-time'], ['Reagendar', agenda, 'sp-rsc-time'],
    ['Nueva sesión (ficha)', ficha, 'pt-bp-custom-time'], ['Cobros', cobros, 'cobro-time'],
  ] as const) {
    const m = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html);
    assert.ok(m, `${nombre}: no está el campo ${id}`);
    assert.match(m[0], /step="60"/, `${nombre}: debe aceptar cualquier minuto`);
  }
});

test('formularios del panel: "Emitir y enviar boleta" viene marcada al marcar como pagado', () => {
  const agenda = leer('../pages/admin/agenda.astro');
  const ficha = leer('../pages/admin/pacientes/[id].astro');
  const deudas = leer('../pages/admin/deudas.astro');
  for (const [nombre, html] of [['agenda', agenda], ['ficha', ficha], ['deudas', deudas]] as const) {
    const casillas = html.match(/<input type="checkbox" name="emitir_boleta"[^>]*>/g) ?? [];
    assert.ok(casillas.length > 0, `${nombre}: falta la casilla`);
    for (const c of casillas) assert.match(c, /\bchecked\b/, `${nombre}: la casilla debe venir marcada`);
  }
});

test('migración 0026: deja fuera de las reglas de cruce solo las sesiones aceptadas por Valentina', () => {
  const sql = leer('../../supabase/migrations/0026_cruce_permitido.sql');
  assert.match(sql, /add column if not exists cruce_permitido boolean not null default false/);
  assert.match(sql, /\(not cruce_permitido\)\)/);
  assert.match(sql, /and not cruce_permitido;/);
  assert.equal(/[^\x00-\x7F]/.test(sql), false, 'la migración debe ser solo ASCII (ver 0024)');
});

test('agenda: sesiones cruzadas a propósito se ven lado a lado (ninguna tapa a otra)', () => {
  const c = carrilesDelDia([
    { id: 'camila', session_time: '08:00:00', duration_min: 50 },
    { id: 'javiera', session_time: '07:53', duration_min: 50 },
    { id: 'tomas', session_time: '08:50', duration_min: 50 },  // empieza justo cuando termina Camila
    { id: 'sola', session_time: '12:00', duration_min: 50 },
  ]);
  assert.deepEqual(c.get('javiera'), { i: 0, n: 2 });
  assert.deepEqual(c.get('camila'), { i: 1, n: 2 });
  assert.deepEqual(c.get('tomas'), { i: 0, n: 1 });   // no se cruza con nadie: ancho completo
  assert.deepEqual(c.get('sola'), { i: 0, n: 1 });    // sin cruce: ancho completo
});

test('boleta al marcar pagado: errores que no se arreglan solos no prometen reintento', () => {
  const a = decodeURIComponent(avisoBoletaPanel({ ok: false, error: 'Una emisión anterior de esta boleta se interrumpió. Revisa en el SII si quedó emitida antes de volver a emitirla.' }, null));
  assert.match(a, /^error=boleta_failed/);
  assert.match(decodeURIComponent(avisoBoletaPanel({ ok: false, error: 'se agotaron los reintentos (SII caído)' }, null)), /^error=boleta_failed/);
  assert.match(decodeURIComponent(avisoBoletaPanel({ ok: false, error: 'API Gateway no configurado.' }, null)), /^error=boleta_failed/);
  // Un mensaje del SII que menciona el RUT (sin faltar) no se confunde con "falta el RUT".
  assert.match(decodeURIComponent(avisoBoletaPanel({ ok: true, nota: 'RUT receptor inválido' }, null)), /RUT receptor inválido\. Revisa el RUT en su ficha/);
});
