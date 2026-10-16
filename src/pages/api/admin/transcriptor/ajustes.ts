// POST /api/admin/transcriptor/ajustes — P7 (50-arquitectura §3.8).
// Cambia SOLO estos ajustes de settings: transcriptor_activo, transcriptor_bot_activo,
// transcriptor_bot_nombres_vale (clave de P5) y transcriptor_bot_modo ('invitado' | 'cuenta';
// 'cuenta' solo si la cuenta del robot ya tiene una sesión guardada — 85-robot-meet). Los demás (requisito de grabación, modo del
// resumen, alerta de riesgo, presupuesto) los fijan las decisiones de Vale y no se editan aquí.
// Cuerpo: { clave, valor }. Auth del panel + Origin/Referer propio + X-Panel + bitácora.
// Encender transcriptor/bot exige passkey obligatoria (decisión 3; panel.ts motivoBloqueoActivacion).
import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { auditar } from '../../../../lib/transcriptor/auditoria';
import {
  AJUSTE_BOT_MODO, estadoSesionRobot, exigePasskeyObligatoria, motivoBloqueoActivacion, validarAjuste, validarModoBot,
  type EstadoPasskeyActivacion, type EstadoSesionRobot,
} from '../../../../lib/transcriptor/panel';
import { CLAVE_ROBOT_SESION } from '../../../../lib/transcriptor/avisosRobot';
import { resolverAlertasPorPrefijo } from '../../../../lib/transcriptor/alertas';
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
  let clave: string;
  let valor: string;
  if (body.clave === AJUSTE_BOT_MODO) {
    // Modo del robot: 'cuenta' exige que la cuenta ya exista (columnas no secretas; nunca sesion_cifrada).
    const { data: fila, error: es } = await supabase.from('transcriptor_bot_sesion').select('cuenta_email, estado').eq('id', 1).maybeSingle();
    const sinTabla = !!es && ['42P01', 'PGRST205', 'PGRST204'].includes(String(es.code ?? ''));
    const sesion: EstadoSesionRobot | 'error' = es ? (sinTabla ? 'sin_sesion' : 'error') : estadoSesionRobot(fila);
    const m = validarModoBot(body.valor, sesion);
    if (!m.ok) return json({ ok: false, error: m.error }, m.error === 'Valor no válido.' ? 400 : 409);
    clave = AJUSTE_BOT_MODO;
    valor = m.valor;
  } else {
    const v = validarAjuste(body.clave, body.valor);
    if (!v.ok) return json({ ok: false, error: v.error }, 400);
    ({ clave, valor } = v.valor);
  }

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
  // En modo invitado la sesión del robot ya no hace falta: su aviso queda arreglado.
  if (clave === AJUSTE_BOT_MODO && valor === 'invitado') await resolverAlertasPorPrefijo(CLAVE_ROBOT_SESION, []);
  return json({ ok: true, valor });
};
