// Pruebas de la asociación de cobros de SumUp a sesiones (18 nov 2026). Correr: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enHoraChile, enVentana, sesionParaCobro, sesionCobrable, pagoSumUp, codigoDePago, codigoValido } from './sumupMatch';

const ses = (o: Record<string, unknown> = {}) => ({ id: 'a', session_date: '2026-11-18', session_time: '18:00:00', duration_min: 50, amount: 55000, status: 'confirmed', paid_at: null, debt_voided: false, ...o });
// 21:46 UTC = 18:46 en Chile (verano, UTC-3): el cobro de prueba real del 18 nov 2026.
const cobro = (o: Record<string, unknown> = {}) => ({ codigo: 'TAAA7KP96YY', monto: 55000, cuando: '2026-11-18T21:46:08.166Z', modo: 'contactless', ...o });

test('hora de Chile sin depender del huso del servidor', () => {
  assert.deepEqual(enHoraChile('2026-11-18T21:46:08.166Z'), { fecha: '2026-11-18', minuto: 18 * 60 + 46 });
  // Pasada la medianoche UTC sigue siendo el día anterior en Chile.
  assert.equal(enHoraChile('2026-11-19T02:30:00Z').fecha, '2026-11-18');
  // Invierno (UTC-4).
  assert.deepEqual(enHoraChile('2026-06-10T14:00:00Z'), { fecha: '2026-06-10', minuto: 10 * 60 });
});

test('ventana: de 30 min antes a 90 min después de terminar, mismo día', () => {
  assert.equal(enVentana(cobro(), ses()), true);
  assert.equal(enVentana(cobro({ cuando: '2026-11-18T20:30:00Z' }), ses()), true);   // 17:30, 30 min antes
  assert.equal(enVentana(cobro({ cuando: '2026-11-18T20:29:00Z' }), ses()), false);  // 17:29
  assert.equal(enVentana(cobro({ cuando: '2026-11-18T23:20:00Z' }), ses()), true);   // 20:20 = 18:50 + 90 min
  assert.equal(enVentana(cobro({ cuando: '2026-11-18T23:21:00Z' }), ses()), false);
  assert.equal(enVentana(cobro(), ses({ session_date: '2026-11-17' })), false);
});

test('solo asocia sola cuando hay una única sesión posible', () => {
  assert.equal(sesionParaCobro(cobro(), [ses()])?.id, 'a');
  assert.equal(sesionParaCobro(cobro(), [ses({ amount: 45000 })]), null);                 // otro monto
  assert.equal(sesionParaCobro(cobro(), [ses(), ses({ id: 'b', session_time: '19:00' })]), null); // dos posibles: pregunta
  assert.equal(sesionParaCobro(cobro(), [ses({ status: 'cancelled' })]), null);
  assert.equal(sesionParaCobro(cobro(), [ses({ debt_voided: true })]), null);
  assert.equal(sesionParaCobro(cobro(), [ses({ status: 'expired' })]), null);            // reserva web vencida
  assert.equal(sesionParaCobro(cobro({ modo: 'customer_entry' }), [ses()]), null);         // pago por link: nunca por hora
  assert.equal(sesionParaCobro(cobro({ modo: 'chip' }), [ses()])?.id, 'a');
  assert.equal(sesionParaCobro(cobro(), [ses(), ses({ id: 'b', session_time: '10:00' })])?.id, 'a'); // la de la mañana no cuenta
  assert.equal(sesionParaCobro(cobro(), [ses(), ses({ id: 'b', session_time: '19:00', status: 'cancelled' })])?.id, 'a');
});

test('una sesión ya pagada en la misma ventana deja el cobro por asociar (nunca a otra paciente)', () => {
  // X (17:00, ya pagada por Flow) y Y (18:00, sin pagar, mismo monto): el cobro de las 18:46 puede ser de X.
  assert.equal(sesionParaCobro(cobro(), [ses({ id: 'x', session_time: '17:00', paid_at: '2026-11-18T10:00:00Z' }), ses({ id: 'y' })]), null);
  // Una sesión de otro monto en la misma ventana también deja la duda.
  assert.equal(sesionParaCobro(cobro(), [ses({ id: 'x', session_time: '17:30', amount: 40000 }), ses({ id: 'y' })]), null);
  // La única sesión en la ventana ya está pagada: no se asocia.
  assert.equal(sesionParaCobro(cobro(), [ses({ paid_at: '2026-11-18T10:00:00Z' })]), null);
});

test('sesión cobrable', () => {
  assert.equal(sesionCobrable(ses()), true);
  assert.equal(sesionCobrable(ses({ amount: 0 })), false);
  assert.equal(sesionCobrable(ses({ session_date: '2099-12-31' })), false);
});

test('código del cobro en mp_payment_id', () => {
  assert.equal(pagoSumUp('TAAA7KP96YY'), 'sumup-TAAA7KP96YY');
  assert.equal(codigoDePago('sumup-TAAA7KP96YY'), 'TAAA7KP96YY');
  assert.equal(codigoDePago('transferencia-123'), null);
  assert.equal(codigoValido('TAAA7KP96YY'), true);
  assert.equal(codigoValido("x' or 1=1"), false);
});
