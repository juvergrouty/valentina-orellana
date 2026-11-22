// Pruebas de la comparación con el correo del banco (22 nov 2026). Correr: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traeMonto, traeNombre, compararCorreo, consultaGmail, textoDeMensaje, remitenteDelBanco } from './gmailBancoUtil';

test('monto exacto en sus formatos chilenos', () => {
  assert.equal(traeMonto('Monto: $65.000', 65000), true);
  assert.equal(traeMonto('monto $ 65000.', 65000), true);
  assert.equal(traeMonto('Total 65.000,00 CLP', 65000), true);
  assert.equal(traeMonto('Monto: $165.000', 65000), false);
  assert.equal(traeMonto('Monto: $65.0001', 65000), false);
  assert.equal(traeMonto('Monto: $65.000.000', 65000), false);
  assert.equal(traeMonto('Monto: $75.000', 65000), false);
});

test('nombre: nombre y apellido, sin tildes ni mayúsculas', () => {
  assert.equal(traeNombre('Te transfirió JOSÉ PÉREZ GONZÁLEZ', ['José Pérez']), true);
  assert.equal(traeNombre('Te transfirió José Soto', ['José Pérez']), false);
  assert.equal(traeNombre('Origen: Ana', ['Ana']), true);
  // Varios nombres posibles (paciente o titular de la cuenta).
  assert.equal(traeNombre('Transferencia de MARIA LOPEZ', ['Pedro Rojas', 'María López']), true);
});

test('comparación: ok, dudoso o no', () => {
  const aviso = 'Recibiste una transferencia de Juan Pérez por $65.000';
  assert.equal(compararCorreo(aviso, 65000, ['Juan Pérez']), 'ok');
  assert.equal(compararCorreo(aviso, 65000, ['Ana Soto']), 'dudoso');
  assert.equal(compararCorreo(aviso, 75000, ['Juan Pérez']), 'no');
  assert.equal(compararCorreo('Oferta: zapatillas a $65.000', 65000, ['Juan Pérez']), 'no');
  // Sin remitente del banco nunca es 'ok'.
  assert.equal(compararCorreo(aviso, 65000, ['Juan Pérez'], false), 'dudoso');
  // El propio aviso del sitio y las transferencias que hace Vale no cuentan.
  assert.equal(compararCorreo('Comprobante de transferencia por confirmar: Juan Pérez · $65.000', 65000, ['Juan Pérez']), 'no');
  assert.equal(compararCorreo('Transferencia realizada a Juan Pérez por $65.000', 65000, ['Juan Pérez']), 'no');
});

test('remitente del banco', () => {
  assert.equal(remitenteDelBanco('Banco Santander <avisos@santander.cl>', 'santander.cl'), true);
  assert.equal(remitenteDelBanco('<x@mail.santander.cl>', 'santander.cl'), true);
  assert.equal(remitenteDelBanco('Falso <santander.cl@gmail.com>', 'santander.cl'), false);
  assert.equal(remitenteDelBanco('avisos@santander.cl', 'avisos@santander.cl'), true);
  assert.equal(remitenteDelBanco('avisos@santander.cl', ''), false);
});

test('búsqueda de Gmail: monto, ventana de fechas y remitente', () => {
  const q = consultaGmail(65000, Date.parse('2026-11-22T12:00:00Z'), 'santander.cl');
  assert.match(q, /"65\.000" OR "65000"/);
  assert.match(q, /after:\d+ before:\d+/);
  assert.match(q, /from:santander\.cl$/);
  assert.doesNotMatch(consultaGmail(65000, Date.now(), 'x" OR y'), /"y/);
});

test('texto de un mensaje: plano o html', () => {
  const b64 = (t: string) => Buffer.from(t).toString('base64url');
  const plano = textoDeMensaje({ payload: { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('Monto $65.000') } }] } });
  assert.match(plano, /\$65\.000/);
  const html = textoDeMensaje({ payload: { mimeType: 'text/html', body: { data: b64('<p>Monto&nbsp;<b>$65.000</b></p>') } } });
  assert.match(html, /Monto \$65\.000/);
});
