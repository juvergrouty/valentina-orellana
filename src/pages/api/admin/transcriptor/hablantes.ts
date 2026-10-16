// POST /api/admin/transcriptor/hablantes — P7 (50-arquitectura §3.8).
// Renombra hablantes de una transcripción ("Hablante A" → "Ps. Valentina"). Guarda en
// grabaciones.mapa_hablantes con las claves de hablantes.ts (P2): 'A', '2-A' o el nombre de
// Meet. No descifra ni toca la transcripción: el nombre se aplica al mostrarla.
// Cuerpo: { grabacion_id: uuid, cambios: { [clave]: nombre } } (nombre vacío = volver al original).
// Auth del panel + Origin/Referer propio + X-Panel. La bitácora guarda solo cuántos (los nombres
// pueden ser de pacientes).
import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { auditar } from '../../../../lib/transcriptor/auditoria';
import { fusionarMapaHablantes } from '../../../../lib/transcriptor/panel';
import { exigirAccesoClinico } from '../../../../lib/transcriptor/acceso';
import { esUuid, guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  // Además de la guardia: sesión confirmada con passkey (acceso.ts; revisión de seguridad 16 oct, A1).
  const rechazo = (await guardiaPanel(ctx, 'renombrar_hablantes')) ?? (await exigirAccesoClinico(ctx, 'renombrar_hablantes'));
  if (rechazo) return rechazo;
  const { request } = ctx;
  const clientAddress = safeAddr(ctx);
  const body = await leerJson(request);
  const grabacionId = body?.grabacion_id;
  if (!esUuid(grabacionId)) return json({ ok: false, error: 'Falta la grabación.' }, 400);

  const { data: g, error: eg } = await supabase.from('grabaciones')
    .select('id, patient_id, mapa_hablantes').eq('id', grabacionId).maybeSingle();
  if (eg) return json({ ok: false, error: 'No se pudo leer la grabación. Intenta de nuevo.' }, 500);
  if (!g) return json({ ok: false, error: 'No se encontró la grabación.' }, 404);

  const r = fusionarMapaHablantes(g.mapa_hablantes as Record<string, string> | null, body?.cambios);
  if (!r.ok) return json({ ok: false, error: r.error }, 400);
  const mapa = Object.keys(r.valor).length ? r.valor : null;

  const { error } = await supabase.from('grabaciones').update({ mapa_hablantes: mapa }).eq('id', grabacionId);
  if (error) {
    await auditar('vale', 'renombrar_hablantes', { grabacionId, patientId: g.patient_id, request, clientAddress, resultado: 'error', detalle: { codigo: error.code ?? null } });
    return json({ ok: false, error: 'No se pudieron guardar los nombres. Intenta de nuevo.' }, 500);
  }
  await auditar('vale', 'renombrar_hablantes', {
    grabacionId, patientId: g.patient_id, request, clientAddress,
    detalle: { cambios: Object.keys(body?.cambios as object).length, total: Object.keys(r.valor).length },
  });
  return json({ ok: true });
};
