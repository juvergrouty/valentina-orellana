// Pruebas del archivo externo de resúmenes (02-decisiones-16oct-noche, B). Sin red: Supabase en
// memoria y un almacén R2/B2 falso que cifra con una KEK de prueba. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';
import { crearCifrado, type ContextoCifrado } from './cifrado';
import { columnasContenidoCifrado } from './resumenCifrado';
import {
  SESIONES_EN_SITIO, abrirSobre, archivarAntiguos, conTextoResumen, estaArchivado, grabacionesFueraDelSitio,
  textoResumen, tieneTexto, type AlmArchivo, type FilaArchivo,
} from './archivo';
import { pasoArchivo } from './pasoArchivo';
import { contextoSesionAnterior } from './resumen';

const KEK = new Uint8Array(randomBytes(32));
const cif = crearCifrado({ activa: 1, obtener: (v) => (v === 1 ? KEK : undefined) });

function almFalso(op: { fallarB2?: boolean } = {}) {
  const r2 = new Map<string, Uint8Array>();
  const b2 = new Map<string, Uint8Array>();
  const noExiste = () => Object.assign(new Error('no existe'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
  const alm = {
    r2, b2, op,
    async guardarCifrado(claro: Uint8Array, ctx: ContextoCifrado) {
      const c = await cif.cifrar(claro, ctx);
      r2.set(ctx.claveObjeto, c.datos);
      let b2Key: string | null = null;
      if (!op.fallarB2) { b2.set(ctx.claveObjeto, c.datos); b2Key = ctx.claveObjeto; }
      return { r2Key: ctx.claveObjeto, b2Key, b2Error: b2Key ? null : 'B2 caído', sha256: 'sha-prueba', bytes: c.datos.length, kekV: c.kekV, dekEnvuelta: c.dekEnvuelta, formatoV: 1 };
    },
    async leerCifrado(ctx: ContextoCifrado, origen: 'r2' | 'b2' = 'r2') {
      const d = origen === 'b2' ? b2.get(ctx.claveObjeto) : (r2.get(ctx.claveObjeto) ?? b2.get(ctx.claveObjeto));
      if (!d) throw noExiste();
      return cif.descifrar(d, ctx);
    },
    async copiarAB2(key: string) {
      if (op.fallarB2) throw new Error('B2 caído');
      const d = r2.get(key); if (!d) throw noExiste();
      b2.set(key, d);
      return { b2Key: key, sha256: 'sha-prueba' };
    },
    async borrar(bucket: string, key: string) { (bucket === 'b2' ? b2 : r2).delete(key); },
  };
  return alm as typeof alm & AlmArchivo;
}

/** Paciente con `n` sesiones (una por semana), cada una con su resumen listo y cifrado. */
async function escenario(n: number, op: { claro?: boolean } = {}) {
  const db = new SupabaseMemoria();
  const p = randomUUID();
  const grabs: string[] = [];
  for (let i = 0; i < n; i++) {
    const g = randomUUID();
    grabs.push(g);
    const fecha = `2026-${String(1 + Math.floor(i / 4)).padStart(2, '0')}-${String(1 + (i % 4) * 7).padStart(2, '0')}`;
    db.tabla('grabaciones').push({ id: g, patient_id: p, session_date: fecha, created_at: `${fecha}T12:00:00Z`, estado: 'lista' });
    const id = randomUUID();
    const texto = `### Tareas\n- Tarea de la sesión ${i}.`;
    const col = op.claro && i === 0 ? { contenido: texto, contenido_cifrado: null } : await columnasContenidoCifrado(id, texto, cif);
    db.tabla('resumenes_ia').push({ id, grabacion_id: g, patient_id: p, version: 1, autor: 'ia', estado: 'listo', oculto_at: null, ...col });
  }
  return { db, p, grabs };
}

const filaDe = (db: SupabaseMemoria, g: string) => db.tabla('resumenes_ia').filter((r) => r.grabacion_id === g);

test('grabacionesFueraDelSitio: por paciente, todo menos las 4 sesiones más recientes', () => {
  const s = (g: string, p: string, d: string, c = '') => ({ grabacion_id: g, patient_id: p, session_date: d, created_at: c });
  const fuera = grabacionesFueraDelSitio([
    s('a1', 'A', '2026-10-01'), s('a2', 'A', '2026-10-08'), s('a3', 'A', '2026-10-15'), s('a4', 'A', '2026-10-22'),
    s('a5', 'A', '2026-10-29'), s('a6', 'A', '2026-10-29', '2026-10-29T10:00:00Z'), s('a1', 'A', '2026-10-01'),
    s('b1', 'B', '2026-01-01'), s('b2', 'B', '2026-01-02'),
  ]);
  assert.equal(SESIONES_EN_SITIO, 4);
  assert.deepEqual([...fuera].sort(), ['a1', 'a2']);
});

test('archivar: lo anterior a las 4 últimas sesiones va cifrado a R2 + B2 y en la base queda solo la referencia', async () => {
  const { db, grabs } = await escenario(6);
  const alm = almFalso();
  const n = await archivarAntiguos({ db: db.cliente, almacenamiento: alm, cifrado: cif, ahora: () => new Date('2026-10-16T12:00:00Z') });
  assert.equal(n, 2);
  for (const g of grabs.slice(0, 2)) {
    const [r] = filaDe(db, g);
    assert.ok(estaArchivado(r));
    assert.equal(r.contenido, null);
    assert.equal(r.contenido_cifrado, null);
    assert.match(r.archivo_r2_key, /^t\/[0-9a-f-]{36}\.bin$/);
    assert.equal(r.archivo_b2_key, r.archivo_r2_key);
    assert.equal(r.archivado_at, '2026-10-16T12:00:00.000Z');
    // El objeto externo está cifrado (no hay texto en claro) y se abre solo para ESTA fila.
    assert.ok(!Buffer.from(alm.r2.get(r.archivo_r2_key)!).toString('latin1').includes('Tarea de la sesión'));
    assert.match(String(await textoResumen(r as FilaArchivo, { alm, cif })), /Tarea de la sesión [01]\./);
  }
  for (const g of grabs.slice(2)) assert.ok(!filaDe(db, g)[0].archivado_at && filaDe(db, g)[0].contenido_cifrado, 'las 4 últimas siguen en la base');
  assert.equal(alm.r2.size, 2);
  assert.equal(alm.b2.size, 2);
  // Idempotente: una segunda corrida no hace nada.
  assert.equal(await archivarAntiguos({ db: db.cliente, almacenamiento: alm, cifrado: cif }), 0);
  const bit = db.tabla('transcriptor_auditoria').filter((a) => a.accion === 'archivar_resumen');
  assert.equal(bit.length, 2);
  assert.ok(!JSON.stringify(bit).includes('Tarea de la sesión'), 'la bitácora no lleva contenido');
});

test('archivar: si B2 falla, el texto sigue en la base y se completa cuando B2 vuelve', async () => {
  const { db, grabs } = await escenario(5);
  const alm = almFalso({ fallarB2: true });
  assert.equal(await archivarAntiguos({ db: db.cliente, almacenamiento: alm, cifrado: cif }), 0);
  const [r] = filaDe(db, grabs[0]);
  assert.ok(r.archivo_r2_key && !r.archivado_at && r.contenido_cifrado, 'referencia de R2, pero sin vaciar la base');
  assert.equal(alm.b2.size, 0);
  alm.op.fallarB2 = false;
  assert.equal(await archivarAntiguos({ db: db.cliente, almacenamiento: alm, cifrado: cif }), 1);
  const [r2] = filaDe(db, grabs[0]);
  assert.ok(estaArchivado(r2) && r2.contenido_cifrado === null);
  assert.equal(alm.b2.size, 1);
  assert.equal(alm.r2.size, 1, 'reusa el mismo objeto de R2');
});

test('archivar: un resumen antiguo en claro (antes de 0019) también se archiva; si R2 no lo devuelve igual, no se toca la base', async () => {
  const { db, grabs } = await escenario(5, { claro: true });
  const alm = almFalso();
  const leerReal = alm.leerCifrado;
  alm.leerCifrado = async () => new TextEncoder().encode(JSON.stringify({ v: 1, resumen_id: 'otro', contenido: 'x' }));
  assert.equal(await archivarAntiguos({ db: db.cliente, almacenamiento: alm, cifrado: cif }), 0);
  assert.equal(filaDe(db, grabs[0])[0].contenido, '### Tareas\n- Tarea de la sesión 0.');
  assert.equal(alm.r2.size, 0, 'se limpia lo que se alcanzó a subir');
  alm.leerCifrado = leerReal;
  assert.equal(await archivarAntiguos({ db: db.cliente, almacenamiento: alm, cifrado: cif }), 1);
  const [r] = filaDe(db, grabs[0]);
  assert.equal(r.contenido, null);
  assert.equal(await textoResumen(r as FilaArchivo, { alm, cif }), '### Tareas\n- Tarea de la sesión 0.');
});

test('lectura: el archivo está ligado a su fila; conTextoResumen mezcla base y archivo y cuenta fallas', async () => {
  const { db, grabs } = await escenario(6);
  const alm = almFalso();
  await archivarAntiguos({ db: db.cliente, almacenamiento: alm, cifrado: cif });
  const [a] = filaDe(db, grabs[0]);
  const [b] = filaDe(db, grabs[1]);
  await assert.rejects(textoResumen({ ...b, archivo_r2_key: a.archivo_r2_key } as FilaArchivo, { alm, cif }), /no corresponde/);
  assert.throws(() => abrirSobre(new TextEncoder().encode('{"v":2}'), 'x'));
  const filas = db.tabla('resumenes_ia') as FilaArchivo[];
  assert.ok(filas.every(tieneTexto));
  const { filas: claras, fallidas } = await conTextoResumen([...filas, { ...b, id: randomUUID() }], { alm, cif });
  assert.equal(fallidas, 1);
  assert.equal(claras.filter((f) => f.contenido).length, 6);
  // R2 sin el objeto → se usa la copia de B2.
  alm.r2.delete(a.archivo_r2_key);
  assert.match(String(await textoResumen(a as FilaArchivo, { alm, cif })), /sesión 0/);
});

test('contextoSesionAnterior trae el resumen anterior aunque esté archivado', async () => {
  const { db, p, grabs } = await escenario(6);
  const alm = almFalso();
  await archivarAntiguos({ db: db.cliente, almacenamiento: alm, cifrado: cif });
  // Sesión de hoy entre la 1 (archivada) y la 2: el "anterior" es la 1.
  const g1 = db.tabla('grabaciones').find((g) => g.id === grabs[1])!;
  const ctx = await contextoSesionAnterior({ id: randomUUID(), patient_id: p, session_date: `${g1.session_date.slice(0, 8)}${String(Number(g1.session_date.slice(8)) + 1).padStart(2, '0')}` }, db.cliente, cif, alm);
  assert.match(String(ctx), /Tarea de la sesión 1\./);
});

test('pasoArchivo (pipeline): sin nada que archivar no carga el almacenamiento real', async () => {
  const { db } = await escenario(4);
  assert.equal(await pasoArchivo({ db: db.cliente, almacenamiento: {} as never, cifrado: cif }, new Date()), 0);
  const { db: db6 } = await escenario(6);
  const alm = almFalso();
  assert.equal(await pasoArchivo({ db: db6.cliente, almacenamiento: alm as never, cifrado: cif }, new Date()), 2);
});

test('0020: trigger y permisos del archivo', () => {
  const sql = readFileSync(new URL('../../../supabase/migrations/0020_transcriptor_archivo_resumenes.sql', import.meta.url), 'utf8');
  assert.match(sql, /add column if not exists archivado_at/);
  assert.match(sql, /archivando := old\.archivado_at is null and new\.archivado_at is not null/);
  assert.match(sql, /un resumen archivado no cambia su archivo/);
  assert.match(sql, /revoke all on public\.resumenes_ia from anon, authenticated;/);
  assert.match(sql, /grant select, insert, update, delete on public\.resumenes_ia to service_role;/);
  assert.match(sql, /comment on column public\.transcripciones\.borrado_canal/);
  assert.doesNotMatch(sql, /drop column/i);
});
