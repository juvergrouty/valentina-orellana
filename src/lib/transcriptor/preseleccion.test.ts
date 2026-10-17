import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preseleccion, type Elegible } from './preseleccion';

const c = (o: Partial<Elegible>): Elegible => ({ clave: 'x', bookingId: null, googleEventId: null, patientId: null, faltaMin: 0, dur: 50, ...o });
const lista: Elegible[] = [
  c({ clave: 'r:b1', bookingId: 'b1', patientId: 'p1', faltaMin: -200 }), // ya terminó
  c({ clave: 'g:e1', googleEventId: 'e1', patientId: 'p1', faltaMin: 90 }),
  c({ clave: 'r:b2', bookingId: 'b2', patientId: 'p2', faltaMin: 5 }),
  c({ clave: 'g:e2', googleEventId: 'e2', patientId: null, faltaMin: -10 }),
];

test('?sesion elige esa reserva aunque haya terminado', () => {
  assert.deepEqual(preseleccion(lista, { sesion: 'b1' }), { modo: 'sesion', clave: 'r:b1' });
});

test('?evento elige el evento de Google Calendar', () => {
  assert.deepEqual(preseleccion(lista, { evento: 'e2' }), { modo: 'sesion', clave: 'g:e2' });
});

test('?evento duplicado de una reserva usa la candidata que quedó', () => {
  assert.deepEqual(preseleccion(lista, { evento: 'eDup' }, { eDup: 'r:b2' }), { modo: 'sesion', clave: 'r:b2' });
});

test('?evento desconocido sin paciente no preselecciona', () => {
  assert.equal(preseleccion(lista, { evento: 'nada' }), null);
  assert.equal(preseleccion(lista, { evento: 'toString' }), null);
});

test('?paciente con sesión hoy elige la que no ha terminado', () => {
  assert.deepEqual(preseleccion(lista, { paciente: 'p1' }), { modo: 'sesion', clave: 'g:e1' });
  assert.deepEqual(preseleccion(lista, { paciente: 'p2' }), { modo: 'sesion', clave: 'r:b2' });
});

test('?paciente sin sesión hoy → grabar sin reserva para ese paciente', () => {
  assert.deepEqual(preseleccion(lista, { paciente: 'p9' }), { modo: 'ficha', patientId: 'p9' });
  assert.deepEqual(preseleccion([c({ clave: 'r:b1', bookingId: 'b1', patientId: 'p1', faltaMin: -60 })], { paciente: 'p1' }), { modo: 'ficha', patientId: 'p1' });
});

test('?evento no encontrado cae a ?paciente', () => {
  assert.deepEqual(preseleccion(lista, { evento: 'nada', paciente: 'p2' }), { modo: 'sesion', clave: 'r:b2' });
});

test('sin parámetros no preselecciona', () => {
  assert.equal(preseleccion(lista, {}), null);
});
