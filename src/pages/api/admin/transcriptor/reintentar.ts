// POST /api/admin/transcriptor/reintentar — P7 (50-arquitectura §3.8 y §4).
// "Reintentar" desde el panel: vuelve la grabación de 'error' a estado_antes_error (transición
// atómica de estados.ts; si otro proceso ya la movió, no hace nada). Si falló el resumen, el
// último resumen de la IA en 'error' vuelve a 'pendiente' para que el orquestador (P6) lo tome.
// Cuerpo: { grabacion_id: uuid }. Auth del panel + Origin/Referer propio + X-Panel + bitácora.
import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { auditar } from '../../../../lib/transcriptor/auditoria';
import { reintentar } from '../../../../lib/transcriptor/estados';
import { esUuid, guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';
import type { Grabacion } from '../../../../lib/transcriptor/tipos';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const rechazo = await guardiaPanel(ctx, 'reintentar');
  if (rechazo) return rechazo;
  const { request } = ctx;
  const clientAddress = safeAddr(ctx);
  const body = await leerJson(request);
  const grabacionId = body?.grabacion_id;
  if (!esUuid(grabacionId)) return json({ ok: false, error: 'Falta la grabación.' }, 400);

  const { data: antes, error: e0 } = await supabase.from('grabaciones')
    .select('id, patient_id, estado').eq('id', grabacionId).maybeSingle();
  if (e0) return json({ ok: false, error: 'No se pudo leer la grabación. Intenta de nuevo.' }, 500);
  if (!antes) return json({ ok: false, error: 'No se encontró la grabación.' }, 404);
  if (antes.estado !== 'error') return json({ ok: true, sin_cambios: true, estado: antes.estado });

  let g: Grabacion | null;
  try {
    g = await reintentar(grabacionId);
  } catch (e) {
    console.warn('[transcriptor/reintentar]', e instanceof Error ? e.message : e);
    await auditar('vale', 'reintentar', { grabacionId, patientId: antes.patient_id, request, clientAddress, resultado: 'error' });
    return json({ ok: false, error: 'No se pudo reintentar. Intenta de nuevo en un minuto.' }, 500);
  }
  if (!g) return json({ ok: false, error: 'Esta grabación no se puede reintentar desde aquí.' }, 409);

  let resumenReactivado = false;
  if (g.estado === 'transcrita' || g.estado === 'resumiendo') {
    const { data: r } = await supabase.from('resumenes_ia').select('id, estado')
      .eq('grabacion_id', grabacionId).eq('autor', 'ia').order('version', { ascending: false }).limit(1).maybeSingle();
    if (r?.estado === 'error') {
      const { error } = await supabase.from('resumenes_ia').update({ estado: 'pendiente' }).eq('id', r.id).eq('estado', 'error');
      resumenReactivado = !error;
    }
  }
  await auditar('vale', 'reintentar', {
    grabacionId, patientId: g.patient_id, request, clientAddress,
    detalle: { hacia: g.estado, resumen_reactivado: resumenReactivado },
  });
  return json({ ok: true, estado: g.estado });
};
