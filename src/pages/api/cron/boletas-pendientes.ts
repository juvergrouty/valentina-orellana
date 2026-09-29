import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { enviarBoletaDeReserva, MARCA_PENDIENTE } from '../../../lib/apigateway';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Red de seguridad para que ninguna boleta emitida quede sin llegar al
// paciente: reintenta el envío de las reservas que enviarBoletaDeReserva dejó
// marcadas con `BoletaPendienteEnvio` (código SII que aún no aparecía, Resend
// caído, etc.). Solo toca reservas con esa marca — nunca reenvía boletas que
// ya salieron. Lo llama .github/workflows/frequent-cron.yml.
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  {
    const auth = request.headers.get('authorization');
    if (!secret || auth !== `Bearer ${secret}`) return new Response('Unauthorized', { status: 401 });
  }

  const { data: rows, error } = await supabase
    .from('bookings').select('id, notes').ilike('notes', `%${MARCA_PENDIENTE}%`).limit(20);
  if (error) return json({ ok: false, error: error.message }, 500);

  // Una marca de hace menos de 5 min puede ser una emisión que se está
  // enviando en este mismo momento — se deja para la próxima pasada.
  const marca = new RegExp(`${MARCA_PENDIENTE} (\\S+)`);
  const listas = (rows ?? []).filter(r => {
    const t = Date.parse(marca.exec(r.notes ?? '')?.[1] ?? '');
    return isNaN(t) || Date.now() - t > 5 * 60 * 1000;
  });

  const results: Array<{ id: string; sent: boolean; error?: string }> = [];
  for (const r of listas) {
    const res = await enviarBoletaDeReserva(r.id);
    results.push({ id: r.id, sent: res.sent, error: res.error });
  }
  return json({ ok: true, pending: results.length, sent: results.filter(r => r.sent).length, results });
};
