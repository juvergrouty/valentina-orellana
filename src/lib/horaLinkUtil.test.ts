// Pruebas del link a una hora (22 nov 2026). Correr: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  retencionHoras, calcularVence, tokenValido, correoValido, fechaLarga, venceTexto, mensajeHoraWhatsapp,
  mensajePasosWhatsapp, enlaceWhatsapp, esHoraLink, tieneMarca, origenValido,
} from './horaLinkUtil';

test('retención: 24 h por defecto y dentro del rango', () => {
  assert.equal(retencionHoras(null), 24);
  assert.equal(retencionHoras(''), 24);
  assert.equal(retencionHoras('abc'), 24);
  assert.equal(retencionHoras('0'), 24);
  assert.equal(retencionHoras('500'), 24);
  assert.equal(retencionHoras('12'), 12);
  assert.equal(retencionHoras('1,5'), 1.5);
});

test('vence: nunca después del comienzo de la sesión', () => {
  const ahora = Date.parse('2026-11-22T12:00:00Z');
  assert.equal(calcularVence(ahora, 24, 72 * 3600_000).toISOString(), '2026-11-23T12:00:00.000Z');
  assert.equal(calcularVence(ahora, 24, 5 * 3600_000).toISOString(), '2026-11-22T17:00:00.000Z');
});

test('token, correo y origen', () => {
  assert.equal(tokenValido('abcdefghijklmnopqrstuvwx'), true);
  assert.equal(tokenValido('corto'), false);
  assert.equal(tokenValido('abc/../defghijklmnopqrstuvwx'), false);
  assert.equal(correoValido('ana@gmail.com'), true);
  assert.equal(correoValido('ana@gmail'), false);
  assert.equal(correoValido('ana gmail.com'), false);
  assert.equal(origenValido('asistente'), 'asistente');
  assert.equal(origenValido('x'), 'otro');
});

test('fechas en español y en hora de Chile', () => {
  assert.equal(fechaLarga('2026-11-25'), 'miércoles 25 de noviembre');
  // 21:00 UTC = 18:00 en Chile (verano).
  assert.equal(venceTexto('2026-11-24T21:00:00Z'), 'martes 24 de noviembre a las 18:00');
});

test('mensaje de WhatsApp: cercano, con link y plazo, mayúscula inicial', () => {
  const m = mensajeHoraWhatsapp({ nombre: 'ana maría soto', fecha: '2026-11-25', hora: '18:00', online: true, url: 'https://x.cl/hora/abc', venceIso: '2026-11-24T21:00:00Z' });
  assert.match(m, /^Hola Ana,/);
  assert.match(m, /miércoles 25 de noviembre a las 18:00 \(online\)/);
  assert.match(m, /https:\/\/x\.cl\/hora\/abc/);
  assert.match(m, /hasta el martes 24 de noviembre a las 18:00/);
  for (const linea of m.split('\n')) assert.match(linea, /^[A-ZÁÉÍÓÚÑ]/);
});

test('pasos por WhatsApp: online con Meet, presencial con dirección', () => {
  const on = mensajePasosWhatsapp({ nombre: 'Ana', fecha: '2026-11-25', hora: '18:00', online: true, meet: 'https://meet.google.com/abc-defg-hij', pasosUrl: 'https://x.cl/pasos-a-seguir/k' });
  assert.match(on, /meet\.google\.com\/abc-defg-hij/);
  assert.match(on, /pasos-a-seguir/);
  const pres = mensajePasosWhatsapp({ nombre: 'Ana', fecha: '2026-11-25', hora: '18:00', online: false, direccion: 'Av. Apoquindo 1234, Las Condes' });
  assert.match(pres, /Te espero en Av\. Apoquindo 1234/);
  for (const linea of pres.split('\n')) assert.match(linea, /^[A-ZÁÉÍÓÚÑ]/);
});

test('wa.me con número chileno o sin número', () => {
  assert.equal(enlaceWhatsapp('+56912345678', 'hola'), 'https://wa.me/56912345678?text=hola');
  assert.equal(enlaceWhatsapp('912345678', 'hola'), 'https://wa.me/56912345678?text=hola');
  assert.equal(enlaceWhatsapp('', 'hola'), 'https://wa.me/?text=hola');
});

test('marcas en las notas: no confunde una con otra', () => {
  const n = 'algo\nHoraLink 2026-11-22T12:00:00Z panel\nHoraLinkVencidaVista 2026-11-23';
  assert.equal(esHoraLink(n), true);
  assert.equal(esHoraLink('HoraLinkVencida 2026'), false);
  assert.equal(tieneMarca(n, 'HoraLinkVencida'), false);
  assert.equal(tieneMarca(n, 'HoraLinkVencidaVista'), true);
});
