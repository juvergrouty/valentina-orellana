import type { APIRoute } from 'astro';
import { cronAutorizado } from '../../../lib/cronAuth';
import { ejecutarSeguimientos } from '../../../lib/seguimientos/motor';
import { logError } from '../../../lib/logger';

export const prerender = false;

// Seguimientos automáticos (aprobado por Vale el 18 nov 2026; ver src/lib/seguimientos/).
// Se llama cada 5 min desde Supabase (pg_cron + pg_net, ver supabase/migrations/0027 y cronAuth.ts).
// Idempotente: cada paso es una fila única que se toma antes de enviar, así que llamarlo muchas veces
// nunca repite un mensaje. Solo envía de lunes a sábado de 10:00 a 20:00 (hora de Chile) y con el
// interruptor de /admin/seguimientos encendido. Desde las 20:00 manda el resumen del día a Vale.
export const GET: APIRoute = async ({ request }) => {
  if (!(await cronAutorizado(request))) return new Response('Unauthorized', { status: 401 });
  try {
    const r = await ejecutarSeguimientos();
    return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    const motivo = e instanceof Error ? e.message : String(e);
    await logError('seguimientos/cron', 'Falló la tarea de seguimientos', { motivo });
    return new Response(JSON.stringify({ ok: false, error: motivo }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
