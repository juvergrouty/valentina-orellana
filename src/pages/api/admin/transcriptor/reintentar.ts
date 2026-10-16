// POST /api/admin/transcriptor/reintentar — P7 (50-arquitectura §3.8 y §4).
// "Reintentar" desde la ficha y desde /admin/transcriptor. Usa EXACTAMENTE la misma lógica que el
// botón del aviso rojo (reintentoAlerta.ts, 82-revision-codigo M5): vuelve de 'error' a
// estado_antes_error con intentos y backoff reiniciados (estados.reintentar), relanza un bot caído
// antes de grabar, reabre el último resumen de la IA en 'error' (intentos 0) y no deja una sesión
// online quieta en 'grabando'. Si queda resuelto, cierra los avisos de esa grabación.
// Cuerpo: { grabacion_id: uuid }. Auth del panel + Origin/Referer propio + X-Panel + bitácora.
import type { APIRoute } from 'astro';
import { auditar } from '../../../../lib/transcriptor/auditoria';
import { resolverAlertasDe } from '../../../../lib/transcriptor/alertas';
import { ejecutarReintento, opsReintentoSupabase } from '../../../../lib/transcriptor/reintentoAlerta';
import { esUuid, guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const rechazo = await guardiaPanel(ctx, 'reintentar');
  if (rechazo) return rechazo;
  const { request } = ctx;
  const clientAddress = safeAddr(ctx);
  const body = await leerJson(request);
  const grabacionId = body?.grabacion_id;
  if (!esUuid(grabacionId)) return json({ ok: false, error: 'Falta la grabación.' }, 400);

  try {
    const r = await ejecutarReintento(grabacionId, 'reintentar', await opsReintentoSupabase());
    await auditar('vale', 'reintentar', {
      grabacionId, request, clientAddress, resultado: r.ok ? 'ok' : 'error',
      detalle: { origen: 'ficha', desde: r.desde ?? null, hacia: r.hacia ?? null },
    });
    if (r.ok && r.resolver) await resolverAlertasDe(grabacionId).catch(() => undefined);
    if (!r.ok) return json({ ok: false, error: r.mensaje }, r.mensaje === 'No se encontró la grabación.' ? 404 : 409);
    return json({ ok: true, estado: r.hacia ?? r.desde ?? null, mensaje: r.mensaje, sin_cambios: r.desde === r.hacia && r.desde !== 'error' });
  } catch (e) {
    console.warn('[transcriptor/reintentar]', e instanceof Error ? e.message : e);
    await auditar('vale', 'reintentar', { grabacionId, request, clientAddress, resultado: 'error', detalle: { origen: 'ficha' } });
    return json({ ok: false, error: 'No se pudo reintentar. Intenta de nuevo en un minuto.' }, 500);
  }
};
