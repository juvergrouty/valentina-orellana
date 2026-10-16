// POST /api/admin/transcriptor/ajustes — P7 (50-arquitectura §3.8).
// Cambia SOLO estos ajustes de settings: transcriptor_activo, transcriptor_bot_activo y
// transcriptor_bot_nombres_vale (clave de P5). Los demás (requisito de grabación, modo del
// resumen, alerta de riesgo, presupuesto) los fijan las decisiones de Vale y no se editan aquí.
// Cuerpo: { clave, valor }. Auth del panel + Origin/Referer propio + X-Panel + bitácora.
// Encender transcriptor/bot exige passkey obligatoria (decisión 3; panel.ts motivoBloqueoActivacion).
import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { auditar } from '../../../../lib/transcriptor/auditoria';
import { exigePasskeyObligatoria, motivoBloqueoActivacion, validarAjuste, type EstadoPasskeyActivacion } from '../../../../lib/transcriptor/panel';
import { COOKIE_ADMIN, nivelTokenAdmin } from '../../../../lib/adminSession';
import { estadoPasskeys, invalidarEstadoPasskeys } from '../../../../lib/passkey/servidor';
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

  // Decisión 3 (revisión de seguridad 16 oct, A1): encender el transcriptor o el bot exige
  // passkey registrada + "Passkey obligatoria" + esta sesión confirmada con passkey. Se lee el
  // estado sin caché; si no se puede leer, se rechaza (falla cerrado). Apagar siempre se permite.
  if (exigePasskeyObligatoria(clave, valor)) {
    let estado: EstadoPasskeyActivacion;
    try { invalidarEstadoPasskeys(); estado = await estadoPasskeys(); } catch { estado = 'error'; }
    const motivo = motivoBloqueoActivacion(estado, nivelTokenAdmin(ctx.cookies.get(COOKIE_ADMIN)?.value));
    if (motivo) {
      await auditar('vale', 'cambiar_ajuste', { request, clientAddress, resultado: 'denegado', detalle: { clave, motivo: 'passkey_no_obligatoria' } });
      return json({ ok: false, error: motivo, motivo: 'passkey' }, 409);
    }
  }

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
