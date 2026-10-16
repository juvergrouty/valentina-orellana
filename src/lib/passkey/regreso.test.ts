// Pruebas del login con regreso (?volver=): solo rutas internas del panel, nada de redirecciones abiertas.
// Correr: pnpm test:passkey
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conVolver, destinoDePeticion, destinoSeguro } from './regreso';

test('regreso: acepta rutas del panel con query (incluido el enlace de acción de un aviso)', () => {
  assert.equal(destinoSeguro('/admin'), '/admin');
  assert.equal(destinoSeguro('/admin/transcriptor'), '/admin/transcriptor');
  const accion = '/admin/transcriptor/accion?id=0b6c2a9e-1f3d-4c1e-9a55-2f1f0d3c7b11&accion=revisar';
  assert.equal(destinoSeguro(accion), accion);
  assert.equal(destinoSeguro('/admin/pacientes/abc?tab=notas#ia-1'), '/admin/pacientes/abc?tab=notas#ia-1');
});

test('regreso: rechaza redirecciones abiertas y rutas fuera de /admin', () => {
  const malos = [
    'https://evil.example/admin', '//evil.example/admin', '/\\evil.example', '\\\\evil.example', 'javascript:alert(1)',
    '/admin/../api/admin/settings', '/admin/%2e%2e/api/x', '/admin%2f..%2fapi', '/admin/%2F%2Fevil', '/administracion',
    '/admin@evil.example', '/api/admin/login', '/', '', '   ', 'admin', '/admin/login', '/admin/login?volver=/admin',
    '/admin/\u0000x', '/admin/\nx', `/admin/${'a'.repeat(1200)}`, 42, null, undefined, ['/admin'],
  ];
  for (const m of malos) assert.equal(destinoSeguro(m), null, `debió rechazar ${JSON.stringify(m)}`);
});

test('regreso: el middleware solo guarda el destino de un GET a una página del panel', () => {
  const u = new URL('https://www.valentinaorellana.cl/admin/transcriptor/accion?id=1&accion=rescatar');
  assert.equal(destinoDePeticion(u, 'GET'), '/admin/transcriptor/accion?id=1&accion=rescatar');
  assert.equal(destinoDePeticion(u, 'POST'), null, 'un POST no se repite después del login');
  assert.equal(destinoDePeticion(new URL('https://www.valentinaorellana.cl/api/admin/x'), 'GET'), null);
});

test('regreso: conVolver agrega el destino codificado y no agrega nada si no es válido', () => {
  assert.equal(conVolver('/admin/login', '/admin/transcriptor/accion?id=1&accion=revisar'),
    '/admin/login?volver=%2Fadmin%2Ftranscriptor%2Faccion%3Fid%3D1%26accion%3Drevisar');
  assert.equal(conVolver('/admin/login?passkey=1', '/admin/agenda'), '/admin/login?passkey=1&volver=%2Fadmin%2Fagenda');
  assert.equal(conVolver('/admin/login', 'https://evil.example'), '/admin/login');
  assert.equal(conVolver('/admin/login', '/admin'), '/admin/login', '/admin es el destino por defecto: no hace falta');
  assert.equal(conVolver('/admin/login', null), '/admin/login');
  // Ida y vuelta: lo que lee login.astro de ?volver= vuelve a pasar la validación.
  const url = new URL(conVolver('/admin/login', '/admin/transcriptor/accion?id=1&accion=revisar'), 'https://x.cl');
  assert.equal(destinoSeguro(url.searchParams.get('volver')), '/admin/transcriptor/accion?id=1&accion=revisar');
});
