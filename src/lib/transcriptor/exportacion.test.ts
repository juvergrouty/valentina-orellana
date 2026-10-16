// Pruebas de la exportación legal (PDF + JSON + ZIP) — sin red: Supabase en memoria, KEK de prueba y
// almacén falso. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';
import { crearCifrado, type ContextoCifrado } from './cifrado';
import { columnasContenidoCifrado } from './resumenCifrado';
import { archivarResumen, type AlmArchivo } from './archivo';
import { anchoTexto, cortarLineas, generarPdf, normalizarTexto } from './pdf';
import { crc32, crearZip } from './zip';
import { armarArchivo, documentoPdf, recopilarFicha, slug, textoDeHtml, TOPE_RESPUESTA_BYTES } from './exportacion';
import type { TranscripcionClara } from './tipos';

const KEK = new Uint8Array(randomBytes(32));
const cif = crearCifrado({ activa: 1, obtener: (v) => (v === 1 ? KEK : undefined) });

/** Texto visible de un PDF generado por pdf.ts (descomprime los flujos y junta las cadenas). */
function textoPdf(bytes: Uint8Array): string {
  const s = Buffer.from(bytes).toString('latin1');
  let out = '';
  const re = /stream\n([\s\S]*?)\nendstream/g;
  for (const m of s.matchAll(re)) {
    const claro = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    for (const t of claro.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)) {
      const cp1252: Record<number, string> = { 0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—' };
      out += `${t[1].replace(/\\([0-7]{3})/g, (_, o) => { const n = parseInt(o, 8); return cp1252[n] ?? String.fromCharCode(n); }).replace(/\\(.)/g, '$1')}\n`;
    }
  }
  return out;
}

/** Lee un ZIP de zip.ts: nombre → contenido (verifica CRC). */
function leerZip(bytes: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(bytes);
  const out = new Map<string, Buffer>();
  let o = 0;
  while (b.readUInt32LE(o) === 0x04034b50) {
    const crc = b.readUInt32LE(o + 14), tam = b.readUInt32LE(o + 18), largo = b.readUInt32LE(o + 22), n = b.readUInt16LE(o + 26);
    const nombre = b.subarray(o + 30, o + 30 + n).toString('utf8');
    const datos = inflateRawSync(b.subarray(o + 30 + n, o + 30 + n + tam));
    assert.equal(datos.length, largo);
    assert.equal(crc32(datos), crc, `CRC de ${nombre}`);
    out.set(nombre, datos);
    o += 30 + n + tam;
  }
  assert.equal(b.readUInt32LE(b.length - 22), 0x06054b50, 'fin de directorio central');
  return out;
}

test('pdf: estructura válida (xref con offsets exactos), texto en español y varias páginas', () => {
  const bloques = [{ tipo: 'titulo' as const, texto: 'Ficha clínica — Camila «Cami» Ñuñoa ¿sí? ✦' }];
  for (let i = 0; i < 120; i++) bloques.push({ tipo: 'parrafo' as const, texto: `Línea ${i}: la paciente cuenta que durmió mejor (más de seis horas) y que \\ sigue igual.` } as never);
  const pdf = generarPdf(bloques, { titulo: 'Prueba', pie: 'confidencial' });
  const s = Buffer.from(pdf).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
  assert.ok(s.slice(xref).startsWith('xref'));
  const filas = s.slice(xref).split('\n').slice(3).filter((l) => / 00000 n $/.test(l));
  filas.forEach((l, i) => assert.ok(s.slice(Number(l.slice(0, 10))).startsWith(`${i + 1} 0 obj`), `offset del objeto ${i + 1}`));
  const paginas = Number(/\/Count (\d+)/.exec(s)![1]);
  assert.ok(paginas >= 3);
  const txt = textoPdf(pdf);
  assert.match(txt, /Ficha clínica — Camila «Cami» Ñuñoa ¿sí\? \*/);
  assert.match(txt, /Línea 119: la paciente cuenta que durmió mejor \(más de seis horas\)/);
  assert.match(txt, new RegExp(`Página ${paginas} de ${paginas}`));
});

test('pdf: corte de líneas por ancho real y palabras largas partidas', () => {
  const lineas = cortarLineas('a '.repeat(400), 200, 10);
  assert.ok(lineas.length > 3 && lineas.every((l) => anchoTexto(l, 10) <= 200));
  const hash = 'f'.repeat(200);
  assert.ok(cortarLineas(hash, 100, 9).every((l) => anchoTexto(l, 9) <= 100));
  assert.equal(normalizarTexto('ok ✓ → 中'), 'ok v -> ?');
});

test('zip: deflate + CRC32 legibles', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926); // valor de referencia de CRC-32
  const z = crearZip([{ nombre: 'ficha.pdf', datos: new Uint8Array([1, 2, 3]) }, { nombre: 'datos ñ.json', datos: new TextEncoder().encode('{"a":1}') }]);
  const m = leerZip(z);
  assert.deepEqual([...m.keys()], ['ficha.pdf', 'datos ñ.json']);
  assert.equal(m.get('datos ñ.json')!.toString(), '{"a":1}');
});

function almFalso() {
  const r2 = new Map<string, Uint8Array>();
  return {
    async guardarCifrado(claro: Uint8Array, ctx: ContextoCifrado) {
      const c = await cif.cifrar(claro, ctx); r2.set(ctx.claveObjeto, c.datos);
      return { r2Key: ctx.claveObjeto, b2Key: ctx.claveObjeto, b2Error: null, sha256: 'x', bytes: 1, kekV: 1, dekEnvuelta: c.dekEnvuelta, formatoV: 1 };
    },
    async leerCifrado(ctx: ContextoCifrado) { return cif.descifrar(r2.get(ctx.claveObjeto)!, ctx); },
    async copiarAB2(key: string) { return { b2Key: key, sha256: 'x' }; },
    async borrar() {},
  } as unknown as AlmArchivo;
}

async function fichaDePrueba() {
  const db = new SupabaseMemoria();
  const p = randomUUID(), g1 = randomUUID(), g2 = randomUUID(), c1 = randomUUID();
  const textoConsent = 'Autorizo el tratamiento de mis datos de salud y la grabación de las sesiones.';
  db.tabla('patients').push({ id: p, name: 'Camila Rojas', rut: '12.345.678-5', email: 'camila@ejemplo.cl', created_at: '2026-09-01T12:00:00Z' });
  db.tabla('consents').push({ id: c1, patient_id: p, token: 'secreto-del-link', version: '2026-10-v3', created_at: '2026-09-01T12:00:00Z', signed_at: '2026-09-01T12:05:00Z', signer_name: 'Camila Rojas', signer_rut: '12.345.678-5', text_snapshot: textoConsent, text_sha256: createHash('sha256').update(textoConsent).digest('hex'), accept_treatment: true, accept_recording: true, accept_case_review: false });
  db.tabla('consent_avisos').push({ id: randomUUID(), consent_id: c1, canal: 'correo', texto_version: 'aviso-v2-1', mostrado_at: '2026-10-02T10:00:00Z' });
  const html = '<p>Hola Camila,</p><p>Cambié de herramienta &amp; te aviso.</p>';
  db.tabla('consent_anexos').push({ id: randomUUID(), consent_id: c1, tipo: 'aviso_v2', asunto: 'Confirmación de tu hora', destinatario: 'camila@ejemplo.cl', enviado_at: '2026-10-02T10:00:00Z', html, html_sha256: createHash('sha256').update(html).digest('hex') });
  db.tabla('session_notes').push(
    { id: 'n2', patient_id: p, session_date: '2026-10-08', session_type: 'presencial', content: 'Nota de Vale del 8 de octubre.', deleted_at: null },
    { id: 'n1', patient_id: p, session_date: '2026-10-01', session_type: 'presencial', content: 'Nota archivada del 1 de octubre.', deleted_at: '2026-10-05T00:00:00Z' },
  );
  db.tabla('bookings').push({ id: 'b1', patient_email: 'camila@ejemplo.cl', session_date: '2026-10-08', session_time: '16:00:00', session_type: 'presencial', status: 'confirmed' });
  db.tabla('grabaciones').push(
    { id: g1, patient_id: p, origen: 'presencial', tipo: 'individual', estado: 'lista', session_date: '2026-10-01', inicio_at: '2026-10-01T19:00:00Z', duracion_seg: 3000, pausas: [{ desde_ms: 60_000, hasta_ms: 120_000 }], mapa_hablantes: { A: 'Ps. Valentina' }, consent_ids: [c1] },
    { id: g2, patient_id: p, origen: 'presencial', tipo: 'individual', estado: 'lista', session_date: '2026-10-08', inicio_at: '2026-10-08T19:00:00Z', duracion_seg: 3000, pausas: [], mapa_hablantes: null, consent_ids: [c1] },
  );
  db.tabla('transcripciones').push({ id: 't1', grabacion_id: g1, r2_key: 't/uno.bin', b2_key: 't/uno.bin', modelo: 'universal-2', deleted_at: null });
  const r1 = randomUUID(), r2 = randomUUID();
  db.tabla('resumenes_ia').push(
    { id: r1, grabacion_id: g1, patient_id: p, version: 1, autor: 'ia', estado: 'listo', modelo: 'claude-sonnet-5-5', listo_at: '2026-10-01T20:00:00Z', ...(await columnasContenidoCifrado(r1, '### Tareas\n- Registro de pensamientos.', cif)) },
    { id: r2, grabacion_id: g2, patient_id: p, version: 1, autor: 'ia', estado: 'listo', modelo: 'claude-sonnet-5-5', listo_at: '2026-10-08T20:00:00Z', ...(await columnasContenidoCifrado(r2, '### Puntos más importantes\n- Habló de su jefa [05:00].', cif)) },
  );
  const alm = almFalso();
  // El resumen del 1 oct queda archivado en R2 (como si estuviera fuera de las 4 últimas sesiones).
  const fila = db.tabla('resumenes_ia').find((r) => r.id === r1)!;
  assert.equal(await archivarResumen({ ...fila } as never, { db: db.cliente, almacenamiento: alm, cifrado: cif }), 'archivado');
  db.tabla('transcriptor_auditoria').push(
    { id: 1, at: '2026-10-08T21:00:00Z', actor: 'vale', accion: 'ver_transcripcion', resultado: 'ok', grabacion_id: g1, patient_id: p, ip: '1.2.3.4', detalle: { transcripcion_id: 't1' } },
    { id: 2, at: '2026-10-09T09:00:00Z', actor: 'vale', accion: 'ver_resumen', resultado: 'ok', grabacion_id: null, patient_id: p, detalle: { vista: 'ficha' } },
  );
  const transcripcion: TranscripcionClara = {
    v: 1, idioma: 'es', modelo: 'universal-2', duracion_s: 3000, hablantes: ['Hablante A', 'Hablante B'],
    segmentos: [
      { inicio_ms: 4_000, fin_ms: 9_000, hablante: 'Hablante A', texto: 'Hola, ¿cómo estuvo la semana?' },
      { inicio_ms: 130_000, fin_ms: 140_000, hablante: 'Hablante B', texto: 'Mejor, durmiendo más.' },
    ],
  };
  const leidas: string[] = [];
  const deps = { db: db.cliente, alm, cif, leerTranscripcion: async (k: string) => { leidas.push(k); return transcripcion; }, ahora: () => new Date('2026-10-16T15:00:00Z') };
  return { db, p, g1, g2, deps, leidas };
}

test('exportación: junta TODO ordenado por fecha (consentimiento exacto, anexos, notas, resúmenes archivados, transcripción con hablantes y minutos, bitácora)', async () => {
  const e = await fichaDePrueba();
  const f = await recopilarFicha(e.p, e.deps);
  assert.equal(f.consentimientos.length, 1);
  assert.equal(f.consentimientos[0].verificacion_texto, 'integro');
  assert.match(String(f.consentimientos[0].texto_firmado), /Autorizo el tratamiento/);
  assert.equal('token' in f.consentimientos[0], false, 'sin el token del link');
  assert.deepEqual(f.anexos_consentimiento.map((a) => a.tipo), ['aviso_cambio_consentimiento', 'copia_correo_aviso']);
  assert.equal(f.anexos_consentimiento[1].verificacion_html, 'integro');
  assert.deepEqual(f.notas.map((n) => n.fecha), ['2026-10-01', '2026-10-08']);
  assert.ok(f.notas[0].archivada_at, 'las notas archivadas también van');
  assert.deepEqual(f.sesiones_grabadas.map((s) => s.fecha), ['2026-10-01', '2026-10-08']);
  const s1 = f.sesiones_grabadas[0];
  assert.equal(s1.resumenes[0].contenido, '### Tareas\n- Registro de pensamientos.', 'el archivado se trae desde R2');
  assert.ok(s1.resumenes[0].archivado_at);
  assert.deepEqual(s1.transcripcion!.lineas.map((l) => [l.inicio, l.tipo, l.hablante]), [['00:04', 'tramo', 'Ps. Valentina'], ['01:00', 'pausa', null], ['02:10', 'tramo', 'Hablante B']]);
  assert.deepEqual(e.leidas, ['t/uno.bin']);
  assert.deepEqual(f.bitacora.map((a) => a.accion).filter((a) => a !== 'archivar_resumen'), ['ver_transcripcion', 'ver_resumen']);
  assert.ok(f.bitacora.some((a) => a.accion === 'archivar_resumen'), 'también el archivado (sistema)');
  assert.deepEqual(f.avisos, []);

  const pdf = textoPdf(armarArchivo(f, 'pdf').bytes);
  for (const esperado of ['Ficha clínica completa', 'Autorizo el tratamiento de mis datos', 'íntegro', 'Nota de Vale del 8 de octubre.', 'archivada el', 'TAREAS', 'Registro de pensamientos.', '[00:04] Ps. Valentina: Hola, ¿cómo estuvo la semana?', '[02:10] Hablante B: Mejor, durmiendo más.', 'ver_transcripcion', 'Cambié de herramienta & te aviso.', 'Resumen automático (IA) — no revisado por la psicóloga']) {
    assert.ok(pdf.includes(esperado), `el PDF incluye: ${esperado}`);
  }
  // Orden por fecha en el historial: 01-10 antes que 08-10.
  assert.ok(pdf.indexOf('01-10-2026') < pdf.indexOf('08-10-2026'));

  const zip = leerZip(armarArchivo(f, 'zip').bytes);
  assert.deepEqual([...zip.keys()], ['ficha.pdf', 'datos.json', 'LEEME.txt']);
  const datos = JSON.parse(zip.get('datos.json')!.toString('utf8'));
  assert.equal(datos.sesiones_grabadas[0].transcripcion.lineas[0].texto, 'Hola, ¿cómo estuvo la semana?');
  assert.ok(zip.get('ficha.pdf')!.toString('latin1').startsWith('%PDF-1.4'));
  assert.equal(armarArchivo(f, 'json').contentType, 'application/json; charset=utf-8');
  assert.match(armarArchivo(f, 'zip').nombre, /^ficha-completa-camila-rojas-todo-2026-10-16\.zip$/);
});

test('exportación por año y lectura fallida queda avisada (sin cortar la exportación)', async () => {
  const e = await fichaDePrueba();
  e.deps.leerTranscripcion = async () => { throw new Error('R2 caído'); };
  const f = await recopilarFicha(e.p, e.deps, { anio: 2025 });
  assert.equal(f.sesiones_grabadas.length, 0);
  assert.equal(f.notas.length, 0);
  assert.equal(f.consentimientos.length, 1, 'los consentimientos van siempre completos');
  const todo = await recopilarFicha(e.p, e.deps);
  assert.equal(todo.sesiones_grabadas[0].transcripcion, null);
  assert.equal(todo.avisos.length, 1);
  assert.ok(documentoPdf(todo).some((b) => /No se pudo abrir la transcripción/.test(b.texto ?? '')));
});

test('exportación: utilidades y endpoint (passkey, bitácora antes de leer, sin caché, sin escribir a disco)', () => {
  assert.equal(slug('María José Ñúñez'), 'maria-jose-nunez');
  assert.equal(textoDeHtml('<p>Hola&nbsp;<b>Ana</b></p><script>x</script>'), 'Hola Ana');
  assert.ok(TOPE_RESPUESTA_BYTES < 4.5 * 1024 * 1024);
  const ep = readFileSync(new URL('../../pages/api/admin/transcriptor/exportar-ficha.ts', import.meta.url), 'utf8');
  assert.match(ep, /guardiaPanel\(ctx, 'exportar'\)\) \?\? \(await exigirAccesoClinico\(ctx, 'exportar'\)\)/);
  assert.ok(ep.indexOf("auditarObligatorio('vale', 'exportar'") < ep.indexOf('recopilarFicha('), 'bitácora antes de leer');
  assert.match(ep, /no-store/);
  for (const f of ['exportar-ficha.ts']) {
    const src = readFileSync(new URL(`../../pages/api/admin/transcriptor/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /writeFile|createWriteStream|\/tmp/);
  }
  for (const f of ['exportacion.ts', 'pdf.ts', 'zip.ts']) {
    assert.doesNotMatch(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'), /writeFile|createWriteStream|\.insert\(|\.upsert\(|\.put\(/);
  }
});
