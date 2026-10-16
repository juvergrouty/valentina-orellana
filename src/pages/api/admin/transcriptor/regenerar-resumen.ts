// POST /api/admin/transcriptor/regenerar-resumen — P7 (50-arquitectura §3.8; trigger de 0014).
// Un resumen nunca se pisa ni se borra: las dos acciones crean una VERSIÓN NUEVA en resumenes_ia.
//   { accion: 'regenerar', grabacion_id }
//       → fila nueva autor='ia', estado 'pendiente' (la toma el orquestador P6) y la grabación
//         pasa de 'lista' a 'resumiendo' (transición atómica: un doble clic no crea dos).
//   { accion: 'editar', grabacion_id, resumen_id, contenido }
//       → fila nueva autor='vale', basado_en = resumen_id, estado 'listo'. La versión de la IA
//         queda intacta (el trigger resumenes_ia_protegido lo garantiza en la base).
// Auth del panel + Origin/Referer propio + X-Panel + bitácora (sin contenido).
import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { auditar } from '../../../../lib/transcriptor/auditoria';
import { transicionar } from '../../../../lib/transcriptor/estados';
import { MAX_RESUMEN_EDITADO, ROTULO_EDITADO } from '../../../../lib/transcriptor/panel';
import { esUuid, guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';
import { cargarInstrucciones, plantillaDesdeTipo } from '../../../../lib/transcriptor/resumen';
import { AJUSTES, type TipoSesion } from '../../../../lib/transcriptor/tipos';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const rechazo = await guardiaPanel(ctx, 'regenerar_resumen');
  if (rechazo) return rechazo;
  const { request } = ctx;
  const clientAddress = safeAddr(ctx);
  const body = await leerJson(request, 128 * 1024);
  if (!body) return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  const grabacionId = body.grabacion_id;
  if (!esUuid(grabacionId)) return json({ ok: false, error: 'Falta la grabación.' }, 400);

  const { data: g, error: eg } = await supabase.from('grabaciones')
    .select('id, patient_id, booking_id, tipo, estado').eq('id', grabacionId).maybeSingle();
  if (eg) return json({ ok: false, error: 'No se pudo leer la grabación. Intenta de nuevo.' }, 500);
  if (!g) return json({ ok: false, error: 'No se encontró la grabación.' }, 404);

  const { data: versiones, error: ev } = await supabase.from('resumenes_ia')
    .select('id, version, autor, estado, plantilla, modelo, modo, instrucciones_id, prompt_version, transcripcion_id')
    .eq('grabacion_id', grabacionId).order('version', { ascending: false });
  if (ev) return json({ ok: false, error: 'No se pudieron leer los resúmenes. Intenta de nuevo.' }, 500);
  const siguiente = (versiones?.[0]?.version ?? 0) + 1;

  // ── Editar: versión de Vale basada en una versión lista ────────────────────
  if (body.accion === 'editar') {
    const contenido = typeof body.contenido === 'string' ? body.contenido.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim() : '';
    if (!contenido) return json({ ok: false, error: 'El resumen no puede quedar vacío.' }, 400);
    if (contenido.length > MAX_RESUMEN_EDITADO) return json({ ok: false, error: `El resumen puede tener hasta ${MAX_RESUMEN_EDITADO.toLocaleString('es-CL')} caracteres.` }, 400);
    const base = (versiones ?? []).find((v) => v.id === body.resumen_id);
    if (!esUuid(body.resumen_id) || !base) return json({ ok: false, error: 'No se encontró la versión que estás editando.' }, 404);
    if (base.estado !== 'listo') return json({ ok: false, error: 'Esa versión todavía no está lista.' }, 409);
    const { data: nueva, error } = await supabase.from('resumenes_ia').insert({
      grabacion_id: grabacionId,
      patient_id: g.patient_id,
      booking_id: g.booking_id,
      transcripcion_id: base.transcripcion_id,
      version: siguiente,
      autor: 'vale',
      basado_en: base.id,
      plantilla: base.plantilla,
      rotulo: ROTULO_EDITADO,
      instrucciones_id: base.instrucciones_id,
      prompt_version: base.prompt_version,
      modelo: base.modelo,
      modo: base.modo,
      estado: 'listo',
      contenido,
      listo_at: new Date().toISOString(),
    }).select('id, version').single();
    if (error || !nueva) {
      await auditar('vale', 'editar_resumen', { grabacionId, patientId: g.patient_id, request, clientAddress, resultado: 'error', detalle: { codigo: error?.code ?? null } });
      return json({ ok: false, error: error?.code === '23505' ? 'Alguien guardó otra versión recién. Recarga la página.' : 'No se pudo guardar el resumen editado. Intenta de nuevo.' }, error?.code === '23505' ? 409 : 500);
    }
    await auditar('vale', 'editar_resumen', {
      grabacionId, patientId: g.patient_id, request, clientAddress,
      detalle: { version: nueva.version, basado_en_version: base.version, largo: contenido.length },
    });
    return json({ ok: true, id: nueva.id, version: nueva.version });
  }

  // ── Regenerar: nueva versión de la IA (la escribe el orquestador) ──────────
  if (body.accion !== 'regenerar') return json({ ok: false, error: 'Acción no válida.' }, 400);
  if ((versiones ?? []).some((v) => v.estado === 'pendiente' || v.estado === 'en_batch')) {
    return json({ ok: false, error: 'Ya se está escribiendo un resumen nuevo para esta sesión.' }, 409);
  }
  if (g.estado !== 'lista') return json({ ok: false, error: 'Solo se puede regenerar cuando la sesión está lista.' }, 409);
  const { data: tr } = await supabase.from('transcripciones').select('id').eq('grabacion_id', grabacionId).is('deleted_at', null).maybeSingle();
  if (!tr) return json({ ok: false, error: 'Esta sesión no tiene transcripción guardada.' }, 409);

  const [{ data: ajusteModo }, instr] = await Promise.all([
    supabase.from('settings').select('value').eq('key', AJUSTES.resumenModo).maybeSingle(),
    cargarInstrucciones('resumen').catch(() => ({ id: null as string | null, texto: '' })),
  ]);
  const modo = ajusteModo?.value === 'batch' ? 'batch' : 'directo';

  let movida;
  try {
    movida = await transicionar(grabacionId, ['lista'], 'resumiendo');
  } catch (e) {
    console.warn('[transcriptor/regenerar-resumen]', e instanceof Error ? e.message : e);
    return json({ ok: false, error: 'No se pudo pedir el resumen nuevo. Intenta de nuevo.' }, 500);
  }
  if (!movida) return json({ ok: false, error: 'La sesión cambió de estado recién. Recarga la página.' }, 409);

  const { data: nueva, error: ei } = await supabase.from('resumenes_ia').insert({
    grabacion_id: grabacionId,
    patient_id: g.patient_id,
    booking_id: g.booking_id,
    transcripcion_id: tr.id,
    version: siguiente,
    autor: 'ia',
    plantilla: plantillaDesdeTipo(g.tipo as TipoSesion),
    instrucciones_id: instr.id,
    modo,
    estado: 'pendiente',
  }).select('id, version').single();
  if (ei || !nueva) {
    // Se devuelve la grabación a 'lista' para no dejarla "escribiendo" sin resumen pedido.
    await transicionar(grabacionId, ['resumiendo'], 'lista').catch(() => null);
    await auditar('vale', 'regenerar_resumen', { grabacionId, patientId: g.patient_id, request, clientAddress, resultado: 'error', detalle: { codigo: ei?.code ?? null } });
    return json({ ok: false, error: 'No se pudo pedir el resumen nuevo. Intenta de nuevo.' }, 500);
  }
  await auditar('vale', 'regenerar_resumen', {
    grabacionId, patientId: g.patient_id, request, clientAddress,
    detalle: { version: nueva.version, modo },
  });
  return json({ ok: true, id: nueva.id, version: nueva.version });
};
