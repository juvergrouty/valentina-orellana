// POST /api/admin/transcriptor/suprimir — pedidos del paciente sobre UNA sesión grabada.
//   { accion: 'suprimir_transcripcion', grabacion_id, patient_id, motivo, canal, confirmacion: 'BORRAR' }
//       → borra la transcripción en R2 y todas sus versiones en B2, dek_envuelta = null, deleted_at,
//         motivo y canal; bitácora obligatoria antes de borrar (80-revision-seguridad M3).
//   { accion: 'excluir_ia', grabacion_id, patient_id, motivo, canal }
//       → la sesión deja de usarse en las preguntas a la IA y como contexto de resúmenes (81 H5).
// Lógica en src/lib/transcriptor/supresion.ts (con pruebas). Auth del panel + Origin/Referer propio
// + X-Panel (guardiaPanel). La confirmación es escrita en la página (sin confirm()).
import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { esUuid, guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';
import { excluirDeIA, suprimirTranscripcion } from '../../../../lib/transcriptor/supresion';
import type { AccionAuditoria } from '../../../../lib/transcriptor/tipos';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const rechazo = await guardiaPanel(ctx, 'borrar_transcripcion' as AccionAuditoria);
  if (rechazo) return rechazo;
  const body = await leerJson(ctx.request);
  if (!body || !esUuid(body.grabacion_id) || !esUuid(body.patient_id)) return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  const deps = {
    db: supabase,
    almacenamiento: { borrarTranscripcion: async (key: string) => (await import('../../../../lib/transcriptor/almacenamiento')).almacenamiento.borrarTranscripcion(key) },
    request: ctx.request,
    clientAddress: safeAddr(ctx),
  };
  const pedido = { motivo: body.motivo, canal: body.canal, confirmacion: body.confirmacion };
  try {
    const r = body.accion === 'suprimir_transcripcion'
      ? await suprimirTranscripcion(body.grabacion_id, body.patient_id, pedido, deps)
      : body.accion === 'excluir_ia'
        ? await excluirDeIA(body.grabacion_id, body.patient_id, pedido, deps)
        : { ok: false as const, status: 400, error: 'Acción no válida.' };
    return r.ok ? json({ ok: true, mensaje: r.mensaje }) : json({ ok: false, error: r.error }, r.status);
  } catch (e) {
    console.warn('[transcriptor/suprimir]', e instanceof Error ? e.name : 'error');
    return json({ ok: false, error: 'No se pudo completar. Intenta de nuevo en un momento.' }, 500);
  }
};
