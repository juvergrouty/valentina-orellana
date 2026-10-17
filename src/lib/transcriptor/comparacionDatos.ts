// Transcriptor IA — base de datos de la prueba ciega Sonnet vs Haiku (tabla transcriptor_comparaciones, 0025).
// Solo servidor. La página (/admin/transcriptor/comparar) y el endpoint (/api/admin/transcriptor/comparar)
// usan estas funciones DESPUÉS de exigir la sesión con passkey (acceso.ts).
//   • Casos reales: transcripciones de la ficha "Prueba Transcriptor". Se leen igual que la vista de
//     transcripción (auditarObligatorio 'ver_transcripcion' ANTES de descifrar) y sus resúmenes se
//     guardan CIFRADOS (VOT1, DEK propia por resumen); el comentario de Vale también.
//   • Casos sintéticos: fixtures inventados del repo; van en claro.
//   • Nunca se escribe contenido en logs ni en la bitácora (solo ids, conteos y códigos).
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase as supabasePorDefecto } from '../supabase';
import { auditar, auditarObligatorio } from './auditoria';
import { cifrado as cifradoPorDefecto, type CifradoVOT1, type ContextoCifrado } from './cifrado';
import { bytesDeBytea } from './resumenCifrado';
import { cargarInstrucciones, fechaLegible, nombreDePila, plantillaDesdeTipo, type MetaSesion, type Participante } from './resumen';
import {
  ACCION_COMPARAR, PACIENTE_PRUEBA, detalleDe, realesBajoTope, evaluarResumen, generarPar, puedeRevelar, sortearOrden,
  type CasoParaRevelar, type DetalleResumen, type EntradaPar, type ModeloComparado, type Preferencia,
} from './comparacion';
import { CASOS_SINTETICOS, casoSintetico, tramosDeGuion } from './pruebas/comparacion';
import type { EsperadoCaso } from './pruebas/comparacion/tipos';
import type { Origen, TipoSesion } from './tipos';

export const TABLA = 'transcriptor_comparaciones';
const COLUMNAS = 'id, corrida_id, orden, tipo, caso_clave, etiqueta, grabacion_id, patient_id, modelo_1, modelo_2, estado, error_codigo, resumen_1, resumen_2, resumen_1_cifrado, resumen_2_cifrado, detalle_1, detalle_2, costo_usd_1, costo_usd_2, preferencia, comentario, comentario_cifrado, created_at, generando_at, listo_at, votado_at';
/** Una toma 'generando' más vieja que esto se considera cortada (maxDuration 300 s) y se puede retomar. */
const TOMA_VENCIDA_MS = 6 * 60_000;

export interface FilaComparacion extends CasoParaRevelar {
  corrida_id: string;
  orden: number;
  tipo: 'real' | 'sintetico';
  caso_clave: string;
  etiqueta: string;
  grabacion_id: string | null;
  patient_id: string | null;
  error_codigo: string | null;
  resumen_1: string | null;
  resumen_2: string | null;
  resumen_1_cifrado?: unknown;
  resumen_2_cifrado?: unknown;
  detalle_1: DetalleResumen | null;
  detalle_2: DetalleResumen | null;
  comentario: string | null;
  comentario_cifrado?: unknown;
  created_at: string;
  generando_at: string | null;
  listo_at: string | null;
  votado_at: string | null;
}

export interface Deps {
  db?: SupabaseClient;
  cif?: Pick<CifradoVOT1, 'cifrar' | 'descifrar'>;
  request?: Request | null;
  clientAddress?: string | null;
}

export class ErrorComparacion extends Error {
  constructor(readonly codigo: string, mensaje: string, readonly status = 400) { super(mensaje); this.name = 'ErrorComparacion'; }
}

/** La tabla no existe todavía (0025 sin aplicar). */
export function esFaltaMigracion(e: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return !!e && (e.code === '42P01' || e.code === 'PGRST205' || /transcriptor_comparaciones/.test(e.message ?? '') && /does not exist|schema cache/i.test(e.message ?? ''));
}

const MSG_MIGRACION = 'Falta aplicar la migración 0025_transcriptor_comparaciones.sql en Supabase.';

function verificarError(e: { code?: string | null; message?: string | null } | null, accion: string): void {
  if (!e) return;
  if (esFaltaMigracion(e)) throw new ErrorComparacion('sin_migracion', MSG_MIGRACION, 503);
  throw new ErrorComparacion('base', `No se pudo ${accion} (${e.code ?? 'error'}). Intenta de nuevo.`, 500);
}

const ctx = (id: string, campo: 'resumen_1' | 'resumen_2' | 'comentario'): ContextoCifrado =>
  ({ claveObjeto: `${TABLA}/${id}/${campo}`, tipo: 'resumen' });
const aHex = (b: Uint8Array) => `\\x${Buffer.from(b).toString('hex')}`;

async function cifrarTexto(cif: Deps['cif'], id: string, campo: 'resumen_1' | 'resumen_2' | 'comentario', texto: string) {
  const r = await (cif ?? cifradoPorDefecto).cifrar(new TextEncoder().encode(texto), ctx(id, campo));
  return { hex: aHex(r.datos), kekV: r.kekV };
}

async function descifrarTexto(cif: Deps['cif'], id: string, campo: 'resumen_1' | 'resumen_2' | 'comentario', v: unknown): Promise<string | null> {
  const datos = bytesDeBytea(v);
  if (!datos?.length) return null;
  const claro = await (cif ?? cifradoPorDefecto).descifrar(datos, ctx(id, campo));
  return new TextDecoder('utf-8', { fatal: true }).decode(claro);
}

// ─── Crear corrida ───────────────────────────────────────────────────────────

interface GrabReal { id: string; patient_id: string; tipo: TipoSesion | null; origen: Origen; session_date: string; duracion_seg: number | null; pausas: unknown }

/** Grabaciones de la ficha de prueba con transcripción guardada (las más recientes, hasta el tope). */
async function grabacionesReales(db: SupabaseClient): Promise<GrabReal[]> {
  const { data: gs, error } = await db.from('grabaciones')
    .select('id, patient_id, tipo, origen, session_date, duracion_seg, pausas')
    .eq('patient_id', PACIENTE_PRUEBA).is('excluir_ia_at', null)
    .order('session_date', { ascending: false }).order('created_at', { ascending: false }).limit(20);
  if (error) throw new ErrorComparacion('base', 'No se pudieron leer las grabaciones de la ficha de prueba.', 500);
  const ids = (gs ?? []).map((g) => g.id as string);
  if (!ids.length) return [];
  const { data: trs, error: et } = await db.from('transcripciones').select('grabacion_id').in('grabacion_id', ids).is('deleted_at', null);
  if (et) throw new ErrorComparacion('base', 'No se pudieron leer las transcripciones de la ficha de prueba.', 500);
  const con = new Set((trs ?? []).map((t) => t.grabacion_id as string));
  // Solo los que caben bajo el tope de costo de la corrida (con los sintéticos incluidos).
  const candidatos = ((gs ?? []) as GrabReal[]).filter((g) => con.has(g.id)).map((g) => ({ g, minutos: (Number(g.duracion_seg) || 60 * 60) / 60 }));
  return realesBajoTope(candidatos, CASOS_SINTETICOS.map((c) => c.duracionMin)).map((x) => x.g);
}

export async function crearCorrida(deps: Deps = {}): Promise<{ corridaId: string; casos: { id: string; etiqueta: string }[] }> {
  const db = deps.db ?? supabasePorDefecto;
  // ¿Existe la tabla? (antes de leer nada clínico)
  verificarError((await db.from(TABLA).select('id').limit(1)).error, 'leer las comparaciones');
  const reales = await grabacionesReales(db);
  const corridaId = crypto.randomUUID();
  let orden = 0;
  const filas = [
    ...reales.map((g, i) => ({
      tipo: 'real' as const, caso_clave: `real-${g.id}`, grabacion_id: g.id, patient_id: g.patient_id,
      etiqueta: `Real ${i + 1} · ficha de prueba · ${fechaLegible(g.session_date)}${g.duracion_seg ? ` · ${Math.round(g.duracion_seg / 60)} min` : ''}`,
    })),
    ...CASOS_SINTETICOS.map((c) => ({ tipo: 'sintetico' as const, caso_clave: c.clave, grabacion_id: null, patient_id: null, etiqueta: c.etiqueta })),
  ].map((f) => ({ ...f, id: crypto.randomUUID(), corrida_id: corridaId, orden: ++orden, estado: 'pendiente', ...sortearOrden() }));
  const { error } = await db.from(TABLA).insert(filas);
  verificarError(error, 'crear la comparación');
  await auditar('vale', ACCION_COMPARAR, {
    request: deps.request, clientAddress: deps.clientAddress, cliente: db,
    detalle: { paso: 'crear', corrida_id: corridaId, reales: reales.length, sinteticos: CASOS_SINTETICOS.length },
  });
  return { corridaId, casos: filas.map((f) => ({ id: f.id, etiqueta: f.etiqueta })) };
}

// ─── Generar un caso (los dos resúmenes) ─────────────────────────────────────

async function entradaReal(db: SupabaseClient, f: FilaComparacion, deps: Deps): Promise<EntradaPar> {
  if (!f.grabacion_id) throw new ErrorComparacion('caso', 'La grabación de este caso ya no existe.', 409);
  const [{ data: g }, { data: tr }, { data: p }] = await Promise.all([
    db.from('grabaciones').select('id, patient_id, tipo, origen, session_date, duracion_seg, pausas, excluir_ia_at').eq('id', f.grabacion_id).maybeSingle(),
    db.from('transcripciones').select('id, r2_key').eq('grabacion_id', f.grabacion_id).is('deleted_at', null).maybeSingle(),
    db.from('patients').select('name').eq('id', PACIENTE_PRUEBA).maybeSingle(),
  ]);
  // Defensa: solo la ficha de prueba, nunca otra.
  if (!g || g.patient_id !== PACIENTE_PRUEBA || f.patient_id !== PACIENTE_PRUEBA) throw new ErrorComparacion('caso', 'Este caso no es de la ficha de prueba.', 409);
  if (g.excluir_ia_at) throw new ErrorComparacion('caso', 'Esta sesión fue excluida de la IA.', 409);
  if (!tr) throw new ErrorComparacion('caso', 'Esta sesión ya no tiene transcripción guardada.', 409);
  // Igual que la vista de transcripción: primero la bitácora (si falla, no se descifra nada).
  await auditarObligatorio('vale', 'ver_transcripcion', {
    grabacionId: g.id as string, patientId: PACIENTE_PRUEBA, request: deps.request, clientAddress: deps.clientAddress, cliente: db,
    detalle: { transcripcion_id: tr.id, vista: 'comparar_modelos', caso_id: f.id },
  });
  const { almacenamiento } = await import('./almacenamiento');
  const tramos = (await almacenamiento.leerTranscripcion(tr.r2_key as string)).segmentos;
  const participantes: Participante[] = [{ rol: 'Terapeuta', nombre: 'Valentina' }];
  const pila = nombreDePila((p as { name?: string } | null)?.name);
  if (pila) participantes.push({ rol: 'Paciente', nombre: pila });
  return {
    plantilla: plantillaDesdeTipo(g.tipo as TipoSesion),
    instrucciones: '',
    transcripcion: tramos,
    sesion: {
      fecha: g.session_date as string, modalidad: g.origen as Origen,
      duracionMin: g.duracion_seg ? Number(g.duracion_seg) / 60 : null,
      participantes, pausas: Array.isArray(g.pausas) ? g.pausas : [],
    },
  };
}

function entradaSintetica(f: FilaComparacion): { entrada: EntradaPar; esperado: EsperadoCaso } {
  const c = casoSintetico(f.caso_clave);
  if (!c) throw new ErrorComparacion('caso', 'Caso sintético desconocido.', 409);
  const sesion: MetaSesion = { fecha: c.fecha, modalidad: c.modalidad, duracionMin: c.duracionMin, participantes: c.participantes, pausas: c.pausas ?? [] };
  return { entrada: { plantilla: c.plantilla, instrucciones: '', transcripcion: tramosDeGuion(c.guion, c.finSeg), sesion }, esperado: c.esperado };
}

export async function generarCaso(id: string, deps: Deps = {}): Promise<{ estado: 'listo' | 'error'; codigo?: string }> {
  const db = deps.db ?? supabasePorDefecto;
  const ahora = new Date();
  const vencida = new Date(ahora.getTime() - TOMA_VENCIDA_MS).toISOString();
  // Toma atómica: un doble clic o dos pestañas no generan (ni cobran) dos veces.
  const { data: tomada, error } = await db.from(TABLA)
    .update({ estado: 'generando', generando_at: ahora.toISOString(), error_codigo: null })
    .eq('id', id)
    .or(`estado.in.(pendiente,error),and(estado.eq.generando,generando_at.lt."${vencida}")`)
    .select(COLUMNAS).maybeSingle();
  verificarError(error, 'tomar el caso');
  if (!tomada) {
    const { data: actual } = await db.from(TABLA).select('estado').eq('id', id).maybeSingle();
    if (!actual) throw new ErrorComparacion('no_existe', 'No se encontró el caso.', 404);
    if (actual.estado === 'listo') return { estado: 'listo' };
    throw new ErrorComparacion('ocupado', 'Este caso ya se está generando. Espera un momento.', 409);
  }
  const f = tomada as unknown as FilaComparacion;
  const fallar = async (codigo: string) => {
    await db.from(TABLA).update({ estado: 'error', error_codigo: codigo.slice(0, 80) }).eq('id', id);
    await auditar('vale', ACCION_COMPARAR, { request: deps.request, clientAddress: deps.clientAddress, cliente: db, resultado: 'error', grabacionId: f.grabacion_id, patientId: f.patient_id, detalle: { paso: 'generar', caso_id: id, codigo } });
    return { estado: 'error' as const, codigo };
  };

  let entrada: EntradaPar;
  let esperado: EsperadoCaso | null = null;
  try {
    if (f.tipo === 'real') entrada = await entradaReal(db, f, deps);
    else ({ entrada, esperado } = entradaSintetica(f));
    // Mismas instrucciones activas de Vale que usa producción (o el texto por defecto).
    entrada.instrucciones = (await cargarInstrucciones('resumen', db)).texto;
  } catch (e) {
    console.warn('[transcriptor/comparar] no se pudo preparar el caso:', e instanceof Error ? e.name : 'error');
    return fallar(e instanceof ErrorComparacion ? e.codigo : 'preparar');
  }

  // Dos intentos de 110 s como máximo por modelo, en paralelo: cabe en maxDuration (300 s).
  const [a, b] = await generarPar(entrada, [f.modelo_1 as ModeloComparado, f.modelo_2 as ModeloComparado], { intentos: 2, timeoutMs: 110_000, esperasMs: [3_000] });
  if (!a.ok || !b.ok) return fallar(`${!a.ok ? `r1_${a.codigo}` : ''}${!a.ok && !b.ok ? '+' : ''}${!b.ok ? `r2_${b.codigo}` : ''}`);

  const real = f.tipo === 'real';
  const conocidos = (entrada.sesion.participantes ?? []).map((p) => p.nombre);
  const evaluar = (r: typeof a.r) => evaluarResumen({
    textoModelo: r.textoModelo, contenido: r.contenido, verificacion: r.verificacion, tramos: entrada.transcripcion,
    truncado: r.truncado, conocidos, esperado,
  });
  const cambios: Record<string, unknown> = {
    estado: 'listo', listo_at: new Date().toISOString(), error_codigo: null,
    detalle_1: detalleDe(a.r, evaluar(a.r), real), detalle_2: detalleDe(b.r, evaluar(b.r), real),
    costo_usd_1: a.r.costoUsd, costo_usd_2: b.r.costoUsd,
  };
  try {
    if (real) {
      const [c1, c2] = await Promise.all([cifrarTexto(deps.cif, id, 'resumen_1', a.r.contenido), cifrarTexto(deps.cif, id, 'resumen_2', b.r.contenido)]);
      Object.assign(cambios, { resumen_1: null, resumen_2: null, resumen_1_cifrado: c1.hex, resumen_2_cifrado: c2.hex, kek_v: c1.kekV });
    } else {
      Object.assign(cambios, { resumen_1: a.r.contenido, resumen_2: b.r.contenido });
    }
  } catch {
    return fallar('cifrado');
  }
  const { error: eu } = await db.from(TABLA).update(cambios).eq('id', id);
  if (eu) return fallar(`guardar_${eu.code ?? 'error'}`);
  await auditar('vale', ACCION_COMPARAR, {
    request: deps.request, clientAddress: deps.clientAddress, cliente: db, grabacionId: f.grabacion_id, patientId: f.patient_id,
    detalle: { paso: 'generar', caso_id: id, tipo: f.tipo, costo_usd: Math.round((a.r.costoUsd + b.r.costoUsd) * 100_000) / 100_000 },
  });
  return { estado: 'listo' };
}

// ─── Votar ───────────────────────────────────────────────────────────────────

export const MAX_COMENTARIO = 2_000;

export async function votar(id: string, preferencia: Preferencia, comentario: string, deps: Deps = {}): Promise<{ revelado: boolean }> {
  const db = deps.db ?? supabasePorDefecto;
  const { data: f, error } = await db.from(TABLA).select('id, corrida_id, tipo, estado, grabacion_id, patient_id').eq('id', id).maybeSingle();
  verificarError(error, 'leer el caso');
  if (!f) throw new ErrorComparacion('no_existe', 'No se encontró el caso.', 404);
  if (f.estado !== 'listo') throw new ErrorComparacion('no_listo', 'Este caso todavía no tiene sus dos resúmenes.', 409);
  const { data: todas, error: et } = await db.from(TABLA).select('id, estado, preferencia').eq('corrida_id', f.corrida_id);
  verificarError(et, 'leer la comparación');
  // Ya revelado: los votos quedan fijos (si no, la prueba deja de ser ciega).
  if (puedeRevelar((todas ?? []) as Pick<CasoParaRevelar, 'estado' | 'preferencia'>[])) {
    throw new ErrorComparacion('revelado', 'Esta comparación ya se reveló; los votos no se pueden cambiar.', 409);
  }
  const texto = comentario.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim().slice(0, MAX_COMENTARIO);
  const cambios: Record<string, unknown> = { preferencia, votado_at: new Date().toISOString(), comentario: null, comentario_cifrado: null };
  if (texto) {
    if (f.tipo === 'real') {
      try { cambios.comentario_cifrado = (await cifrarTexto(deps.cif, id, 'comentario', texto)).hex; }
      catch { throw new ErrorComparacion('cifrado', 'No se pudo cifrar el comentario. No se guardó el voto.', 503); }
    } else cambios.comentario = texto;
  }
  const { error: eu } = await db.from(TABLA).update(cambios).eq('id', id).eq('estado', 'listo');
  verificarError(eu, 'guardar el voto');
  await auditar('vale', ACCION_COMPARAR, {
    request: deps.request, clientAddress: deps.clientAddress, cliente: db, grabacionId: f.grabacion_id as string | null, patientId: f.patient_id as string | null,
    detalle: { paso: 'votar', caso_id: id, con_comentario: !!texto },
  });
  const despues = ((todas ?? []) as { id: string; estado: CasoParaRevelar['estado']; preferencia: Preferencia | null }[])
    .map((x) => (x.id === id ? { ...x, preferencia } : x));
  return { revelado: puedeRevelar(despues) };
}

// ─── Leer la última corrida (para la página) ─────────────────────────────────

export interface CasoVista extends FilaComparacion {
  texto_1: string | null;
  texto_2: string | null;
  comentario_claro: string | null;
  fallo_lectura: boolean;
}

export interface CorridaVista { corridaId: string; creada: string; casos: CasoVista[]; corridasPrevias: number }

export async function leerUltimaCorrida(deps: Deps = {}): Promise<CorridaVista | null> {
  const db = deps.db ?? supabasePorDefecto;
  const { data: ult, error } = await db.from(TABLA).select('corrida_id, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle();
  verificarError(error, 'leer las comparaciones');
  if (!ult) return null;
  const [{ data: filas, error: ef }, { data: todas }] = await Promise.all([
    db.from(TABLA).select(COLUMNAS).eq('corrida_id', ult.corrida_id).order('orden', { ascending: true }),
    db.from(TABLA).select('corrida_id').limit(2000),
  ]);
  verificarError(ef, 'leer la comparación');
  const lista = (filas ?? []) as unknown as FilaComparacion[];
  const reales = lista.filter((f) => f.tipo === 'real' && f.estado === 'listo');
  // Igual que la vista de sesión: antes de descifrar resúmenes reales, `ver_resumen` obligatorio.
  let puedeDescifrar = true;
  if (reales.length) {
    try {
      await auditarObligatorio('vale', 'ver_resumen', {
        patientId: PACIENTE_PRUEBA, request: deps.request, clientAddress: deps.clientAddress, cliente: db,
        detalle: { vista: 'comparar_modelos', corrida_id: ult.corrida_id, casos: reales.length },
      });
    } catch { puedeDescifrar = false; }
  }
  const casos = await Promise.all(lista.map(async (f): Promise<CasoVista> => {
    if (f.tipo !== 'real') return { ...f, texto_1: f.resumen_1, texto_2: f.resumen_2, comentario_claro: f.comentario, fallo_lectura: false };
    if (f.estado !== 'listo' || !puedeDescifrar) return { ...f, texto_1: null, texto_2: null, comentario_claro: null, fallo_lectura: f.estado === 'listo' };
    try {
      const [t1, t2, cm] = await Promise.all([
        descifrarTexto(deps.cif, f.id, 'resumen_1', f.resumen_1_cifrado),
        descifrarTexto(deps.cif, f.id, 'resumen_2', f.resumen_2_cifrado),
        descifrarTexto(deps.cif, f.id, 'comentario', f.comentario_cifrado),
      ]);
      return { ...f, texto_1: t1, texto_2: t2, comentario_claro: cm, fallo_lectura: !t1 || !t2 };
    } catch {
      return { ...f, texto_1: null, texto_2: null, comentario_claro: null, fallo_lectura: true };
    }
  }));
  // Los bytes cifrados no salen de aquí.
  for (const c of casos) { delete c.resumen_1_cifrado; delete c.resumen_2_cifrado; delete c.comentario_cifrado; }
  const previas = new Set(((todas ?? []) as { corrida_id: string }[]).map((x) => x.corrida_id));
  return { corridaId: ult.corrida_id as string, creada: ult.created_at as string, casos, corridasPrevias: Math.max(0, previas.size - 1) };
}
