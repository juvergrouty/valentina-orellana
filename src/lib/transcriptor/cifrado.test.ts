// Pruebas del cifrado VOT1 (sin red). Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  crearCifrado, decodificarKEK, parsearVersionKEK, leerCabecera, llavesDesdeEntorno, ErrorCifrado,
  LARGO_CABECERA, type LlavesKEK,
} from './cifrado';
import type { ContextoCifrado } from './tipos';

const K1 = new Uint8Array(randomBytes(32));
const K2 = new Uint8Array(randomBytes(32));
const llaves = (activa: number, mapa: Record<number, Uint8Array>): LlavesKEK => ({ activa, obtener: (v) => mapa[v] });
const CTX: ContextoCifrado = { claveObjeto: 't/3f2c0b7e-1111-4222-8333-944445555666.bin', tipo: 'transcripcion' };
const CLARO = new TextEncoder().encode('{"v":1,"texto":"sesión ficticia de prueba — ñandú"}');

const fallaCon = (codigo: string) => (err: unknown) => err instanceof ErrorCifrado && err.codigo === codigo;

test('ida y vuelta devuelve exactamente el contenido', async () => {
  const c = crearCifrado(llaves(1, { 1: K1 }));
  const r = await c.cifrar(CLARO, CTX);
  assert.equal(r.kekV, 1);
  assert.equal(r.dekEnvuelta.length, 60);
  assert.equal(r.datos.length, LARGO_CABECERA + CLARO.length + 16);
  assert.deepEqual(await c.descifrar(r.datos, CTX), CLARO);
});

test('formato: magia VOT1, versión de formato 1 y versión de KEK en la cabecera', async () => {
  const r = await crearCifrado(llaves(2, { 2: K2 })).cifrar(CLARO, CTX);
  assert.equal(new TextDecoder().decode(r.datos.subarray(0, 4)), 'VOT1');
  assert.equal(r.datos[4], 1);
  assert.equal(r.datos[5], 2);
  const cab = leerCabecera(r.datos);
  assert.equal(cab.formatoV, 1);
  assert.equal(cab.kekV, 2);
  assert.deepEqual(r.dekEnvuelta, new Uint8Array([...cab.ivEnvoltura, ...cab.dekEnvuelta]));
});

test('cifrar dos veces lo mismo da IV y salida distintos (DEK nueva por objeto)', async () => {
  const c = crearCifrado(llaves(1, { 1: K1 }));
  const a = await c.cifrar(CLARO, CTX);
  const b = await c.cifrar(CLARO, CTX);
  assert.notDeepEqual(a.datos.subarray(6, 18), b.datos.subarray(6, 18));
  assert.notDeepEqual(a.datos.subarray(66, 78), b.datos.subarray(66, 78));
  assert.notDeepEqual(a.dekEnvuelta, b.dekEnvuelta);
  assert.notDeepEqual(a.datos, b.datos);
});

test('AAD distinto falla: otra llave de objeto', async () => {
  const c = crearCifrado(llaves(1, { 1: K1 }));
  const r = await c.cifrar(CLARO, CTX);
  await assert.rejects(c.descifrar(r.datos, { ...CTX, claveObjeto: 't/otro-objeto.bin' }), fallaCon('autenticacion'));
});

test('AAD distinto falla: otro tipo de objeto', async () => {
  const c = crearCifrado(llaves(1, { 1: K1 }));
  const r = await c.cifrar(CLARO, CTX);
  await assert.rejects(c.descifrar(r.datos, { ...CTX, tipo: 'respuesta' }), fallaCon('autenticacion'));
});

test('KEK errónea falla', async () => {
  const r = await crearCifrado(llaves(1, { 1: K1 })).cifrar(CLARO, CTX);
  await assert.rejects(crearCifrado(llaves(1, { 1: K2 })).descifrar(r.datos, CTX), fallaCon('autenticacion'));
});

test('KEK de la versión de la cabecera ausente falla con kek_ausente', async () => {
  const r = await crearCifrado(llaves(1, { 1: K1 })).cifrar(CLARO, CTX);
  await assert.rejects(crearCifrado(llaves(2, { 2: K2 })).descifrar(r.datos, CTX), fallaCon('kek_ausente'));
});

test('alterar cualquier byte (cabecera, iv, contenido o tag) hace fallar el descifrado', async () => {
  const c = crearCifrado(llaves(1, { 1: K1 }));
  const r = await c.cifrar(CLARO, CTX);
  for (const pos of [6, 20, 70, LARGO_CABECERA + 3, r.datos.length - 1]) {
    const mal = new Uint8Array(r.datos);
    mal[pos] ^= 0x01;
    await assert.rejects(c.descifrar(mal, CTX), fallaCon('autenticacion'), `byte ${pos}`);
  }
});

test('cambiar la versión de KEK escrita en la cabecera no permite descifrar', async () => {
  const c = crearCifrado(llaves(1, { 1: K1, 2: K1 }));
  const r = await c.cifrar(CLARO, CTX);
  const mal = new Uint8Array(r.datos);
  mal[5] = 2; // misma llave bajo otra versión: el AAD de la envoltura lo detecta
  await assert.rejects(c.descifrar(mal, CTX), fallaCon('autenticacion'));
});

test('formato: magia distinta, versión de formato desconocida u objeto corto se rechazan', async () => {
  const c = crearCifrado(llaves(1, { 1: K1 }));
  const r = await c.cifrar(CLARO, CTX);
  const sinMagia = new Uint8Array(r.datos); sinMagia[0] = 0x58;
  await assert.rejects(c.descifrar(sinMagia, CTX), fallaCon('formato'));
  const v2 = new Uint8Array(r.datos); v2[4] = 2;
  await assert.rejects(c.descifrar(v2, CTX), fallaCon('version'));
  await assert.rejects(c.descifrar(r.datos.subarray(0, 50), CTX), fallaCon('formato'));
});

test('rotación v1 → v2: lo antiguo sigue descifrando y reenvolver pasa a v2', async () => {
  const viejo = await crearCifrado(llaves(1, { 1: K1 })).cifrar(CLARO, CTX);
  const rotando = crearCifrado(llaves(2, { 1: K1, 2: K2 }));
  assert.deepEqual(await rotando.descifrar(viejo.datos, CTX), CLARO); // lee la versión de la cabecera
  const nuevo = await rotando.reenvolver(viejo.datos, CTX);
  assert.equal(nuevo.cambio, true);
  assert.equal(nuevo.kekV, 2);
  assert.equal(leerCabecera(nuevo.datos).kekV, 2);
  // Sin V1 (ya retirada) el objeto reenvuelto sigue legible.
  assert.deepEqual(await crearCifrado(llaves(2, { 2: K2 })).descifrar(nuevo.datos, CTX), CLARO);
  // Ya en la versión activa: no cambia nada.
  const otra = await rotando.reenvolver(nuevo.datos, CTX);
  assert.equal(otra.cambio, false);
  assert.deepEqual(otra.datos, nuevo.datos);
});

test('cifrarTexto / descifrarTexto (Q&A) en base64', async () => {
  const c = crearCifrado(llaves(1, { 1: K1 }));
  const ctx: ContextoCifrado = { claveObjeto: 'pregunta:7b1d', tipo: 'pregunta' };
  const { base64, kekV } = await c.cifrarTexto('¿Qué temas aparecieron? — prueba', ctx);
  assert.equal(kekV, 1);
  assert.equal(await c.descifrarTexto(base64, ctx), '¿Qué temas aparecieron? — prueba');
  await assert.rejects(c.descifrarTexto(base64, { ...ctx, tipo: 'respuesta' }), fallaCon('autenticacion'));
});

test('KEK: base64 de 32 bytes obligatorio; versión activa v1/v2', () => {
  assert.equal(decodificarKEK(Buffer.from(K1).toString('base64')).length, 32);
  assert.throws(() => decodificarKEK(Buffer.from(randomBytes(16)).toString('base64')), fallaCon('kek_invalida'));
  assert.throws(() => decodificarKEK('esto no es base64!'), fallaCon('kek_invalida'));
  assert.equal(parsearVersionKEK('v1'), 1);
  assert.equal(parsearVersionKEK('V2'), 2);
  assert.equal(parsearVersionKEK('3'), 3);
  assert.throws(() => parsearVersionKEK('v0'), fallaCon('kek_ausente'));
  assert.throws(() => parsearVersionKEK('dos'), fallaCon('kek_ausente'));
});

test('llaves desde variables de entorno TRANSCRIPTOR_KEK_V1 / TRANSCRIPTOR_KEK_ACTIVA', async () => {
  const antes = { v1: process.env.TRANSCRIPTOR_KEK_V1, act: process.env.TRANSCRIPTOR_KEK_ACTIVA };
  try {
    process.env.TRANSCRIPTOR_KEK_V1 = Buffer.from(K1).toString('base64');
    process.env.TRANSCRIPTOR_KEK_ACTIVA = 'v1';
    const c = crearCifrado(llavesDesdeEntorno());
    const r = await c.cifrar(CLARO, CTX);
    assert.deepEqual(await crearCifrado(llaves(1, { 1: K1 })).descifrar(r.datos, CTX), CLARO);
    delete process.env.TRANSCRIPTOR_KEK_V1;
    await assert.rejects(c.descifrar(r.datos, CTX), fallaCon('kek_ausente'));
  } finally {
    if (antes.v1 === undefined) delete process.env.TRANSCRIPTOR_KEK_V1; else process.env.TRANSCRIPTOR_KEK_V1 = antes.v1;
    if (antes.act === undefined) delete process.env.TRANSCRIPTOR_KEK_ACTIVA; else process.env.TRANSCRIPTOR_KEK_ACTIVA = antes.act;
  }
});

test('contexto inválido se rechaza antes de cifrar', async () => {
  const c = crearCifrado(llaves(1, { 1: K1 }));
  await assert.rejects(c.cifrar(CLARO, { claveObjeto: '', tipo: 'transcripcion' }), fallaCon('contexto'));
  await assert.rejects(c.cifrar(CLARO, { claveObjeto: 'x', tipo: 'otro' as never }), fallaCon('contexto'));
});
