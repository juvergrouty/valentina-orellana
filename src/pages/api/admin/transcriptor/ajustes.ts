// POST /api/admin/transcriptor/ajustes — P7 (50-arquitectura §3.8).
// Cambia SOLO estos ajustes de settings: transcriptor_activo, transcriptor_bot_activo y
// transcriptor_bot_nombres_vale (clave de P5). Los demás (requisito de grabación, modo del
// resumen, alerta de riesgo, presupuesto) los fijan las decisiones de Vale y no se editan aquí.
// Cuerpo: { clave, valor }. Auth del panel + Origin/Referer propio + X-Panel + bitácora.
import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { auditar } from '../../../../lib/transcriptor/auditoria';
import { validarAjuste } from '../../../../lib/transcriptor/panel';
import { guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const rechazo = await guardiaPanel(ctx, 'cambiar_ajuste');
  if (rechazo) return rechazo;
  const { request } = ctx;
  const clientAddress = safeAddr(ctx);
  const body = await leerJson(request);
  if (!body) return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  const v = validarAjuste(body.clave, body.valor);
  if (!v.ok) return json({ ok: false, error: v.error }, 400);
  const { clave, valor } = v.valor;

  const { data: actual, error: e0 } = await supabase.from('settings').select('key, value').eq('key', clave).maybeSingle();
  if (e0) return json({ ok: false, error: 'No se pudo leer el ajuste. Intenta de nuevo.' }, 500);
  if (actual?.value === valor) return json({ ok: true, sin_cambios: true, valor });

  // Mismo patrón que /api/admin/settings: update si existe, insert si no.
  const { error } = actual
    ? await supabase.from('settings').update({ value: valor, updated_at: new Date().toISOString() }).eq('key', clave)
    : await supabase.from('settings').insert({ key: clave, value: valor });
  if (error) {
    await auditar('vale', 'cambiar_ajuste', { request, clientAddress, resultado: 'error', detalle: { clave, codigo: error.code ?? null } });
    return json({ ok: false, error: 'No se pudo guardar el ajuste. Intenta de nuevo.' }, 500);
  }
  await auditar('vale', 'cambiar_ajuste', {
    request, clientAddress,
    detalle: { clave, anterior: actual?.value ?? null, nuevo: valor },
  });
  return json({ ok: true, valor });
};
