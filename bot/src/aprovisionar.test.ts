// Pruebas del modo MODO=iniciar_sesion (lógica pura, sin red ni navegador). Correr: cd bot && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  archivoTieneCookiesDeSesion, armarCuerpoSesionInicial, argumentosChromeNormal, BANDERAS_AUTOMATIZACION,
  cabecerasAprovisionar, cookiesFaltantesEnCrudo, correoEnListaCuentas, explicarRespuesta, faltanCookiesRequeridas,
  leerConfigInicio, mensajeSeguro, prepararSesion, MAX_SESION_BYTES, PLAZO_DEFECTO_MS,
} from './aprovisionar.js';

const SECRETO = 'S'.repeat(48);
const ENV = {
  BOT_CUENTA_EMAIL: 'Notas@ValentinaOrellana.cl',
  EVENTO_URL: 'https://www.valentinaorellana.cl/api/transcriptor/bot-evento',
  BOT_APROVISIONAR: SECRETO,
};
const ck = (name: string, domain = '.google.com', value = `valor-${name}-123456`) => ({
  name, value, domain, path: '/', expires: 2_000_000_000, httpOnly: true, secure: true, sameSite: 'None', extra: 'x',
});
const crudoCompleto = () => ({
  cookies: [ck('SID'), ck('__Secure-1PSID'), ck('__Secure-3PSID'), ck('HSID'), ck('sesion', '.valentinaorellana.cl'), ck('NID', '.youtube.com')],
  origins: [
    { origin: 'https://meet.google.com', localStorage: [{ name: 'a', value: '1' }] },
    { origin: 'https://evil.example', localStorage: [{ name: 'b', value: '2' }] },
  ],
});

test('config: valida correo, https, secreto y plazo; el error nunca trae el secreto', () => {
  const c = leerConfigInicio(ENV);
  assert.equal(c.correo, 'notas@valentinaorellana.cl');
  assert.equal(c.plazoMs, PLAZO_DEFECTO_MS);
  assert.equal(leerConfigInicio({ ...ENV, PLAZO_INICIO_MS: '120000' }).plazoMs, 120_000);
  assert.throws(() => leerConfigInicio({ ...ENV, BOT_APROVISIONAR: undefined }), /BOT_APROVISIONAR/);
  assert.throws(() => leerConfigInicio({ ...ENV, BOT_CUENTA_EMAIL: 'no-es-correo' }), /BOT_CUENTA_EMAIL/);
  assert.throws(() => leerConfigInicio({ ...ENV, EVENTO_URL: 'http://www.valentinaorellana.cl/x' }), /https/);
  assert.throws(() => leerConfigInicio({ ...ENV, PLAZO_INICIO_MS: '5' }), /PLAZO_INICIO_MS/);
  const corto = 'corto con espacio';
  try { leerConfigInicio({ ...ENV, BOT_APROVISIONAR: corto }); assert.fail('debió lanzar'); } catch (e) {
    assert.match((e as Error).message, /formato inválido/);
    assert.ok(!(e as Error).message.includes(corto));
  }
});

test('Chromium normal: perfil temporal, accounts.google.com y SIN banderas de automatización', () => {
  const a = argumentosChromeNormal('/tmp/vo-perfil-x');
  assert.ok(a.includes('--user-data-dir=/tmp/vo-perfil-x'));
  assert.ok(a.includes('--password-store=basic'));
  assert.match(a[a.length - 1], /^https:\/\/accounts\.google\.com\//);
  for (const b of BANDERAS_AUTOMATIZACION) assert.ok(!a.some((x) => x.includes(b)), `no debe llevar ${b}`);
  assert.ok(!a.includes('--no-sandbox'));
  assert.ok(argumentosChromeNormal('/tmp/p', { sandbox: false }).includes('--no-sandbox'));
});

test('detección en el archivo de cookies: exige 1PSID y 3PSID de google.com', () => {
  assert.equal(archivoTieneCookiesDeSesion(Buffer.from('SQLite format 3\0.google.com\0NID\0')), false);
  assert.equal(archivoTieneCookiesDeSesion(Buffer.from('\0.google.com\0__Secure-1PSID\0')), false);
  assert.equal(archivoTieneCookiesDeSesion(Buffer.from('\0.google.com\0__Secure-1PSID\0\x01\0.google.com\0__Secure-3PSID\0')), true);
});

test('cookies requeridas: SID, __Secure-1PSID y __Secure-3PSID, todas en google.com', () => {
  assert.deepEqual(faltanCookiesRequeridas({ cookies: [ck('SID'), ck('__Secure-1PSID'), ck('__Secure-3PSID')] as never, origins: [] }), []);
  assert.deepEqual(faltanCookiesRequeridas({ cookies: [ck('SID'), ck('__Secure-1PSID', '.evil.com')] as never, origins: [] }), ['__Secure-1PSID', '__Secure-3PSID']);
  assert.deepEqual(cookiesFaltantesEnCrudo({ cookies: [ck('SID')] }), ['__Secure-1PSID', '__Secure-3PSID']);
  assert.deepEqual(cookiesFaltantesEnCrudo(null), ['SID', '__Secure-1PSID', '__Secure-3PSID']);
});

test('filtro: deja solo google.com, solo los campos del formato y respeta el tope', () => {
  const e = prepararSesion(crudoCompleto());
  assert.ok(e);
  assert.deepEqual(e.cookies.map((c) => c.name), ['SID', '__Secure-1PSID', '__Secure-3PSID', 'HSID']);
  assert.ok(e.cookies.every((c) => c.domain === '.google.com'));
  assert.deepEqual(Object.keys(e.cookies[0]).sort(), ['domain', 'expires', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'value']);
  assert.deepEqual(e.origins.map((o) => o.origin), ['https://meet.google.com']);
  assert.equal(prepararSesion({ cookies: [ck('SID'), ck('HSID')], origins: [] }), null);
  assert.equal(prepararSesion('basura'), null);
  // localStorage enorme: se descarta y quedan las cookies.
  const grande = crudoCompleto();
  grande.origins[0].localStorage = [{ name: 'x', value: 'y'.repeat(MAX_SESION_BYTES) }];
  const g = prepararSesion(grande);
  assert.ok(g);
  assert.deepEqual(g.origins, []);
});

test('correo en la lista de cuentas: coincidencia exacta, sin distinguir mayúsculas', () => {
  const t = '["gaia.l.a.r",[["gaia.l.a",1,"Notas Ps. Valentina Orellana","Notas@valentinaorellana.cl","https://x/foto.jpg",1,1,0]]]';
  assert.equal(correoEnListaCuentas(t, 'notas@valentinaorellana.cl'), true);
  assert.equal(correoEnListaCuentas(t, 'vinculosquesostienen@gmail.com'), false);
  assert.equal(correoEnListaCuentas('["x","otranotas@valentinaorellana.cl"]', 'notas@valentinaorellana.cl'), false);
  assert.equal(correoEnListaCuentas('', 'notas@valentinaorellana.cl'), false);
});

test('cuerpo y cabeceras: el formato exacto de procesarSesionInicial', () => {
  const e = prepararSesion(crudoCompleto())!;
  const cuerpo = JSON.parse(armarCuerpoSesionInicial(' Notas@ValentinaOrellana.cl ', e));
  assert.deepEqual(Object.keys(cuerpo), ['tipo', 'correo', 'sesion']);
  assert.equal(cuerpo.tipo, 'sesion_inicial');
  assert.equal(cuerpo.correo, 'notas@valentinaorellana.cl');
  assert.deepEqual(cuerpo.sesion, e);
  const h = cabecerasAprovisionar(SECRETO);
  assert.equal(h['X-VO-Aprovisionar'], '1');
  assert.equal(h.Authorization, `Bearer ${SECRETO}`);
  assert.match(h.Authorization, /^Bearer (\S{32,200})$/); // misma regla que aprovisionamientoValido del sitio
});

test('mensajes seguros: nunca muestran el secreto ni valores de cookies', () => {
  const e = prepararSesion(crudoCompleto())!;
  const m = mensajeSeguro(`falló con ${SECRETO} y valor-SID-123456\n`, SECRETO, e);
  assert.ok(!m.includes(SECRETO));
  assert.ok(!m.includes('valor-SID-123456'));
  assert.match(explicarRespuesta(404), /BOT_APROVISIONAR/);
  assert.match(explicarRespuesta(503, 'No se pudo guardar (¿falta la migración 0022?)'), /0022/);
});
