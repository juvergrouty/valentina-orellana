// POST /api/admin/transcriptor/llamar-asistente — Vale abre una sesión online desde el panel (decisión de
// Vale, 18 oct 2026: "el robot entra solo cuando entro yo"). Lo llaman los botones que abren el Meet
// (agenda, sala online, calendario) y "Llamar al asistente ahora". Cuerpo: { reserva: uuid }.
// Auth del panel + Origin/Referer propio + X-Panel (guardiaPanel). Reglas y despacho en
// enlaceSesionRuta.llamarAsistentePanel (las mismas del enlace /sesion/<código>). La respuesta no trae
// datos del paciente.
import type { APIRoute } from 'astro';
import { esUuid, guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';
import { ACCION_ENLACE, llamarAsistentePanel } from '../../../../lib/transcriptor/enlaceSesionRuta';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const rechazo = await guardiaPanel(ctx, ACCION_ENLACE);
  if (rechazo) return rechazo;
  const body = await leerJson(ctx.request);
  const reserva = body?.reserva;
  if (!esUuid(reserva)) return json({ ok: false, error: 'Falta la reserva.' }, 400);
  const r = await llamarAsistentePanel(reserva, { request: ctx.request, clientAddress: safeAddr(ctx) });
  return json({ ok: r.status === 200, despacho: r.despacho, texto: r.texto }, r.status);
};
