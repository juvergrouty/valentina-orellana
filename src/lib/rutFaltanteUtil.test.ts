// Pruebas del aviso obligatorio de RUT (23 nov 2026). Correr: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faltaRutParaBoleta, tieneBoletaVigente, desdeRutFaltante } from './rutFaltanteUtil';

const pagada = { paid_at: '2026-11-22T15:00:00Z', amount: 65000, status: 'confirmed', payment_note: 'Flow', notes: '', patient_rut: '' };

test('sesión pagada sin RUT en ningún lado: falta el RUT', () => {
  assert.equal(faltaRutParaBoleta(pagada, null), true);
  assert.equal(faltaRutParaBoleta(pagada, { rut: '', sin_rut: false }), true);
  assert.equal(faltaRutParaBoleta({ ...pagada, patient_rut: '11.111.111-2' }, null), true); // RUT inválido no cuenta
});

test('con RUT válido (sesión o ficha) o «no tiene RUT»: no falta', () => {
  assert.equal(faltaRutParaBoleta({ ...pagada, patient_rut: '11.111.111-1' }, null), false);
  assert.equal(faltaRutParaBoleta(pagada, { rut: '11111111-1' }), false);
  assert.equal(faltaRutParaBoleta(pagada, { rut: null, sin_rut: true }), false);
});

test('sin pago, sin costo, anulada, deuda anulada, boleta emitida o SumUp sin boleta: no avisa', () => {
  assert.equal(faltaRutParaBoleta({ ...pagada, paid_at: null }, null), false);
  assert.equal(faltaRutParaBoleta({ ...pagada, amount: 0 }, null), false);
  assert.equal(faltaRutParaBoleta({ ...pagada, payment_note: 'Sin costo' }, null), false);
  assert.equal(faltaRutParaBoleta({ ...pagada, status: 'cancelled' }, null), false);
  assert.equal(faltaRutParaBoleta({ ...pagada, debt_voided: true }, null), false);
  assert.equal(faltaRutParaBoleta({ ...pagada, notes: 'Boleta Folio 288 Cod ABC' }, null), false);
  assert.equal(faltaRutParaBoleta({ ...pagada, notes: 'Cobro con tarjeta SumUp X de $65.000 del 18:00, asociado sin boleta' }, null), false);
});

test('pagada sin boleta a propósito (casilla desmarcada): no avisa', () => {
  assert.equal(faltaRutParaBoleta({ ...pagada, notes: 'SinBoletaAProposito 2026-11-22T15:00:00Z' }, null), false);
});

test('ventana: desde el 1° del mes anterior (lo que acepta el SII con la fecha del pago)', () => {
  assert.equal(desdeRutFaltante('2026-11-23'), '2026-10-01');
  assert.equal(desdeRutFaltante('2026-01-05'), '2025-12-01');
});

test('boleta anulada vuelve a pedir RUT', () => {
  assert.equal(tieneBoletaVigente('Boleta Folio 288 Cod ABC\nBoleta Folio 288 ANULADA'), false);
  assert.equal(faltaRutParaBoleta({ ...pagada, notes: 'Boleta Folio 288 ANULADA' }, null), true);
});
