// Pruebas del panel del robot de Meet (modo y sesión de su cuenta, panel.ts al final), del QR del
// consentimiento de la pareja (qr.ts) y del envío por correo (pareja.ts). Sin red.
// Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estadoSesionRobot, textoAsistenteMeet, validarModoBot, TEXTO_SESION_ROBOT, AJUSTE_BOT_MODO } from './panel';
import { modulosQr, qrSvg } from './qr';
import { correoParejaValido, resumenEstadoPareja } from './pareja';

test('robot: estado de la sesión de su cuenta (sin sesión / activa / vencida)', () => {
  assert.equal(AJUSTE_BOT_MODO, 'transcriptor_bot_modo');
  assert.equal(estadoSesionRobot(null), 'sin_sesion');
  assert.equal(estadoSesionRobot({ cuenta_email: null, estado: 'vencida' }), 'sin_sesion');
  assert.equal(estadoSesionRobot({ cuenta_email: 'notas@gmail.com', estado: 'vigente' }), 'activa');
  assert.equal(estadoSesionRobot({ cuenta_email: 'notas@gmail.com', estado: 'vencida' }), 'vencida');
  assert.match(TEXTO_SESION_ROBOT.vencida, /§7\.3/);
});

test('robot: en modo cuenta con sesión activa el texto ya NO dice "Tú lo admites en Meet"', () => {
  assert.match(textoAsistenteMeet('invitado', 'sin_sesion'), /Tú lo admites en Meet\./);
  const cuenta = textoAsistenteMeet('cuenta', 'activa');
  assert.ok(!cuenta.includes('Tú lo admites en Meet'));
  assert.match(cuenta, /sin pedir permiso/);
  // Modo cuenta pero la sesión venció: entra como invitado, así que sí hay que admitirlo (y lo dice).
  assert.match(textoAsistenteMeet('cuenta', 'vencida'), /tú lo admites en Meet/);
});

test('robot: validación del modo', () => {
  assert.deepEqual(validarModoBot('invitado', 'sin_sesion'), { ok: true, valor: 'invitado' });
  assert.deepEqual(validarModoBot('invitado', 'error'), { ok: true, valor: 'invitado' }, 'volver a invitado siempre se puede');
  assert.deepEqual(validarModoBot('cuenta', 'activa'), { ok: true, valor: 'cuenta' });
  assert.deepEqual(validarModoBot('cuenta', 'vencida'), { ok: true, valor: 'cuenta' });
  const sin = validarModoBot('cuenta', 'sin_sesion');
  assert.equal(sin.ok, false);
  if (!sin.ok) assert.match(sin.error, /iniciar sesión una vez/);
  assert.equal(validarModoBot('cuenta', 'error').ok, false);
  for (const malo of ['Cuenta', 'true', '', null, 1]) assert.deepEqual(validarModoBot(malo, 'activa'), { ok: false, error: 'Valor no válido.' });
});

test('QR: SVG cuadrado con margen de 4 módulos y patrones de esquina; sin URLs externas', () => {
  const url = 'https://www.valentinaorellana.cl/consentimiento/Xx7Qm2LpR4vN9sKe1Tz0aB3cXx7Qm2Lp';
  const n = modulosQr(url);
  assert.ok(n >= 29 && n <= 49, `tamaño razonable para un link (${n})`);
  const svg = qrSvg(url, { titulo: 'QR <de> prueba' });
  assert.match(svg, new RegExp(`viewBox="0 0 ${n + 8} ${n + 8}"`));
  assert.ok(svg.includes('M4 4h7v1h-7z'), 'fila superior del patrón de esquina (7 módulos oscuros)');
  assert.ok(svg.includes('<title>QR de prueba</title>'), 'el título se limpia');
  assert.ok(!svg.includes(url), 'el link no queda como texto dentro del SVG');
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(svg), 'no apunta a ningún servicio externo');
  assert.notEqual(qrSvg(url), qrSvg(`${url}x`));
});

test('pareja: correo para enviar el link (no se guarda) y estado sin RUT', () => {
  assert.equal(correoParejaValido('  Ana.Soto@Gmail.com '), 'ana.soto@gmail.com');
  for (const m of ['', 'ana', 'ana@', '@gmail.com', 'ana@gmail', 'ana..soto@gmail.com', 'ana soto@gmail.com', `${'a'.repeat(120)}@x.cl`, 7, null]) {
    assert.equal(correoParejaValido(m), null, `debió rechazar ${JSON.stringify(m)}`);
  }
  assert.deepEqual(resumenEstadoPareja({ firma: null, retirada: null, pendiente: null }), { firmado: false, nombre: null, firmado_at: null });
  const r = resumenEstadoPareja({ firma: { id: 'c2', signed_at: '2026-10-16T13:00:00Z', signer_name: ' Ana Soto ', signer_rut: '11.111.111-1' } as never, retirada: null, pendiente: null });
  assert.deepEqual(r, { firmado: true, nombre: 'Ana Soto', firmado_at: '2026-10-16T13:00:00Z' });
  assert.ok(!JSON.stringify(r).includes('11.111'), 'nunca devuelve el RUT');
});
