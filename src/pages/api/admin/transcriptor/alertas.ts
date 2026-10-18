// /api/admin/transcriptor/alertas — acciones que reparan los avisos del transcriptor (decisión A,
// 02-decisiones-16oct-noche.md; tabla en docs/transcriptor/84-avisos-acciones.md).
//
// POST { id: <uuid del aviso>, accion: AccionAviso } — ejecuta la acción (Reintentar, Reintentar
//   resumen, Rehacer copia en B2, Borrar en AssemblyAI, Lanzar respaldo ahora, Volver a revisar…).
//   Lo usan el aviso rojo del panel y la página /admin/transcriptor/accion (enlaces del correo).
//   Protección: middleware (cookie del panel + passkey si aplica, estricto en esta ruta) +
//   guardiaPanel (POST, Origin/Referer propio obligatorio, cabecera X-Panel: 1, sesión no
//   revocada). Todo queda en transcriptor_auditoria. NO existe "resolver": el aviso se cierra solo
//   cuando el problema está arreglado.
// GET ?id=<uuid> — ¿sigue abierto? (el aviso lo consulta tras Reintentar). SOLO LEE (ronda 2, 18 oct): si su
//   paso ya salió bien responde `superada: true` y es el aviso el que lo cierra con un POST explícito
//   (accion 'revisar', que audita y cierra). Este GET no cambia el estado. (Al renderizar el panel,
//   listarAlertasAbiertas aún cierra los avisos cuyo paso ya salió bien: cierre automático de lectura.)
import type { APIRoute } from 'astro';
import { guardiaPanel, json, leerJson, esUuid, safeAddr } from '../../../../lib/transcriptor/peticion';
import { auditar } from '../../../../lib/transcriptor/auditoria';
import { ejecutarAccionAviso, esAccionAviso, opsAccionesReales, alertaSuperada, claseDe, esDeGrabacion } from '../../../../lib/transcriptor/accionesAlerta';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const cuerpo = await leerJson(ctx.request);
  const accion = cuerpo?.accion;
  const rechazo = await guardiaPanel(ctx, accion === 'reintentar' || accion === 'reintentar_resumen' ? 'reintentar' : 'alerta');
  if (rechazo) return rechazo;

  const id = cuerpo?.id;
  if (!esUuid(id) || !esAccionAviso(accion)) return json({ ok: false, error: 'Pedido inválido.' }, 400);
  const base = { request: ctx.request, clientAddress: safeAddr(ctx) };
  const accionBitacora = accion === 'reintentar' || accion === 'reintentar_resumen' ? 'reintentar' as const : 'alerta' as const;

  try {
    const ops = await opsAccionesReales();
    const alerta = await ops.obtenerAlerta(id);
    if (!alerta) return json({ ok: false, error: 'Ese aviso ya no existe. Recarga la página.' }, 404);
    const r = await ejecutarAccionAviso(id, accion, ops);
    await auditar('vale', accionBitacora, {
      ...base,
      grabacionId: alerta.grabacion_id,
      resultado: r.ok ? 'ok' : 'error',
      detalle: { origen: 'alerta', op: accion, tipo: alerta.tipo, clave_alerta: alerta.clave, cerrada: r.cerrada, ...(r.detalle ?? {}) },
    });
    return r.ok
      ? json({ ok: true, cerrada: r.cerrada, mensaje: r.mensaje })
      : json({ ok: false, cerrada: r.cerrada, error: r.mensaje }, 409);
  } catch (e) {
    console.error('[api/admin/transcriptor/alertas]', e instanceof Error ? e.message : e);
    await auditar('vale', accionBitacora, { ...base, resultado: 'error', detalle: { op: accion, error: e instanceof Error ? e.message.slice(0, 200) : 'desconocido' } });
    return json({ ok: false, error: 'No se pudo completar. Intenta de nuevo en un momento.' }, 500);
  }
};

export const GET: APIRoute = async ({ url }) => {
  const id = url.searchParams.get('id');
  if (!esUuid(id)) return json({ ok: false, error: 'Pedido inválido.' }, 400);
  try {
    const ops = await opsAccionesReales();
    const a = await ops.obtenerAlerta(id);
    if (!a) return json({ ok: true, abierta: false });
    if (a.resuelta_at) return json({ ok: true, abierta: false });
    const superada = !!a.grabacion_id && esDeGrabacion(claseDe(a)) && alertaSuperada(a, await ops.leerSesion(a.grabacion_id));
    return json({ ok: true, abierta: true, superada });
  } catch (e) {
    console.error('[api/admin/transcriptor/alertas GET]', e instanceof Error ? e.message : e);
    return json({ ok: false, error: 'No se pudo revisar.' }, 500);
  }
};
