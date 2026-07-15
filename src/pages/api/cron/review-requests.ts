import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendReviewRequestEmail } from '../../../lib/email';

export const prerender = false;

// Marcador que se guarda en bookings.notes para no reenviar la misma sesión.
const MARKER = 'ReseñaSolicitada';
// Chile está en UTC-4/-3; usamos -4 (offset máximo) para ser conservadores:
// así una sesión se considera "terminada" solo cuando ya pasó con seguridad.
const CHILE_OFFSET_MS = 4 * 60 * 60 * 1000;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Vercel Cron lo llama a diario con cabecera Authorization: Bearer <CRON_SECRET>.
// Envía la solicitud de reseña de Google a los pacientes cuya sesión ya terminó
// (una vez por sesión: se marca la reserva para no repetir).
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) return new Response('Unauthorized', { status: 401 });
  }

  // Config: toggle + Place ID para armar el enlace de reseña
  const { data: rows } = await supabase.from('settings').select('key, value')
    .in('key', ['review_auto_enabled', 'google_place_id']);
  const cfg: Record<string, string> = {};
  (rows ?? []).forEach((r: { key: string; value: string }) => { cfg[r.key] = r.value; });

  if (cfg['review_auto_enabled'] === 'false') {
    return json({ ok: true, skipped: 'automatización deshabilitada' });
  }
  const placeId = cfg['google_place_id'];
  if (!placeId) return json({ ok: false, error: 'Falta el Place ID de Google en Configuración.' }, 400);
  const reviewUrl = `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;

  // Ventana: sesiones de los últimos 3 días (evita enviar a todo el histórico al
  // activar la función, y da margen si el cron falla algún día).
  const now      = Date.now();
  const today    = new Date(now).toISOString().slice(0, 10);
  const fromDate = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, patient_name, patient_email, session_date, session_time, duration_min, notes')
    .eq('status', 'confirmed')
    .gte('session_date', fromDate)
    .lte('session_date', today)
    .not('patient_email', 'is', null);

  let sent = 0, failed = 0, skipped = 0;

  for (const b of bookings ?? []) {
    if (!b.patient_email) { skipped++; continue; }
    if (b.session_date === '2099-12-31') { skipped++; continue; }         // cobro manual sin fecha
    if ((b.notes ?? '').includes(MARKER)) { skipped++; continue; }        // ya enviada

    // ¿La sesión ya terminó? (hora local Chile + duración; con buffer conservador)
    const time = (b.session_time ?? '00:00').slice(0, 5);
    const startUtc = Date.parse(`${b.session_date}T${time}:00Z`) + CHILE_OFFSET_MS;
    const endUtc   = startUtc + (b.duration_min ?? 50) * 60 * 1000;
    if (isNaN(endUtc) || endUtc > now) { skipped++; continue; }           // aún no termina

    const res = await sendReviewRequestEmail({
      patientName:  b.patient_name || 'hola',
      patientEmail: b.patient_email,
      reviewUrl,
    });

    if (res.sent) {
      sent++;
      const nota = `${b.notes ? b.notes + '\n' : ''}${MARKER} ${today}`;
      await supabase.from('bookings').update({ notes: nota }).eq('id', b.id);
    } else {
      failed++;
      console.error('[cron review-requests] no enviado:', b.id, res.reason);
    }
  }

  return json({ ok: true, sent, failed, skipped });
};
