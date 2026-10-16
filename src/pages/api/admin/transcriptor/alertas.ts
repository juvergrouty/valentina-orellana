// POST /api/admin/transcriptor/alertas — botones del aviso rojo del transcriptor (paquete P8).
// Cuerpo JSON: { id: <uuid de la alerta>, accion: 'reintentar' | 'reintentar_resumen' | 'resolver' }.
// Protección: middleware (cookie del panel) + guardiaPanel (POST, Origin/Referer propio obligatorio,
// cabecera X-Panel: 1, sesión válida y no revocada). Todo queda en transcriptor_auditoria.
// "Reintentar" no ejecuta el paso: deja la grabación en el estado correcto (estados.ts) y el cron
// la retoma en el próximo minuto (src/lib/transcriptor/reintentoAlerta.ts).
import type { APIRoute } from 'astro';
import { guardiaPanel, json, leerJson, esUuid, safeAddr } from '../../../../lib/transcriptor/peticion';
import { auditar } from '../../../../lib/transcriptor/auditoria';
import { obtenerAlerta, resolverAlerta } from '../../../../lib/transcriptor/alertas';
import { ejecutarReintento, opsReintentoSupabase, type AccionReintento } from '../../../../lib/transcriptor/reintentoAlerta';

export const prerender = false;

const ACCIONES = ['reintentar', 'reintentar_resumen', 'resolver'] as const;
type Accion = (typeof ACCIONES)[number];

export const POST: APIRoute = async (ctx) => {
  const cuerpo = await leerJson(ctx.request);
  const accion = cuerpo?.accion as Accion | undefined;
  const esResolver = accion === 'resolver';
  const rechazo = await guardiaPanel(ctx, esResolver ? 'alerta' : 'reintentar');
  if (rechazo) return rechazo;

  const id = cuerpo?.id;
  if (!esUuid(id) || !accion || !ACCIONES.includes(accion)) {
    return json({ ok: false, error: 'Pedido inválido.' }, 400);
  }
  const base = { request: ctx.request, clientAddress: safeAddr(ctx) };

  try {
    const alerta = await obtenerAlerta(id);
    if (!alerta) return json({ ok: false, error: 'Ese aviso ya no existe. Recarga la página.' }, 404);
    if (alerta.resuelta_at) return json({ ok: true, mensaje: 'Ese aviso ya estaba resuelto.' });

    if (esResolver) {
      await resolverAlerta(id, 'vale');
      await auditar('vale', 'alerta', { ...base, grabacionId: alerta.grabacion_id, detalle: { op: 'resolver', tipo: alerta.tipo, clave_alerta: alerta.clave } });
      return json({ ok: true, mensaje: 'Marcado como resuelto.' });
    }

    if (!alerta.grabacion_id) {
      return json({ ok: false, error: 'Este aviso no es de una sesión: revisa el detalle y márcalo como resuelto cuando esté arreglado.' }, 409);
    }
    const r = await ejecutarReintento(alerta.grabacion_id, accion as AccionReintento, await opsReintentoSupabase());
    await auditar('vale', 'reintentar', {
      ...base,
      grabacionId: alerta.grabacion_id,
      resultado: r.ok ? 'ok' : 'error',
      detalle: { origen: 'alerta', accion, tipo: alerta.tipo, desde: r.desde ?? null, hacia: r.hacia ?? null },
    });
    if (r.resolver) await resolverAlerta(id, 'vale');
    return r.ok ? json({ ok: true, mensaje: r.mensaje }) : json({ ok: false, error: r.mensaje }, 409);
  } catch (e) {
    console.error('[api/admin/transcriptor/alertas]', e instanceof Error ? e.message : e);
    await auditar('vale', esResolver ? 'alerta' : 'reintentar', { ...base, resultado: 'error', detalle: { accion, error: e instanceof Error ? e.message : 'desconocido' } });
    return json({ ok: false, error: 'No se pudo completar. Intenta de nuevo en un momento.' }, 500);
  }
};
