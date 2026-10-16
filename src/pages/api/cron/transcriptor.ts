import type { APIRoute } from 'astro';
import { cronAutorizado } from '../../../lib/cronAuth';

export const prerender = false;

// Orquestador del transcriptor IA (paquete P6). Lo llama Supabase cada minuto (pg_cron + pg_net,
// job 'transcriptor-cada-1-min', con la clave interna settings.cron_interno_secret, igual que el job
// 'tareas-cada-5-min'; SQL en docs/transcriptor/70-cron.md). También acepta CRON_SECRET (respaldo manual).
// Trabaja como máximo ~50 s (maxDuration de Vercel = 300 s con Fluid compute; el resumen tiene su propio tope de ~240 s) y deja lo pendiente para el minuto
// siguiente; dos llamadas solapadas no repiten trabajo (toma atómica por grabación).
// La respuesta solo trae conteos (sin datos de pacientes).

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export const GET: APIRoute = async ({ request }) => {
  // Falla cerrado: CRON_SECRET o la clave interna de Supabase (ver cronAuth.ts).
  if (!(await cronAutorizado(request))) return new Response('Unauthorized', { status: 401 });
  try {
    const { crearPipeline, depsProduccion } = await import('../../../lib/transcriptor/pipeline');
    const resultado = await crearPipeline(await depsProduccion()).correr(new Date());
    return json(resultado, resultado.ok ? 200 : 207);
  } catch (e) {
    console.warn('[cron/transcriptor]', e instanceof Error ? e.message : e);
    return json({ ok: false, error: 'El orquestador del transcriptor falló; se reintenta en el próximo minuto.' }, 500);
  }
};

export const POST = GET;
