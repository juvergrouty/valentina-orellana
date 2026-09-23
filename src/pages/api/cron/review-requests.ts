import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendReviewRequestEmail, sendEvaluationEmail } from '../../../lib/email';
import { reviewRequestUrl } from '../../../lib/googleReviews';
import { nowCL, hoursUntilSessionCL } from '../../../lib/dateUtils';

export const prerender = false;

// Marcador que se guarda en bookings.notes para no reenviar la misma sesión.
const MARKER = 'ReseñaSolicitada';
// Correo de evaluación (opt-in por reserva, sección "Comunicaciones al paciente"
// del panel Agendar hora) — independiente de la solicitud de reseña de Google.
const EVAL_MARKER = 'EvaluacionEnviada';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Vercel Cron lo llama a diario con cabecera Authorization: Bearer <CRON_SECRET>.
// Envía la solicitud de reseña de Google a los pacientes cuya sesión ya terminó
// (una vez por sesión: se marca la reserva para no repetir).
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  // Falla cerrado: si CRON_SECRET no está configurado, nadie puede llamar al cron.
  {
    const auth = request.headers.get('authorization');
    if (!secret || auth !== `Bearer ${secret}`) return new Response('Unauthorized', { status: 401 });
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
      .select('id, patient_name, patient_email, session_date, session_time, duration_min, notes, evaluation_email_enabled, review_email_enabled, created_by_admin')
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

    // ¿La sesión ya terminó? (hora real de Chile, considera horario de verano
    // automáticamente — el offset fijo anterior asumía siempre UTC-4).
    const time = (b.session_time ?? '00:00').slice(0, 5);
    const hoursUntil   = hoursUntilSessionCL(b.session_date, time);
    const durationHrs  = (b.duration_min ?? 50) / 60;
    const alreadyEnded = !isNaN(hoursUntil) && hoursUntil <= -durationHrs;
    // Notas "vivas" de esta vuelta — si los dos correos se marcan en la misma
    // ejecución, la segunda escritura no debe pisar la marca que dejó la primera.
    let liveNotes = b.notes ?? '';

    doReview: {
      if (!alreadyEnded) { skipped++; break doReview; }
      if (liveNotes.includes(MARKER)) { skipped++; break doReview; }        // ya enviada
      // review_email_enabled es opt-in y por defecto false: si el paciente
      // reservó solo por el sitio, NO se le pide reseña automáticamente (a
      // diferencia del recordatorio y la boleta, que sí van por defecto).
      // Cuando Valentina agenda desde el panel, lo activa con el checkbox.
      // `undefined` (no `false`) significa que la migración de esta columna
      // todavía no corrió en la base de datos — se degrada al comportamiento
      // anterior (enviar a todos) para no dejar de mandar reseñas por eso.
      if (b.review_email_enabled === false) { skipped++; break doReview; }

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
