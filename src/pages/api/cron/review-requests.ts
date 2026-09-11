import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendReviewRequestEmail, sendEvaluationEmail } from '../../../lib/email';
import { reviewRequestUrl } from '../../../lib/googleReviews';
import { nowCL } from '../../../lib/dateUtils';

export const prerender = false;

// Marcador que se guarda en bookings.notes para no reenviar la misma sesión.
const MARKER = 'ReseñaSolicitada';
// Correo de evaluación (opt-in por reserva, sección "Comunicaciones al paciente"
// del panel Agendar hora) — independiente de la solicitud de reseña de Google.
const EVAL_MARKER = 'EvaluacionEnviada';
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

  // Config: toggle + link de reseña (google_review_url; si no está configurado
  // se usa el link que Vale confirmó que funciona — ver lib/googleReviews.ts).
  const { data: rows } = await supabase.from('settings').select('key, value')
    .in('key', ['review_auto_enabled', 'google_review_url']);
  const cfg: Record<string, string> = {};
  (rows ?? []).forEach((r: { key: string; value: string }) => { cfg[r.key] = r.value; });

  if (cfg['review_auto_enabled'] === 'false') {
    return json({ ok: true, skipped: 'automatización deshabilitada' });
  }
  const reviewUrl = reviewRequestUrl(cfg);

  // Ventana: sesiones de los últimos 3 días (evita enviar a todo el histórico al
  // activar la función, y da margen si el cron falla algún día).
  const now      = Date.now();
  // "hoy" en la fecha calendario de Chile (no UTC — ver src/lib/dateUtils.ts)
  const today    = nowCL(new Date(now)).toISOString().slice(0, 10);
  const fromDate = nowCL(new Date(now - 3 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);

  let bookings: any[] | null = null;
  {
    const q = await supabase
      .from('bookings')
      .select('id, patient_name, patient_email, session_date, session_time, duration_min, notes, evaluation_email_enabled')
      .eq('status', 'confirmed')
      .gte('session_date', fromDate)
      .lte('session_date', today)
      .not('patient_email', 'is', null);
    if (q.error?.code === '42703') {
      const retry = await supabase
        .from('bookings')
        .select('id, patient_name, patient_email, session_date, session_time, duration_min, notes')
        .eq('status', 'confirmed')
        .gte('session_date', fromDate)
        .lte('session_date', today)
        .not('patient_email', 'is', null);
      bookings = retry.data;
    } else {
      bookings = q.data;
    }
  }

  const { data: formRow } = await supabase.from('settings').select('value').eq('key', 'evaluation_form_url').maybeSingle();
  const formUrl = formRow?.value || undefined;

  let sent = 0, failed = 0, skipped = 0;
  let evalSent = 0, evalFailed = 0, evalSkipped = 0;

  for (const b of bookings ?? []) {
    if (!b.patient_email) { skipped++; evalSkipped++; continue; }
    if (b.session_date === '2099-12-31') { skipped++; evalSkipped++; continue; } // cobro manual sin fecha

    // ¿La sesión ya terminó? (hora local Chile + duración; con buffer conservador)
    const time = (b.session_time ?? '00:00').slice(0, 5);
    const startUtc = Date.parse(`${b.session_date}T${time}:00Z`) + CHILE_OFFSET_MS;
    const endUtc   = startUtc + (b.duration_min ?? 50) * 60 * 1000;
    const alreadyEnded = !isNaN(endUtc) && endUtc <= now;
    // Notas "vivas" de esta vuelta — si los dos correos se marcan en la misma
    // ejecución, la segunda escritura no debe pisar la marca que dejó la primera.
    let liveNotes = b.notes ?? '';

    doReview: {
      if (!alreadyEnded) { skipped++; break doReview; }
      if (liveNotes.includes(MARKER)) { skipped++; break doReview; }        // ya enviada

      const res = await sendReviewRequestEmail({
        patientName:  b.patient_name || 'hola',
        patientEmail: b.patient_email,
        reviewUrl,
      });

      if (res.sent) {
        sent++;
        liveNotes = `${liveNotes ? liveNotes + '\n' : ''}${MARKER} ${today}`;
        await supabase.from('bookings').update({ notes: liveNotes }).eq('id', b.id);
      } else {
        failed++;
        console.error('[cron review-requests] no enviado:', b.id, res.reason);
      }
    }

    doEval: {
      if (b.evaluation_email_enabled !== true) { evalSkipped++; break doEval; }
      if (!alreadyEnded) { evalSkipped++; break doEval; }
      if (liveNotes.includes(EVAL_MARKER)) { evalSkipped++; break doEval; } // ya enviada

      const res = await sendEvaluationEmail({
        patientName:  b.patient_name || 'hola',
        patientEmail: b.patient_email,
        formUrl,
      });

      if (res.sent) {
        evalSent++;
        liveNotes = `${liveNotes ? liveNotes + '\n' : ''}${EVAL_MARKER} ${today}`;
        await supabase.from('bookings').update({ notes: liveNotes }).eq('id', b.id);
      } else {
        evalFailed++;
        console.error('[cron review-requests] evaluación no enviada:', b.id, res.reason);
      }
    }
  }

  return json({
    ok: true,
    review:     { sent, failed, skipped },
    evaluation: { sent: evalSent, failed: evalFailed, skipped: evalSkipped },
  });
};
