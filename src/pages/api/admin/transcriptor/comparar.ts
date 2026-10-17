// POST /api/admin/transcriptor/comparar — prueba ciega Sonnet 5.5 vs Haiku 5.5 del resumen.
//   { accion: 'crear' }                         → corrida nueva: casos reales (ficha de prueba) + 3 sintéticos,
//                                                 con el orden 1/2 sorteado por caso en el servidor.
//   { accion: 'generar', id }                   → los DOS resúmenes de UN caso (en paralelo). Caso por caso
//                                                 para no pasar del maxDuration (300 s) de Vercel.
//   { accion: 'votar', id, preferencia, comentario } → '1' | '2' | 'iguales'.
// La llave de Anthropic solo existe en Vercel: todo se genera aquí, en el servidor.
// Auth del panel + Origin/Referer propio + X-Panel + sesión con passkey + bitácora (sin contenido).
import type { APIRoute } from 'astro';
import { exigirAccesoClinico } from '../../../../lib/transcriptor/acceso';
import { ACCION_COMPARAR, esPreferencia } from '../../../../lib/transcriptor/comparacion';
import { ErrorComparacion, MAX_COMENTARIO, crearCorrida, generarCaso, votar } from '../../../../lib/transcriptor/comparacionDatos';
import { esUuid, guardiaPanel, json, leerJson, safeAddr } from '../../../../lib/transcriptor/peticion';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const rechazo = (await guardiaPanel(ctx, ACCION_COMPARAR)) ?? (await exigirAccesoClinico(ctx, ACCION_COMPARAR));
  if (rechazo) return rechazo;
  const body = await leerJson(ctx.request, 16 * 1024);
  if (!body) return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  const deps = { request: ctx.request, clientAddress: safeAddr(ctx) };
  try {
    if (body.accion === 'crear') {
      const r = await crearCorrida(deps);
      return json({ ok: true, corrida_id: r.corridaId, casos: r.casos.map((c) => c.id) });
    }
    if (body.accion === 'generar') {
      if (!esUuid(body.id)) return json({ ok: false, error: 'Falta el caso.' }, 400);
      const r = await generarCaso(body.id, deps);
      return json({ ok: r.estado === 'listo', estado: r.estado, ...(r.codigo ? { error: 'No se pudieron generar los dos resúmenes de este caso. Puedes reintentarlo.', codigo: r.codigo } : {}) });
    }
    if (body.accion === 'votar') {
      if (!esUuid(body.id)) return json({ ok: false, error: 'Falta el caso.' }, 400);
      if (!esPreferencia(body.preferencia)) return json({ ok: false, error: 'Elige 1, 2 o Iguales.' }, 400);
      const comentario = typeof body.comentario === 'string' ? body.comentario : '';
      if (comentario.length > MAX_COMENTARIO) return json({ ok: false, error: `El comentario puede tener hasta ${MAX_COMENTARIO.toLocaleString('es-CL')} caracteres.` }, 400);
      const r = await votar(body.id, body.preferencia, comentario, deps);
      return json({ ok: true, revelado: r.revelado });
    }
    return json({ ok: false, error: 'Acción no válida.' }, 400);
  } catch (e) {
    if (e instanceof ErrorComparacion) return json({ ok: false, error: e.message, codigo: e.codigo }, e.status);
    console.warn('[transcriptor/comparar]', e instanceof Error ? e.name : 'error');
    return json({ ok: false, error: 'No se pudo completar. Intenta de nuevo.' }, 500);
  }
};
