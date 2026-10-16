// Pruebas de las correcciones de consentimiento, ética y datos (81-revision-etica-clinica y
// 80-revision-seguridad M3/B4, 16 oct 2026). Sin red. Correr: pnpm test:transcriptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { SupabaseMemoria } from './pruebas/supabaseMemoria';
import {
  evaluarConsentimientos, evaluarEnBase, fichaEsPareja, motivoVisible, textoMotivo, type FilaConsentimiento,
} from './consentimiento';
import { avisoV2ParaCorreo, firmasParaAviso, htmlAvisoV2, registrarAvisoMostrado, TEXTO_AVISO_V2_VERSION } from './avisoV2';
import { excluirDeIA, validarPedido } from './excluirIA';
import { existsSync, readFileSync } from 'node:fs';
import {
  armarPromptResumen, avisoAnexoResumen, contextoSesionAnterior, formatearTranscripcion, lineaEncabezado, PARTE_FIJA_RESUMEN,
  PROMPT_VERSION_RESUMEN, INSTRUCCIONES_RESUMEN_POR_DEFECTO,
} from './resumen';
import { armarTranscripcionClara, esTramoHueco, huecosSinPausa, textoHueco } from './hablantes';
import { crearCifrado } from './cifrado';
import { bytesDeBytea, columnasContenidoCifrado, conContenidoClaro, leerContenidoResumen } from './resumenCifrado';
import { normalizarResultado } from './assemblyai';
import type { ResultadoTranscripcion } from './tipos';

const HOY = '2026-10-16';
let n = 0;
const fila = (p: Partial<FilaConsentimiento>): FilaConsentimiento => ({
  id: `c${++n}`, version: '2026-11-v3', signed_at: '2026-10-10T12:00:00Z', signer_name: 'Camila Rojas',
  signer_rut: '12.345.678-5', signer_email: null, accept_recording: true, revoked_at: null, ...p,
});
const KEK = new Uint8Array(randomBytes(32));
const cif = crearCifrado({ activa: 1, obtener: (v) => (v === 1 ? KEK : undefined) });

// ─── H1: retirar solo la grabación por persona ───────────────────────────────

test('H1: retiro SOLO de la grabación de una persona bloquea grabar (revocado) sin revocar su consentimiento', () => {
  const ana = fila({ signer_name: 'Ana Pérez', signer_rut: '11.111.111-1', recording_revoked_at: '2026-10-15T10:00:00Z' });
  const r = evaluarConsentimientos({ patientId: 'p1', tipo: 'individual', fechaNacimiento: null, filas: [ana], hoy: HOY });
  assert.deepEqual([r.puede, r.motivo], [false, 'revocado']);
  assert.equal(ana.revoked_at, null, 'el consentimiento de atención sigue vigente');
  // En pareja, el retiro de UNA persona bloquea la sesión de ambos.
  const luis = fila({ signer_name: 'Luis Soto', signer_rut: '9.876.543-2' });
  const rp = evaluarConsentimientos({ patientId: 'p1', tipo: 'pareja', fechaNacimiento: null, filas: [ana, luis], hoy: HOY });
  assert.deepEqual([rp.puede, rp.motivo], [false, 'revocado']);
});

// ─── H2: pareja deducida en el servidor ──────────────────────────────────────

test('H2: fichaEsPareja con cualquier señal del servidor', () => {
  const base = { sessionTypes: [], tiposGrabaciones: [], filas: [], nombre: 'Camila Rojas' };
  assert.equal(fichaEsPareja(base), false);
  assert.equal(fichaEsPareja({ ...base, sessionTypes: ['presencial', 'pareja-online'] }), true);
  assert.equal(fichaEsPareja({ ...base, tiposGrabaciones: ['pareja'] }), true);
  assert.equal(fichaEsPareja({ ...base, nombre: 'Ana y Luis' }), true);
  assert.equal(fichaEsPareja({ ...base, nombre: 'Ana & Luis' }), true);
  assert.equal(fichaEsPareja({ ...base, filas: [fila({ signer_rut: '11.111.111-1' }), fila({ signer_rut: '9.876.543-2' })] }), true);
  assert.equal(fichaEsPareja({ ...base, filas: [fila({}), fila({ signed_at: '2026-10-12T12:00:00Z' })] }), false, 'la misma persona que firmó dos veces no es pareja');
});

test('H2: "individual" en una ficha de pareja exige 2 firmas y el texto lo explica', () => {
  const r = evaluarConsentimientos({ patientId: 'p1', tipo: 'individual', fichaPareja: true, fechaNacimiento: null, filas: [fila({})], hoy: HOY });
  assert.deepEqual([r.puede, r.motivo, r.requeridas, r.tipoEfectivo, r.parejaDeducida], [false, 'falta_segunda_firma', 2, 'pareja', true]);
  assert.equal(textoMotivo(motivoVisible(r)), 'Esta ficha es de pareja. Para grabar se necesita el consentimiento de las dos personas.');
  const sinTipo = evaluarConsentimientos({ patientId: 'p1', tipo: 'sin_tipo', fichaPareja: true, fechaNacimiento: null, filas: [fila({})], hoy: HOY });
  assert.equal(sinTipo.puede, false, 'online sin tipo (bot) también');
});

test('H2 en la base: reserva pareja-* de la ficha → individual con 1 firma no puede', async () => {
  const db = new SupabaseMemoria();
  const p = randomUUID();
  db.tabla('patients').push({ id: p, name: 'Clara Ríos', email: 'clara@ejemplo.cl', birthdate: null });
  db.tabla('consents').push({ ...fila({ signer_name: 'Clara Ríos' }), patient_id: p });
  assert.equal((await evaluarEnBase(p, 'individual', db.cliente)).puede, true);
  db.tabla('bookings').push({ id: randomUUID(), patient_email: 'Clara@Ejemplo.cl', session_type: 'pareja-presencial' });
  const r = await evaluarEnBase(p, 'individual', db.cliente);
  assert.deepEqual([r.puede, r.tipoEfectivo, r.parejaDeducida], [false, 'pareja', true]);
});

// ─── H4: aviso único a pacientes con v2 ──────────────────────────────────────

test('H4: firmasParaAviso: solo la última firma v2 con grabación, vigente y no avisada', () => {
  const v2 = fila({ id: 'a', version: '2026-10-v2' });
  assert.deepEqual(firmasParaAviso([v2], new Set()).map((f) => f.id), ['a']);
  assert.deepEqual(firmasParaAviso([v2], new Set(['a'])), [], 'no se repite');
  assert.deepEqual(firmasParaAviso([fila({ version: '2026-10-v2', accept_recording: false })], new Set()), []);
  assert.deepEqual(firmasParaAviso([fila({ version: '2026-10-v2', recording_revoked_at: '2026-10-15T00:00:00Z' })], new Set()), []);
  assert.deepEqual(firmasParaAviso([v2, fila({ id: 'b', version: '2026-11-v3', signed_at: '2026-10-14T12:00:00Z' })], new Set()), [], 'si después firmó la v3, no hace falta');
});

test('H4: avisoV2ParaCorreo solo con el transcriptor activo; se registra una vez', async () => {
  const db = new SupabaseMemoria();
  const p = randomUUID();
  db.tabla('patients').push({ id: p, name: 'Diego Soto', email: 'diego@ejemplo.cl' });
  const c = { ...fila({ version: '2026-10-v2', signer_name: 'Diego Soto' }), patient_id: p };
  db.tabla('consents').push(c);
  db.tabla('settings').push({ key: 'transcriptor_activo', value: 'false' });
  assert.equal(await avisoV2ParaCorreo('diego@ejemplo.cl', db.cliente), null, 'apagado: sin aviso');
  db.tabla('settings')[0].value = 'true';
  const a = await avisoV2ParaCorreo('DIEGO@ejemplo.cl', db.cliente);
  assert.ok(a);
  assert.deepEqual(a!.consentIds, [c.id]);
  assert.match(a!.html, /ya no uso Encuadrado/);
  assert.match(a!.html, /condiciones#privacidad/);
  assert.doesNotMatch(htmlAvisoV2(), /<script/i);
  assert.equal(await registrarAvisoMostrado(a!, null, db.cliente), 1);
  const fil = db.tabla('consent_avisos')[0];
  assert.deepEqual([fil.consent_id, fil.canal, fil.texto_version], [c.id, 'correo', TEXTO_AVISO_V2_VERSION]);
  assert.equal(await avisoV2ParaCorreo('diego@ejemplo.cl', db.cliente), null, 'no se repite');
  assert.equal(await avisoV2ParaCorreo('otra@ejemplo.cl', db.cliente), null, 'sin ficha: sin aviso');
});

// ─── H5: exclusión de la IA (la supresión de transcripciones se eliminó: 02-decisiones-16oct-noche, C) ──

function escenarioExclusion() {
  const db = new SupabaseMemoria();
  const p = randomUUID(), g = randomUUID(), t = randomUUID();
  db.tabla('grabaciones').push({ id: g, patient_id: p, estado: 'lista', session_date: '2026-10-10', excluir_ia_at: null });
  db.tabla('transcripciones').push({ id: t, grabacion_id: g, r2_key: 't/x.bin', b2_key: 't/x.bin', dek_envuelta: '\\x00', deleted_at: null });
  const deps = { db: db.cliente, ahora: () => new Date('2026-10-16T12:00:00Z') };
  return { db, p, g, t, deps };
}

test('C: ya no existe la supresión de transcripciones (módulo, endpoint, botón ni textos)', () => {
  const raiz = new URL('../../../', import.meta.url);
  assert.equal(existsSync(new URL('src/lib/transcriptor/supresion.ts', raiz)), false);
  assert.equal(existsSync(new URL('src/pages/api/admin/transcriptor/suprimir.ts', raiz)), false);
  const pagina = readFileSync(new URL('src/pages/admin/pacientes/[id]/sesion/[gid].astro', raiz), 'utf8');
  assert.doesNotMatch(pagina, /suprimir|supresi[oó]n|Borrar la transcripci[oó]n|BORRAR/i);
  assert.match(pagina, /Excluir de las preguntas a la IA/);
});

test('H5: validarPedido exige motivo y canal', () => {
  assert.equal(validarPedido({ motivo: 'corto', canal: 'correo' }).ok, false);
  assert.equal(validarPedido({ motivo: 'La paciente lo pidió por correo el 15 oct', canal: 'fax' }).ok, false);
  assert.equal(validarPedido({ motivo: 'La paciente lo pidió por correo el 15 oct', canal: 'correo' }).ok, true);
});

test('H5: excluir de la IA no borra nada (transcripción intacta) y solo dentro de su ficha', async () => {
  const e = escenarioExclusion();
  const pedido = { motivo: 'Lo pidió en sesión al retirar la grabación', canal: 'presencial' };
  assert.equal((await excluirDeIA(e.g, randomUUID(), pedido, e.deps)).ok, false, 'solo dentro de su ficha');
  assert.equal((await excluirDeIA(e.g, e.p, pedido, e.deps)).ok, true);
  const t = e.db.tabla('transcripciones')[0];
  assert.deepEqual([t.deleted_at, t.dek_envuelta], [null, '\\x00']);
  assert.equal(e.db.tabla('transcriptor_auditoria').filter((a) => a.accion === 'excluir_ia').length, 1);
  assert.equal((await excluirDeIA(e.g, e.p, pedido, e.deps)).ok, true, 'repetir no falla');
});

test('H5: excluir de la IA marca la grabación y contextoSesionAnterior la salta', async () => {
  const e = escenarioExclusion();
  const r = await excluirDeIA(e.g, e.p, { motivo: 'Lo pidió en sesión al retirar la grabación', canal: 'presencial' }, e.deps);
  assert.equal(r.ok, true);
  assert.match(e.db.tabla('grabaciones')[0].excluir_ia_motivo, /presencial/);
  // Resumen de esa sesión (anterior a la de hoy): ya no se usa como contexto.
  const col = await columnasContenidoCifrado('r1', '## Resumen automático (IA)\n\n### Tareas y acuerdos\n- Registrar el ánimo.', cif);
  e.db.tabla('resumenes_ia').push({ id: 'r1', grabacion_id: e.g, estado: 'listo', oculto_at: null, version: 1, ...col });
  const hoy = { id: randomUUID(), patient_id: e.p, session_date: '2026-10-16' };
  assert.equal(await contextoSesionAnterior(hoy, e.db.cliente, cif), null);
  e.db.tabla('grabaciones')[0].excluir_ia_at = null;
  assert.match(String(await contextoSesionAnterior(hoy, e.db.cliente, cif)), /Registrar el ánimo/, 'sin exclusión sí se usa (y se descifra)');
});

// ─── H7: resumen cifrado ─────────────────────────────────────────────────────

test('H7: el contenido del resumen se cifra con su id y tipo; las filas antiguas en claro se siguen leyendo', async () => {
  const col = await columnasContenidoCifrado('r9', 'texto clínico', cif);
  assert.equal(col.contenido, null);
  assert.ok(!Buffer.from(bytesDeBytea(col.contenido_cifrado)!).toString('latin1').includes('texto clínico'));
  assert.equal(await leerContenidoResumen({ id: 'r9', ...col }, cif), 'texto clínico');
  await assert.rejects(leerContenidoResumen({ id: 'otra-fila', ...col }, cif), 'copiado a otra fila no se abre');
  assert.equal(await leerContenidoResumen({ id: 'vieja', contenido: 'en claro (antes de 0019)' }, cif), 'en claro (antes de 0019)');
  const lote = await conContenidoClaro([{ id: 'r9', ...col }, { id: 'mala', contenido_cifrado: col.contenido_cifrado }], cif);
  assert.deepEqual([lote.filas[0].contenido, lote.filas[1].contenido, lote.fallidas], ['texto clínico', null, 1]);
});

// ─── H8, H9, H14, H16, H10: prompt y rótulo ──────────────────────────────────

test('prompt del resumen: textos de 81-revision y versión nueva', () => {
  assert.equal(PROMPT_VERSION_RESUMEN, 'resumen-2026-10-16.3'); // estructura fija de Vale (02-decisiones-16oct-noche, B)
  assert.match(PARTE_FIJA_RESUMEN, /no incluyas en ninguna sección del resumen lo dicho en ese tramo/); // H8
  assert.doesNotMatch(PARTE_FIJA_RESUMEN, /NO lo omitas por tu cuenta/);
  assert.match(PARTE_FIJA_RESUMEN, /sin términos clínicos ni calificativos de gravedad como "pasiva", "activa", "leve", "grave", "problemático", "niega"/); // H9
  assert.match(PARTE_FIJA_RESUMEN, /agrega " \(inferido\)" si la asignación de hablante fue inferida/); // H9
  assert.match(PARTE_FIJA_RESUMEN, /No recomiendes medicación, derivaciones, altas ni cambios de frecuencia o de tratamiento\./); // H16
  assert.match(PARTE_FIJA_RESUMEN, /No consta en la transcripción/); // H16 simetría
  assert.match(INSTRUCCIONES_RESUMEN_POR_DEFECTO, /lo que se contó, lo que alguien dijo haber entendido y lo que se decidió/); // H16
  assert.match(PARTE_FIJA_RESUMEN, /\[pausa \/ interrupción/); // H13
});

test('H14: en pareja el bloque <sesion> lleva los nombres de pila y la advertencia de orden', () => {
  const p = armarPromptResumen({
    plantilla: 'pareja', instrucciones: null, transcripcion: [{ inicio_ms: 0, fin_ms: 1000, hablante: 'Hablante A', texto: 'hola' }],
    sesion: { fecha: '2026-10-08', modalidad: 'presencial', participantes: [{ rol: 'Terapeuta', nombre: 'Valentina' }, { rol: 'Miembro', nombre: 'Javiera Soto' }, { rol: 'Miembro', nombre: 'Diego' }] },
  });
  const u = String(p.messages[0].content);
  assert.match(u, /participantes: Terapeuta: Valentina; Miembro: Javiera; Miembro: Diego/);
  assert.doesNotMatch(u, /Soto/);
  assert.match(u, /miembros: orden no determinado/);
});

test('H10: rótulo completo del anexo y línea de datos', () => {
  assert.equal(
    avisoAnexoResumen({ modelo: 'claude-sonnet-5-5', listo_at: '2026-10-15T20:10:00Z' }),
    'Resumen automático (IA) — no revisado por la psicóloga. Generado por claude-sonnet-5-5 el 15 oct 2026, 17:10 a partir de la transcripción. Puede contener errores. No constituye la evolución clínica firmada.',
  );
  assert.match(avisoAnexoResumen({ autor: 'vale', listo_at: null }), /editada por la terapeuta/);
  assert.match(lineaEncabezado('individual', { fecha: '2026-10-03', modalidad: 'online' }), /No revisado\. No constituye la evolución clínica\.\*$/);
});

// ─── H13: huecos de interrupciones ───────────────────────────────────────────

function res(id: string, palabras: [string, number, number][], durSeg: number): ResultadoTranscripcion {
  return normalizarResultado({ id, status: 'completed', text: 'x', audio_duration: durSeg, words: palabras.map(([text, start, end]) => ({ text, start, end, confidence: 0.9, speaker: null })) } as never);
}

test('H13: huecos entre segmentos presenciales sin pausa registrada se marcan; los de una pausa no', () => {
  const segs = [
    { offset_ms: 0, resultado: res('a', [['hola', 0, 400]], 60) },          // 0–60 s
    { offset_ms: 90_000, resultado: res('b', [['sigo', 0, 400]], 60) },     // hueco 60–90 s (interrupción)
    { offset_ms: 300_000, resultado: res('c', [['vuelvo', 0, 400]], 60) },  // hueco 150–300 s (pausa a pedido)
  ];
  const pausas = [{ desde_ms: 150_000, hasta_ms: 300_000 }];
  assert.deepEqual(huecosSinPausa('presencial', segs, pausas), [{ desde_ms: 60_000, hasta_ms: 90_000 }]);
  assert.deepEqual(huecosSinPausa('online', segs, []), [], 'online no aplica (segmentos solapados del bot)');
  assert.equal(textoHueco(60_000, 90_000), '[pausa / interrupción 01:00–01:30]');
  const clara = armarTranscripcionClara({ grabacion: { origen: 'presencial', tipo: 'individual', linea_hablantes: null, mapa_hablantes: null, pausas, modelo: 'universal-2' }, segmentos: segs });
  const marcas = clara.segmentos.filter(esTramoHueco);
  assert.equal(marcas.length, 1);
  assert.equal(marcas[0].inicio_ms, 60_000);
  assert.ok(!clara.hablantes.includes(''), 'la marca no es un hablante');
  // En el prompt la marca va sin hablante y la pausa con su propio rótulo.
  const txt = formatearTranscripcion(clara.segmentos, pausas);
  assert.match(txt, /\[00:01:00\] \[pausa \/ interrupción 01:00–01:30\]/);
  assert.match(txt, /\[Grabación pausada 02:30–05:00\]/);
});
