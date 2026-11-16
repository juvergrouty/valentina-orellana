import type { APIRoute } from 'astro';
import { logWarn } from '../../../lib/logger';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

// POST /api/bookings/fallo — la agenda avisa cuando una reserva falla en el
// navegador ANTES de llegar al servidor (sin conexión, reCAPTCHA bloqueado o
// lento, error de la página). Sin esto esos intentos no dejaban rastro
// (16 nov 2026: dos intentos fallidos de un paciente). Solo guarda el motivo
// técnico y el horario elegido, nunca datos personales.
const corto = (v: unknown, n: number) => String(v ?? '').replace(/[<>]/g, '').slice(0, n);

export const POST: APIRoute = async ({ request }) => {
  try {
    // Solo desde el propio sitio, y con tope para que nadie llene los logs.
    const origen = request.headers.get('origin');
    if (origen && !/^https:\/\/(www\.)?valentinaorellana\.cl$/.test(origen) && !/^http:\/\/localhost(:\d+)?$/.test(origen)) return new Response(null, { status: 204 });
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'desconocida';
    const desde = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const base = () => supabase.from('admin_logs').select('id', { count: 'exact', head: true }).eq('context', 'bookings/fallo-navegador').gt('created_at', desde);
    const [{ count: deEsaIp }, { count: total }] = await Promise.all([base().eq('data->>ip', ip), base()]);
    if ((deEsaIp ?? 0) >= 10 || (total ?? 0) >= 200) return new Response(null, { status: 204 });
    const raw = await request.text();
    if (raw.length > 4000) return new Response(null, { status: 204 });
    const b = JSON.parse(raw || '{}') as Record<string, unknown>;
    await logWarn('bookings/fallo-navegador', `La reserva falló en el navegador: ${corto(b.etapa, 40)} — ${corto(b.mensaje, 300)}`, {
      etapa: corto(b.etapa, 40),
      mensaje: corto(b.mensaje, 300),
      fecha: corto(b.fecha, 10),
      hora: corto(b.hora, 5),
      servicio: corto(b.servicio, 36),
      navegador: corto(request.headers.get('user-agent'), 200),
      ip,
    });
  } catch { /* nunca falla hacia la paciente */ }
  return new Response(null, { status: 204 });
};
