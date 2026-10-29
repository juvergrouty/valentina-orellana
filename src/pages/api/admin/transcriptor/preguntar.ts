// POST /api/admin/transcriptor/preguntar — preguntas a la IA sobre las sesiones de UN paciente.
// Body: { patient_id: uuid, pregunta: string (1–4000), grabacion_ids?: uuid[] }
//   (sin grabacion_ids = todas las sesiones transcritas de ese paciente).
// Reglas (20-clinico §4, 30-seguridad, 01-decisiones-16oct):
//   • Solo sesiones del paciente indicado: si alguna grabación es de otro, se rechaza.
//   • Antes de descifrar se registra el acceso con auditarObligatorio (si falla, no hay respuesta).
//   • Pregunta y respuesta se guardan CIFRADAS (formato VOT1) en preguntas_ia; nunca en claro,
//     ni en logs, ni en la bitácora (solo largo y cantidad de sesiones).
//   • Messages API directa con Haiku 5.5, sin Batch y sin metadatos del paciente.
//   • Protegido por la sesión del panel (middleware) + guardiaPanel (Origin/Referer propio, X-Panel)
//     + sesión confirmada con passkey (acceso.ts).
import type { APIRoute } from 'astro';
import { gunzipSync } from 'node:zlib';
import { supabase } from '../../../../lib/supabase';
import { exigirAccesoClinico } from '../../../../lib/transcriptor/acceso';
import { guardiaPanel } from '../../../../lib/transcriptor/peticion';
import { auditar, auditarObligatorio } from '../../../../lib/transcriptor/auditoria';
import { almacenamiento } from '../../../../lib/transcriptor/almacenamiento';
import { cifrado } from '../../../../lib/transcriptor/cifrado';
import { consultarResumenes, conTextoResumen, tieneTexto, type FilaArchivo } from '../../../../lib/transcriptor/archivo';
import { ErrorClaude, clasificarError } from '../../../../lib/transcriptor/claude';
import {
  SIN_RESPUESTA, cargarInstrucciones, fechaLegible, plantillaDesdeTipo, responderPregunta,
  type SesionParaPregunta, type NotaParaPregunta,
} from '../../../../lib/transcriptor/resumen';
import { esEvolucionDesdeResumen } from '../../../../lib/transcriptor/panel';
import {
  MODELO_PREGUNTAS, ROTULO_RESPUESTA,
  type Almacenamiento, type Cifrado, type ContextoCifrado, type TranscripcionClara, type TipoSesion, type PausaGrabacion,
} from '../../../../lib/transcriptor/tipos';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PREGUNTA = 4000;
const MAX_SESIONES = 40;

// ─── Módulos de P1 (almacenamiento.ts y cifrado.ts): import directo (integrado por P6) ───
async function cargarP1(): Promise<{ alm: Almacenamiento; cif: Cifrado } | null> {
  return { alm: almacenamiento, cif: cifrado };
}

const aHex = (b: Uint8Array) => `\\x${Buffer.from(b).toString('hex')}`;

async function leerTranscripcion(p1: { alm: Almacenamiento; cif: Cifrado }, r2Key: string): Promise<TranscripcionClara> {
  const cifrado = await p1.alm.get('transcripciones', r2Key);
  let claro = await p1.cif.descifrar(cifrado, { claveObjeto: r2Key, tipo: 'transcripcion' });
  // Formato 30-seguridad §3.3: JSON comprimido con gzip antes de cifrar.
  if (claro.length > 2 && claro[0] === 0x1f && claro[1] === 0x8b) claro = gunzipSync(claro);
  const t = JSON.parse(new TextDecoder().decode(claro)) as TranscripcionClara;
  if (!Array.isArray(t?.segmentos)) throw new Error('formato de transcripción inválido');
  return t;
}

export const POST: APIRoute = async (ctx) => {
  // Acceso (revisión de seguridad 16 oct): guardiaPanel (POST, Origin/Referer propio, X-Panel: 1,
  // sesión no cerrada, falla cerrado) + sesión de nivel passkey (acceso.ts). Antes de leer nada.
  const rechazo = (await guardiaPanel(ctx, 'preguntar')) ?? (await exigirAccesoClinico(ctx, 'preguntar'));
  if (rechazo) return rechazo;
  const { request, clientAddress } = ctx;

  let body: { patient_id?: unknown; pregunta?: unknown; grabacion_ids?: unknown };
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Body inválido.' }, 400); }

  const patientId = typeof body.patient_id === 'string' ? body.patient_id.trim() : '';
  const pregunta = typeof body.pregunta === 'string' ? body.pregunta.trim() : '';
  if (!UUID.test(patientId)) return json({ ok: false, error: 'Falta el paciente.' }, 400);
  if (!pregunta) return json({ ok: false, error: 'Escribe una pregunta.' }, 400);
  if (pregunta.length > MAX_PREGUNTA) return json({ ok: false, error: `La pregunta puede tener hasta ${MAX_PREGUNTA} caracteres.` }, 400);
  let pedidas: string[] | null = null;
  if (body.grabacion_ids != null) {
    if (!Array.isArray(body.grabacion_ids) || !body.grabacion_ids.every((x) => typeof x === 'string' && UUID.test(x))) {
      return json({ ok: false, error: 'Sesiones no válidas.' }, 400);
    }
    pedidas = [...new Set(body.grabacion_ids as string[])];
    if (!pedidas.length) return json({ ok: false, error: 'Elige al menos una sesión.' }, 400);
    if (pedidas.length > MAX_SESIONES) return json({ ok: false, error: `Puedes elegir hasta ${MAX_SESIONES} sesiones.` }, 400);
  }

  // Grabaciones: SOLO de este paciente (nunca mezclar pacientes).
  let q = supabase.from('grabaciones').select('id, patient_id, booking_id, session_date, tipo, pausas, excluir_ia_at').eq('patient_id', patientId);
  if (pedidas) q = q.in('id', pedidas);
  // Las MÁS RECIENTES primero (hasta MAX_SESIONES) y luego en orden cronológico: antes, con más de 40
  // grabaciones, quedaban fuera justo las últimas (auditoría 29 oct 2026).
  const { data: recientes, error: eg } = await q.order('session_date', { ascending: false }).limit(MAX_SESIONES);
  if (eg) return json({ ok: false, error: 'No se pudieron leer las sesiones.' }, 500);
  const grabaciones = [...(recientes ?? [])].reverse();
  if (pedidas && (grabaciones?.length ?? 0) !== pedidas.length) {
    await auditar('vale', 'preguntar', { patientId, request, clientAddress, resultado: 'denegado', detalle: { motivo: 'grabacion_de_otro_paciente_o_inexistente', pedidas: pedidas.length } });
    return json({ ok: false, error: 'Alguna sesión no pertenece a esta ficha.' }, 400);
  }
  // H5: sesiones excluidas de la IA a pedido del paciente (grabaciones.excluir_ia_at, 0019): nunca entran.
  const excluidas = (grabaciones ?? []).filter((g) => g.excluir_ia_at);
  if (pedidas && excluidas.length) {
    return json({ ok: false, error: 'Alguna de las sesiones elegidas fue excluida de las preguntas a la IA a pedido del paciente.' }, 400);
  }
  const permitidas = (grabaciones ?? []).filter((g) => !g.excluir_ia_at);
  const ids = permitidas.map((g) => g.id as string);

  // Notas clínicas escritas por Vale (29 oct 2026): session_notes vigentes + notas generales de la ficha.
  // Solo al preguntar por toda la ficha (si elige sesiones puntuales, solo esas). Aquí solo se CUENTAN;
  // el texto se lee después de la bitácora (como el resto del contenido clínico).
  let hayNotas = false;
  if (!pedidas) {
    const [{ count, error: en }, { count: conGenerales, error: ef }] = await Promise.all([
      supabase.from('session_notes').select('id', { count: 'exact', head: true }).eq('patient_id', patientId).is('deleted_at', null),
      supabase.from('patients').select('id', { count: 'exact', head: true }).eq('id', patientId).not('notes', 'is', null).neq('notes', ''),
    ]);
    if (en || ef) return json({ ok: false, error: 'No se pudieron leer tus notas clínicas.' }, 500);
    hayNotas = (count ?? 0) > 0 || (conGenerales ?? 0) > 0;
  }
  if (!ids.length && !hayNotas) return json({ ok: false, error: excluidas.length ? 'Las sesiones de esta ficha están excluidas de las preguntas a la IA.' : 'Esta ficha no tiene sesiones grabadas ni notas clínicas.' }, 404);

  const [{ data: transcripciones, error: et }, { data: resumenes }] = await Promise.all([
    // Sin grabaciones (solo notas) no se consulta nada: un .in() vacío.
    supabase.from('transcripciones').select('id, grabacion_id, r2_key').in('grabacion_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']).is('deleted_at', null),
    // 86-revisión M2: sin 0020 se lee igual (sin columnas de archivo).
    consultarResumenes<FilaArchivo[]>((cols) => supabase.from('resumenes_ia').select(`id, grabacion_id, version, contenido, contenido_cifrado${cols}`).in('grabacion_id', ids)
      .eq('estado', 'listo').is('oculto_at', null).order('version', { ascending: false })),
  ]);
  if (et) return json({ ok: false, error: 'No se pudieron leer las transcripciones.' }, 500);
  const trPorGrab = new Map((transcripciones ?? []).map((t) => [t.grabacion_id as string, t.r2_key as string]));
  // H7: el resumen puede estar cifrado; aquí solo se ve si existe (se descifra DESPUÉS de la bitácora).
  // 02-decisiones-16oct-noche B: los de sesiones antiguas están archivados en R2 (+B2): solo lectura,
  // se traen de ahí en memoria (archivo.ts) y nunca se vuelven a escribir en la base.
  const resFilaPorGrab = new Map<string, FilaArchivo>();
  for (const r of resumenes ?? []) {
    if (!resFilaPorGrab.has(r.grabacion_id as string) && tieneTexto(r as FilaArchivo)) resFilaPorGrab.set(r.grabacion_id as string, r as FilaArchivo);
  }
  const resPorGrab = new Map<string, string>();
  const usables = permitidas.filter((g) => trPorGrab.has(g.id as string) || resFilaPorGrab.has(g.id as string));
  if (!usables.length && !hayNotas) return json({ ok: false, error: 'Aún no hay transcripciones listas ni notas clínicas en esta ficha.' }, 404);

  const p1 = await cargarP1(); // también sin transcripciones: el historial de la pregunta se guarda cifrado
  if (trPorGrab.size && !p1) return json({ ok: false, error: 'El almacenamiento cifrado aún no está configurado.' }, 503);

  // Bitácora ANTES de tocar contenido clínico. Sin texto de la pregunta.
  try {
    await auditarObligatorio('vale', 'preguntar', {
      patientId, request, clientAddress,
      detalle: { sesiones: usables.length, con_notas: hayNotas, largo: pregunta.length, modelo: MODELO_PREGUNTAS },
    });
  } catch {
    return json({ ok: false, error: 'No se pudo registrar el acceso en la bitácora; por seguridad no se responde.' }, 503);
  }

  // Notas de la terapeuta: nunca las de una sesión excluida de la IA a pedido del paciente (misma reserva o fecha).
  let notas: NotaParaPregunta[] = [];
  if (hayNotas) {
    // Exclusiones de TODA la ficha (no solo de las grabaciones leídas arriba, que tienen tope).
    const { data: todasExcluidas, error: ex } = await supabase.from('grabaciones').select('booking_id, session_date')
      .eq('patient_id', patientId).not('excluir_ia_at', 'is', null);
    if (ex) return json({ ok: false, error: 'No se pudieron leer tus notas clínicas.' }, 500);
    const reservasExcluidas = new Set((todasExcluidas ?? []).map((g) => g.booking_id as string | null).filter(Boolean) as string[]);
    const fechasExcluidas = new Set((todasExcluidas ?? []).map((g) => String(g.session_date)));
    const [{ data: filasNotas, error: en }, { data: ficha, error: ef }] = await Promise.all([
      supabase.from('session_notes').select('booking_id, session_date, content').eq('patient_id', patientId).is('deleted_at', null).order('session_date', { ascending: true }).limit(300),
      supabase.from('patients').select('notes').eq('id', patientId).maybeSingle(),
    ]);
    if (en || ef) return json({ ok: false, error: 'No se pudieron leer tus notas clínicas.' }, 500);
    notas = (filasNotas ?? [])
      .filter((n) => String(n.content ?? '').trim())
      .filter((n) => !(n.booking_id && reservasExcluidas.has(n.booking_id as string)) && !fechasExcluidas.has(String(n.session_date)))
      .map((n) => ({
        fecha: n.session_date ? String(n.session_date).slice(0, 10) : null,
        texto: String(n.content),
        origen: esEvolucionDesdeResumen(String(n.content)) ? 'basada_en_resumen_ia' as const : 'terapeuta' as const,
      }));
    if (String(ficha?.notes ?? '').trim()) notas.unshift({ fecha: null, texto: String(ficha!.notes), origen: 'general' });
  }

  // Descifrar resúmenes (H7) y transcripciones (las que fallen quedan con su resumen, si existe).
  {
    const claves = [...resFilaPorGrab.keys()];
    const { filas } = await conTextoResumen(claves.map((k) => resFilaPorGrab.get(k)!), { cif: cifrado, alm: almacenamiento });
    filas.forEach((f, i) => { if (f.contenido) resPorGrab.set(claves[i], f.contenido); });
  }
  const sesiones: SesionParaPregunta[] = [];
  const grabDeSesion: string[] = [];
  let fallasLectura = 0;
  for (const g of usables) {
    const gid = g.id as string;
    let tramos: SesionParaPregunta['tramos'] = null;
    const key = trPorGrab.get(gid);
    if (key && p1) {
      try { tramos = (await leerTranscripcion(p1, key)).segmentos; }
      catch { fallasLectura++; console.warn('[transcriptor/preguntar] no se pudo leer una transcripción'); }
    }
    if (!tramos?.length && !resPorGrab.has(gid)) continue;
    sesiones.push({
      fecha: g.session_date as string,
      tipo: plantillaDesdeTipo(g.tipo as TipoSesion),
      tramos,
      resumen: resPorGrab.get(gid) ?? null,
      pausas: (g.pausas as PausaGrabacion[] | null) ?? [],
    });
    grabDeSesion.push(gid);
  }
  if (!sesiones.length && !notas.length) return json({ ok: false, error: 'No se pudieron leer las transcripciones.' }, 502);

  const id = crypto.randomUUID();
  const ctxPregunta: ContextoCifrado = { claveObjeto: `preguntas_ia/${id}/pregunta`, tipo: 'pregunta' };
  const ctxRespuesta: ContextoCifrado = { claveObjeto: `preguntas_ia/${id}/respuesta`, tipo: 'respuesta' };

  let instrucciones: string | null = null;
  try { instrucciones = (await cargarInstrucciones('preguntas')).texto; } catch { /* se usa el texto por defecto */ }

  try {
    const r = await responderPregunta({ pregunta, instrucciones, sesiones, notas });
    const usadas = r.incluidas.map((x) => grabDeSesion[x.indice]);

    if (p1) {
      try {
        const [cp, cr] = await Promise.all([
          p1.cif.cifrar(new TextEncoder().encode(pregunta), ctxPregunta),
          p1.cif.cifrar(new TextEncoder().encode(r.respuesta), ctxRespuesta),
        ]);
        const { error } = await supabase.from('preguntas_ia').insert({
          id,
          patient_id: patientId,
          grabacion_ids: usadas,
          pregunta_cifrada: aHex(cp.datos),
          respuesta_cifrada: aHex(cr.datos),
          pregunta_largo: pregunta.length,
          kek_v: cp.kekV,
          modelo: r.modelo,
          tokens_entrada: r.uso.entrada + r.uso.cacheEscritura + r.uso.cacheLectura,
          tokens_salida: r.uso.salida,
          tokens_cache: r.uso.cacheLectura,
          costo_usd: r.costoUsd,
        });
        if (error) console.warn('[transcriptor/preguntar] no se pudo guardar el historial:', error.code);
      } catch {
        console.warn('[transcriptor/preguntar] no se pudo cifrar el historial');
      }
    }

    return json({
      ok: true,
      id,
      rotulo: ROTULO_RESPUESTA,
      respuesta: r.respuesta,
      sin_respuesta: r.respuesta.startsWith(SIN_RESPUESTA),
      sesiones: r.incluidas.map((x) => ({ grabacion_id: grabDeSesion[x.indice], fecha: fechaLegible(x.fecha), fuente: x.fuente })),
      omitidas: r.omitidas.map((i) => ({ grabacion_id: grabDeSesion[i], fecha: fechaLegible(sesiones[i].fecha) })),
      notas_usadas: r.notasIncluidas,
      lectura_fallida: fallasLectura,
      citas_eliminadas: r.citasEliminadas,
      costo_usd: r.costoUsd,
    });
  } catch (e) {
    const err = e instanceof ErrorClaude ? e : clasificarError(e);
    // Registro del intento fallido (pregunta cifrada; sin respuesta). Solo el código del error.
    if (p1) {
      try {
        const cp = await p1.cif.cifrar(new TextEncoder().encode(pregunta), ctxPregunta);
        await supabase.from('preguntas_ia').insert({
          id, patient_id: patientId, grabacion_ids: grabDeSesion, pregunta_cifrada: aHex(cp.datos),
          pregunta_largo: pregunta.length, kek_v: cp.kekV, modelo: MODELO_PREGUNTAS, error: err.codigo,
        });
      } catch { /* sin historial del error */ }
    }
    console.warn('[transcriptor/preguntar] falló la consulta a Claude:', err.codigo);
    const mensaje = err.codigo === 'sin_llave'
      ? 'Falta configurar la llave de Anthropic.'
      : err.recuperable ? 'La IA no está disponible en este momento. Intenta de nuevo en unos minutos.' : 'No se pudo responder esta pregunta.';
    return json({ ok: false, error: mensaje }, err.codigo === 'sin_llave' ? 503 : 502);
  }
};
