// Pruebas de las reglas de passkey. Correr: npx -y tsx@4.23.15 --test src/lib/passkey/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codigoCoincide, configRp, crearTokenPaso, generarCodigosRespaldo, hashCodigo, leerTokenPaso, nombrePasskey,
  normalizarCodigo, pasoDespuesDeContrasena, puedeEliminar, puedeGestionar, puedeOmitirPasskey, sesionSuficiente,
  DURACION_PASO_MS,
} from './nucleo';

// [cantidad, obligatoria] → [sesión solo contraseña sirve, pide passkey tras contraseña, puede omitir]
const TABLA: [number, boolean, boolean, 'sesion' | 'pedir_passkey', boolean][] = [
  [0, false, true,  'sesion',        true],
  [0, true,  true,  'sesion',        true],   // nunca dejarla fuera (estado anómalo)
  [1, false, true,  'pedir_passkey', true],
  [2, false, true,  'pedir_passkey', true],
  [1, true,  false, 'pedir_passkey', false],
  [3, true,  false, 'pedir_passkey', false],
];
for (const [cantidad, obligatoria, basta, paso, omitir] of TABLA) {
  test(`política: ${cantidad} passkeys, obligatoria=${obligatoria}`, () => {
    const e = { cantidad, obligatoria };
    assert.equal(sesionSuficiente('contrasena', e), basta);
    assert.equal(sesionSuficiente('passkey', e), true);
    assert.equal(pasoDespuesDeContrasena(e), paso);
    assert.equal(puedeOmitirPasskey(e), omitir);
  });
}

test('gestionar: con passkeys solo con sesión confirmada', () => {
  assert.equal(puedeGestionar('contrasena', { cantidad: 0 }), true);
  assert.equal(puedeGestionar('contrasena', { cantidad: 1 }), false);
  assert.equal(puedeGestionar('passkey', { cantidad: 1 }), true);
});

test('no se elimina la última passkey si es obligatoria', () => {
  assert.equal(puedeEliminar({ cantidad: 1, obligatoria: true }), false);
  assert.equal(puedeEliminar({ cantidad: 2, obligatoria: true }), true);
  assert.equal(puedeEliminar({ cantidad: 1, obligatoria: false }), true);
});

test('RP ID: producción con y sin www, localhost solo en desarrollo, otros dominios no', () => {
  const prod = configRp(new URL('https://www.valentinaorellana.cl/admin/login'), false);
  assert.deepEqual(prod, { rpID: 'valentinaorellana.cl', origenes: ['https://valentinaorellana.cl', 'https://www.valentinaorellana.cl'] });
  assert.equal(configRp(new URL('https://valentinaorellana.cl/'), false)?.rpID, 'valentinaorellana.cl');
  assert.equal(configRp(new URL('http://localhost:4321/'), false), null);
  assert.deepEqual(configRp(new URL('http://localhost:4321/'), true), { rpID: 'localhost', origenes: ['http://localhost:4321'] });
  assert.equal(configRp(new URL('https://valentina-orellana-git-x.vercel.app/'), true), null);
  assert.equal(configRp(new URL('https://valentinaorellana.cl.evil.com/'), true), null);
  assert.equal(configRp(new URL('http://127.0.0.1:4321/'), true), null);
});

test('códigos de respaldo: 10 distintos, formato XXXXX-XXXXX sin 0/O/1/I', () => {
  const c = generarCodigosRespaldo();
  assert.equal(c.length, 10);
  assert.equal(new Set(c).size, 10);
  for (const x of c) assert.match(x, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
});

test('normalizar código', () => {
  assert.equal(normalizarCodigo(' abcde-fghjk '), 'ABCDEFGHJK');
  assert.equal(normalizarCodigo('ABCDE FGHJK'), 'ABCDEFGHJK');
  assert.equal(normalizarCodigo('corto'), '');
  assert.equal(normalizarCodigo("ABCDE'FGHJK"), '');
});

test('hash de código: coincide solo el mismo, sal distinta cada vez, no guarda el código', async () => {
  const [a, b] = generarCodigosRespaldo(2);
  const h1 = await hashCodigo(a);
  const h2 = await hashCodigo(a);
  assert.notEqual(h1, h2);
  assert.ok(!h1.includes(a.replace('-', '')));
  assert.match(h1, /^scrypt\$[\w-]+\$[\w-]+$/);
  assert.equal(await codigoCoincide(a, h1), true);
  assert.equal(await codigoCoincide(a.toLowerCase().replace('-', ' '), h2), true);
  assert.equal(await codigoCoincide(b, h1), false);
  assert.equal(await codigoCoincide(a, 'otro$formato'), false);
});

test('token de paso: firma, vencimiento y manipulación', () => {
  const t = crearTokenPaso('secreto-1', 1_000);
  assert.ok(leerTokenPaso('secreto-1', t, 1_000));
  assert.equal(leerTokenPaso('secreto-1', t, 1_000 + DURACION_PASO_MS + 1), null);
  assert.equal(leerTokenPaso('secreto-2', t, 1_000), null);
  const [p, v, n, f] = t.split('.');
  assert.equal(leerTokenPaso('secreto-1', `${p}.${Number(v) + 60_000}.${n}.${f}`, 1_000), null);
  assert.equal(leerTokenPaso('secreto-1', `v1.${v}.${f}`, 1_000), null);
  assert.equal(leerTokenPaso('', t, 1_000), null);
  assert.notEqual(leerTokenPaso('secreto-1', crearTokenPaso('secreto-1', 1_000), 1_000), leerTokenPaso('secreto-1', t, 1_000));
});

test('nombre de passkey', () => {
  assert.equal(nombrePasskey('  iPhone de Vale '), 'iPhone de Vale');
  assert.equal(nombrePasskey(''), 'Passkey');
  assert.equal(nombrePasskey('<b>Mac</b>'), 'bMac/b');
  assert.equal(nombrePasskey('x'.repeat(100)).length, 60);
});
