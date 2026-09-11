import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendReminderEmail, emailTypeEnabled } from '../../../lib/email';
import { sendWhatsappText, sendWhatsappTemplate } from '../../../lib/whatsapp';
import { nowCL } from '../../../lib/dateUtils';

export const prerender = false;

const MARKER = 'RecordatorioEnviado';
const WA_MARKER = 'RecordatorioWhatsAppEnviado';
const WA_WINDOW_HOURS = 4; // fijo, tal como se describe en el panel "Agendar hora"
const CHILE_OFFSET_MS = 4 * 60 * 60 * 1000; // Chile UTC-4/-3; usamos -4 (conservador)

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// Se llama cada 5 min vía GitHub Actions (.github/workflows/frequent-cron.yml —
// Vercel Hobby solo permite cron diario, así que la frecuencia real la da GH Actions,
// gratis en repos públicos). Envía el recordatorio por correo a los pacientes cuya
// sesión empieza dentro de la ventana configurada (reminder_window_hours, default 24h).
export const GET: APIRoute = async ({ request }) => {
  const secret = import.meta.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) return new Response('Unauthorized', { status: 401 });
  }

  // Interruptor global de correo (Configuración). Es independiente del de
  // WhatsApp: si ella apaga los recordatorios por correo, los de WhatsApp
  // igual se siguen evaluando más abajo.
  const emailRemindersOn = await emailTypeEnabled('reminder');

  // Ventana de antelación en horas antes de la sesión (por defecto 24h antes).
  const { data: winRow } = await supabase.from('settings').select('value').eq('key', 'reminder_window_hours').maybeSingle();
  const windowHours = parseInt(winRow?.value ?? '24') || 24;

  // Plantilla aprobada para el recordatorio de WhatsApp (Meta exige una para
  // mensajes que el sitio envía primero). Si aún no se creó una, se intenta
  // igual con texto libre — solo funciona si el paciente le escribió a este
  // número en las últimas 24h, así que casi nunca en este caso de uso.
  const { data: tplRows } = await supabase.from('settings').select('key, value')
    .in('key', ['whatsapp_reminder_template_name', 'whatsapp_reminder_template_lang']);
  const tplCfg: Record<string, string> = {};
  (tplRows ?? []).forEach((r: { key: string; value: string }) => { tplCfg[r.key] = r.value; });
  const templateName = tplCfg['whatsapp_reminder_template_name'];
  const templateLang  = tplCfg['whatsapp_reminder_template_lang'] || 'es';

  const now      = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  // "hoy"/"mañana" en la fecha calendario de Chile (no UTC — ver src/lib/dateUtils.ts)
  const today    = nowCL(new Date(now)).toISOString().slice(0, 10);
  const tomorrow = nowCL(new Date(now + 2 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);

  // Sesiones confirmadas de hoy/mañana, aún sin recordatorio enviado. Se piden
  // aunque no tengan correo (para poder mandar el recordatorio de WhatsApp igual).
  // reminder_email_enabled/whatsapp_reminder_enabled pueden no existir aún
  // (columnas nuevas) — si falla, reintenta sin ellas.
  let bookings: any[] | null = null;
  {
    const q = await supabase
      .from('bookings')
      .select('id, patient_name, patient_email, patient_phone, session_type, session_date, session_time, amount, payment_method, service_id, notes, reminder_email_enabled, whatsapp_reminder_enabled')
      .eq('status', 'confirmed')
      .gte('session_date', today)
      .lte('session_date', tomorrow);
    if (q.error?.code === '42703') {
      const retry = await supabase
        .from('bookings')
        .select('id, patient_name, patient_email, patient_phone, session_type, session_date, session_time, amount, payment_method, service_id, notes')
        .eq('status', 'confirmed')
        .gte('session_date', today)
        .lte('session_date', tomorrow);
      bookings = retry.data;
    } else {
      bookings = q.data;
    }
  }

  let sent = 0, failed = 0, skipped = 0;
  let waSent = 0, waFailed = 0, waSkipped = 0;

  for (const b of bookings ?? []) {
    if (b.session_date === '2099-12-31') { skipped++; waSkipped++; continue; } // cobro manual sin fecha
    const time = (b.session_time ?? '00:00').slice(0, 5);
    const startUtc = Date.parse(`${b.session_date}T${time}:00Z`) + CHILE_OFFSET_MS;
    // Notas "vivas" de esta vuelta — si el correo y el WhatsApp se marcan en la
    // misma ejecución, la segunda escritura no debe pisar la marca que dejó la primera.
    let liveNotes = b.notes ?? '';

    // ── Recordatorio por correo (ventana configurable, default 24h) ──────────
    doEmail: {
      if (!emailRemindersOn) { skipped++; break doEmail; }
      if (!b.patient_email) { skipped++; break doEmail; }
      if (b.reminder_email_enabled === false) { skipped++; break doEmail; }
      if (liveNotes.includes(MARKER)) { skipped++; break doEmail; }
      if (isNaN(startUtc) || startUtc <= now || startUtc > now + windowMs) { skipped++; break doEmail; }

      let serviceName: string | undefined;
      if (b.service_id) {
        const { data: svc } = await supabase.from('services_catalog').select('name').eq('id', b.service_id).maybeSingle();
        serviceName = svc?.name;
      }

      const res = await sendReminderEmail({
        patient_name:   b.patient_name,
        patient_email:  b.patient_email,
        patient_phone:  b.patient_phone ?? '',
        session_type:   b.session_type,
        session_date:   b.session_date,
        session_time:   time,
        amount:         b.amount ?? 0,
        payment_method: b.payment_method ?? 'manual',
        service_name:   serviceName,
      });

      if (res.sent) {
        sent++;
        liveNotes = `${liveNotes ? liveNotes + '\n' : ''}${MARKER} ${today}`;
        await supabase.from('bookings').update({ notes: liveNotes }).eq('id', b.id);
      } else {
        failed++;
      }
    }

    // ── Recordatorio por WhatsApp (ventana fija de 4h, opt-in) ───────────────
    // No falla si WhatsApp no está conectado — sendWhatsappText devuelve
    // sent:false con el motivo, y acá simplemente se cuenta como "failed" sin
    // reintentar en el próximo ciclo (para no bombardear el log cada 5 min).
    doWhatsapp: {
      if (b.whatsapp_reminder_enabled !== true) { waSkipped++; break doWhatsapp; }
      if (!b.patient_phone) { waSkipped++; break doWhatsapp; }
      if (liveNotes.includes(WA_MARKER)) { waSkipped++; break doWhatsapp; }
      const waWindowMs = WA_WINDOW_HOURS * 60 * 60 * 1000;
      if (isNaN(startUtc) || startUtc <= now || startUtc > now + waWindowMs) { waSkipped++; break doWhatsapp; }

      const firstName = (b.patient_name ?? '').split(' ')[0] || 'hola';

      const res = templateName
        ? await sendWhatsappTemplate(b.patient_phone, templateName, templateLang, [firstName, time])
        : await sendWhatsappText(b.patient_phone, `Hola ${b.patient_name ?? ''}, te recordamos tu hora de hoy a las ${time} hrs. — Valentina Orellana`);
      if (res.sent) {
        waSent++;
        liveNotes = `${liveNotes ? liveNotes + '\n' : ''}${WA_MARKER} ${today}`;
        await supabase.from('bookings').update({ notes: liveNotes }).eq('id', b.id);
      } else {
        // No se marca como enviado: reintenta en el próximo ciclo (cada 5 min)
        // hasta que se cumpla la ventana o el envío funcione (p.ej. una vez
        // conectado WhatsApp o aprobada la plantilla en Meta).
        waFailed++;
        console.error('[cron reminders] whatsapp no enviado:', b.id, res.reason);
      }
    }
  }

  return json({
    ok: true,
    email: { sent, failed, skipped, windowHours },
    whatsapp: { sent: waSent, failed: waFailed, skipped: waSkipped, windowHours: WA_WINDOW_HOURS },
  });
};

function formatDateShort(iso: string) {
  const [, m, d] = iso.split('-');
  return `${parseInt(d)}/${m}`;
}
