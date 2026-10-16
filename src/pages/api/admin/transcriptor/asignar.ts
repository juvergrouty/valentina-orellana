// POST /api/admin/transcriptor/asignar — P7 (50-arquitectura §3.8).
// Asigna (o corrige) la ficha de una grabación "sin asignar". Mueve también el patient_id de sus
// resúmenes (metadato permitido por el trigger de 0014: el contenido nunca se toca).
// Cuerpo: { grabacion_id: uuid, patient_id: uuid }. Auth del panel + Origin/Referer propio +
// X-Panel (guardiaPanel). Queda en la bitácora con la ficha anterior y la nueva.
// H3/B5 (81 y 80-revision): ANTES de mover se verifica el consentimiento de grabación de la ficha
// DESTINO (mismo chequeo que al grabar, con pareja deducida en el servidor). Si no puede, 403 y no
// se toca nada. Si puede, se guardan los consent_ids de esa ficha (trazabilidad grabación ↔ firma).
import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { auditar } from '../../../../lib/transcriptor/auditoria';
import { verificarGrabacion } from '../../../../lib/transcriptor/consentimiento';
import type { TipoSesion } from '../../../../lib/transcriptor/tipos';
import { esUuid, guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const rechazo = await guardiaPanel(ctx, 'asignar_paciente');
  if (rechazo) return rechazo;
  const { request } = ctx;
  const clientAddress = safeAddr(ctx);
  const body = await leerJson(request);
  const grabacionId = body?.grabacion_id;
  const patientId = body?.patient_id;
  if (!esUuid(grabacionId) || !esUuid(patientId)) return json({ ok: false, error: 'Faltan la grabación o la ficha.' }, 400);

  const [{ data: g, error: eg }, { data: p, error: ep }] = await Promise.all([
    supabase.from('grabaciones').select('id, patient_id, tipo').eq('id', grabacionId).maybeSingle(),
    supabase.from('patients').select('id').eq('id', patientId).maybeSingle(),
  ]);
  if (eg || ep) return json({ ok: false, error: 'No se pudo leer la grabación. Intenta de nuevo.' }, 500);
  if (!g) return json({ ok: false, error: 'No se encontró la grabación.' }, 404);
  if (!p) return json({ ok: false, error: 'No se encontró la ficha.' }, 404);
  if (g.patient_id === patientId) return json({ ok: true, sin_cambios: true });

  let v: Awaited<ReturnType<typeof verificarGrabacion>>;
  try {
    v = await verificarGrabacion(patientId, (g.tipo ?? 'sin_tipo') as TipoSesion);
  } catch {
    return json({ ok: false, error: 'No se pudo revisar el consentimiento de esa ficha. Intenta de nuevo.' }, 503);
  }
  if (!v.puede && v.motivo !== 'transcriptor_apagado') {
    await auditar('vale', 'asignar_paciente', {
      grabacionId, patientId, request, clientAddress, resultado: 'denegado',
      detalle: { anterior: g.patient_id ?? null, motivo: v.motivo ?? null },
    });
    return json({ ok: false, motivo: v.motivo, error: 'La ficha elegida no tiene consentimiento de grabación vigente. No se puede asignar esta grabación.' }, 403);
  }
  if (v.motivo === 'transcriptor_apagado') {
    return json({ ok: false, error: 'El transcriptor está apagado: enciéndelo para poder revisar el consentimiento y asignar.' }, 409);
  }

  const { error: eu } = await supabase.from('grabaciones')
    .update({ patient_id: patientId, consent_ids: v.consentIds })
    .eq('id', grabacionId);
  if (eu) {
    await auditar('vale', 'asignar_paciente', { grabacionId, patientId, request, clientAddress, resultado: 'error', detalle: { codigo: eu.code ?? null } });
    return json({ ok: false, error: 'No se pudo asignar la ficha. Intenta de nuevo.' }, 500);
  }
  const { error: er } = await supabase.from('resumenes_ia').update({ patient_id: patientId }).eq('grabacion_id', grabacionId);
  if (er) console.warn('[transcriptor/asignar] no se pudo mover el paciente de los resúmenes:', er.code);
  await auditar('vale', 'asignar_paciente', {
    grabacionId, patientId, request, clientAddress,
    detalle: { anterior: g.patient_id ?? null, resumenes_actualizados: !er, firmas: v.consentIds.length },
  });
  return json({ ok: true });
};
