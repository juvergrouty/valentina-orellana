// POST /api/admin/transcriptor/excluir-ia — el paciente pidió que UNA sesión no se use en las preguntas
// a la IA (81-revision-etica-clinica H5; se mantiene en 02-decisiones-16oct-noche, C).
//   { grabacion_id, patient_id, motivo, canal } → grabaciones.excluir_ia_at + motivo. No borra nada.
// Reemplaza a /api/admin/transcriptor/suprimir: la supresión de transcripciones se eliminó (la ficha
// se conserva 15 años). Lógica en src/lib/transcriptor/excluirIA.ts (con pruebas).
// Auth del panel + Origin/Referer propio + X-Panel (guardiaPanel) + sesión con passkey (acceso.ts).
import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { esUuid, guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';
import { exigirAccesoClinico } from '../../../../lib/transcriptor/acceso';
import { ACC_EXCLUIR, excluirDeIA } from '../../../../lib/transcriptor/excluirIA';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const rechazo = (await guardiaPanel(ctx, ACC_EXCLUIR)) ?? (await exigirAccesoClinico(ctx, ACC_EXCLUIR));
  if (rechazo) return rechazo;
  const body = await leerJson(ctx.request);
  if (!body || !esUuid(body.grabacion_id) || !esUuid(body.patient_id)) return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  try {
    const r = await excluirDeIA(body.grabacion_id, body.patient_id, { motivo: body.motivo, canal: body.canal }, {
      db: supabase, request: ctx.request, clientAddress: safeAddr(ctx),
    });
    return r.ok ? json({ ok: true, mensaje: r.mensaje }) : json({ ok: false, error: r.error }, r.status);
  } catch (e) {
    console.warn('[transcriptor/excluir-ia]', e instanceof Error ? e.name : 'error');
    return json({ ok: false, error: 'No se pudo completar. Intenta de nuevo en un momento.' }, 500);
  }
};
