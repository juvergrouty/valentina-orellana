import type { APIRoute } from 'astro';
import { cronAutorizado } from '../../../lib/cronAuth';
import { supabase } from '../../../lib/supabase';
import { enviarBoletaDeReserva, emitBoletaParaReserva, folioVigente, MARCA_PENDIENTE, MARCA_PENDIENTE_EMISION } from '../../../lib/apigateway';

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
  // Falla cerrado: CRON_SECRET o la clave interna de Supabase (ver cronAuth.ts).
  if (!(await cronAutorizado(request))) return new Response('Unauthorized', { status: 401 });

  const { data: rows, error } = await supabase
    .from('bookings').select('id, notes').ilike('notes', `%${MARCA_PENDIENTE}%`)
    .not('status', 'in', '(cancelled,expired)')
    .order('session_date', { ascending: false }).limit(20);
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
  // Boletas de sesiones PAGADAS que no se pudieron emitir porque el SII no
  // respondió (marca BoletaPendienteEmision): se reintenta la emisión, hasta 7
  // días. Pasado ese plazo queda solo el aviso rojo del panel para emitirla a
  // mano. emitBoletaParaReserva tiene candado, así que no se duplica.
  // Filtrado y ordenado en la consulta (las más recientes primero): antes
  // reservas viejas, canceladas o desmarcadas podían ocupar los 20 cupos y las
  // boletas nuevas en cola nunca se reintentaban. Máximo 5 emisiones por
  // pasada para no pasarse del tiempo de la función a mitad de una emisión.
  const { data: emRows } = await supabase
    .from('bookings').select('id, notes, status, paid_at').ilike('notes', `%${MARCA_PENDIENTE_EMISION}%`)
    .not('paid_at', 'is', null)
    .not('status', 'in', '(cancelled,expired)')
    .order('paid_at', { ascending: false }).limit(20);
  const marcaEm = new RegExp(`${MARCA_PENDIENTE_EMISION} (\\S+)`);
  const emisiones: Array<{ id: string; ok: boolean; folio?: number | null; error?: string }> = [];
  for (const r of emRows ?? []) {
    if (r.status === 'cancelled' || r.status === 'expired' || !r.paid_at) continue;
    if (folioVigente(r.notes)) continue;
    const t = Date.parse(marcaEm.exec(r.notes ?? '')?.[1] ?? '');
    if (!isNaN(t) && Date.now() - t > 7 * 24 * 60 * 60 * 1000) continue;
    if (emisiones.length >= 5) break;
    const res = await emitBoletaParaReserva(r.id, { enviarEmail: true });
    emisiones.push({ id: r.id, ok: res.ok, folio: res.folio, error: res.error });
  }

  return json({ ok: true, pending: results.length, sent: results.filter(r => r.sent).length, results, emisiones });
};
