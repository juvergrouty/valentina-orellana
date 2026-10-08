import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

// GET /api/bookings/estado?id=<bookingId>
// Se consulta justo cuando la paciente aprieta "Pagar con Flow": confirma que
// su hora sigue apartada para ella antes de mandarla a pagar (Valentina, 8 oct
// 2026). Solo responde un estado, ningún dato personal.
// - ok: sigue apartada → puede pagar.
// - tomada: se liberó y otra persona tomó esa hora (o una que se cruza).
// - vencida: pasó el plazo para pagar (30 min) y la hora se liberó.
const PLAZO_MS = 30 * 60 * 1000;

export const GET: APIRoute = async ({ url }) => {
  const id = url.searchParams.get('id') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ estado: 'vencida' });

  const { data: b } = await supabase.from('bookings')
    .select('status, created_at, session_date, session_time, duration_min')
    .eq('id', id).maybeSingle();
  if (!b) return json({ estado: 'vencida' });
  if (b.status === 'confirmed') return json({ estado: 'ok' }); // ya pagada (otra pestaña)

  const vigente = b.status === 'pending_payment' && Date.now() - new Date(b.created_at).getTime() < PLAZO_MS;
  if (vigente) return json({ estado: 'ok' });

  // ¿La tomó otra persona? Otra reserva activa que se cruce con esa hora.
  const toMin = (t: string) => { const [h, m] = String(t).slice(0, 5).split(':').map(Number); return h * 60 + m; };
  const ini = toMin(b.session_time), fin = ini + (b.duration_min ?? 50);
  const { data: otras } = await supabase.from('bookings')
    .select('session_time, duration_min')
    .eq('session_date', b.session_date)
    .not('status', 'in', '(cancelled,expired)')
    .neq('id', id);
  const tomada = (otras ?? []).some((o: { session_time: string; duration_min: number | null }) => {
    const oi = toMin(o.session_time), of = oi + (o.duration_min ?? 50);
    return oi < fin && of > ini;
  });
  return json({ estado: tomada ? 'tomada' : 'vencida' });
};

function json(data: unknown) {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
