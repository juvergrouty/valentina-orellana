import { Resend } from 'resend';
import { supabase } from './supabase';
import { logEmail, logError } from './logger';
import { stepsItems, STEPS_INTRO } from './stepsContent';
import { todayCL } from './dateUtils';
import { urlReagendar, sePuedeReagendar, REAGENDAR_TEXTO } from './rescheduleLink';

// Inicialización perezosa — no falla si la key no está configurada
let _resend: Resend | null = null;
function getResend(): Resend | null {
  const key = import.meta.env.RESEND_API_KEY;
  if (!key) return null;
  if (!_resend) _resend = new Resend(key);
  return _resend;
}

const FROM = import.meta.env.EMAIL_FROM ?? 'onboarding@resend.dev';

// Respaldo si el setting `notification_email` no está configurado — el correo
// real de Valentina, NUNCA una dirección de terceros. Preferible a omitir el
// envío: un aviso o una boleta perdidos no deben quedar "en el aire".
export const ADMIN_EMAIL_FALLBACK = 'vinculosquesostienen@gmail.com';

/**
 * ¿Está habilitado este tipo de correo automático? Lee el setting
 * `email_<type>_enabled` (default: habilitado si no está en 'false').
 * Se usa SOLO para envíos automáticos; el reenvío manual del admin no lo consulta.
 */
export async function emailTypeEnabled(type: 'confirmation' | 'reminder' | 'review' | 'steps'): Promise<boolean> {
  const { data } = await supabase.from('settings').select('value').eq('key', `email_${type}_enabled`).maybeSingle();
  return data?.value !== 'false';
}

const MONTHS_ES = ['enero','febrero','marzo','abril','mayo','junio',
                   'julio','agosto','septiembre','octubre','noviembre','diciembre'];

function formatDate(iso: string) {
  const [y, m, d] = iso.split('-');
  return `${parseInt(d)} de ${MONTHS_ES[parseInt(m) - 1]} de ${y}`;
}

function formatCLP(n: number) {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency', currency: 'CLP', maximumFractionDigits: 0,
  }).format(n);
}

export interface BookingEmailData {
  patient_name:   string;
  patient_email:  string;
  patient_phone:  string;
  session_type:   string;
  session_date:   string;
  session_time:   string;
  amount:         number;
  payment_method: string;
  is_new_patient?: boolean;
  service_name?:  string;
  booking_id?:    string; // si viene, el correo de confirmación trae el link para reagendar
}

const SESSION_LABELS: Record<string, string> = {
  'online':            'Sesión Individual Online',
  'presencial':        'Sesión Individual Presencial',
  'pareja-online':     'Sesión de Pareja Online',
  'pareja-presencial': 'Sesión de Pareja Presencial',
};

// ─── Email al cliente: confirmación ──────────────────────────────────────────
// opts.skipToggle = true → reenvío manual del admin (ignora el interruptor de correos automáticos)
/** Dónde es la sesión: la dirección de la consulta (presencial) o el aviso del Meet (online). */
async function lugarSesion(sessionType: string | null | undefined): Promise<string> {
  if ((sessionType ?? '').includes('online')) return 'Online · el enlace de Google Meet está en la invitación de tu calendario';
  const { data: addr } = await supabase.from('settings').select('value').eq('key', 'clinic_address').maybeSingle();
  return addr?.value?.trim() ? `Presencial · ${addr.value.trim()}` : 'Presencial en la consulta';
}

export async function sendConfirmationToClient(data: BookingEmailData, opts: { skipToggle?: boolean } = {}) {
  const client = getResend();
  if (!client) { console.warn('[email] RESEND_API_KEY no configurado — email omitido'); return; }

  // Envío automático: respeta el interruptor de Configuración. El reenvío manual lo omite.
  if (!opts.skipToggle && !(await emailTypeEnabled('confirmation'))) {
    await logEmail('email/confirmacion', data.patient_email, 'Confirmación (desactivada en Configuración)', false, 'Envío automático desactivado');
    return;
  }

  const sessionLabel = data.service_name ?? SESSION_LABELS[data.session_type] ?? data.session_type;
  const lugar = await lugarSesion(data.session_type);
  const payLabel = data.payment_method === 'pendiente'
    ? 'Pendiente de pago'
    : data.payment_method === 'manual'
    ? 'Pago en consulta'
    : data.payment_method === 'transferencia'
    ? 'Transferencia bancaria'
    : !data.payment_method || data.payment_method === 'flow'
    ? 'Pagado con Flow'
    : `Pagado · ${escapeHtml(data.payment_method)}`; // ej. "Efectivo" desde Marcar como pagado

  const subject = `Sesión confirmada — Ps. Valentina Orellana`;
  const res = await client.emails.send({
    from: FROM,
    to:   data.patient_email,
    subject,
    html: `
      <div style="font-family:'Georgia',serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        <h1 style="font-size:1.6rem;font-weight:400;margin-bottom:0.5rem;color:#1A1A18;">
          Tu sesión está confirmada
        </h1>
        <p style="color:#6B6860;font-size:0.9rem;margin-bottom:2rem;font-family:'Inter',sans-serif;">
          Hola ${escapeHtml(data.patient_name)}, aquí están los detalles de tu reserva.
        </p>

        <div style="background:#F4F0EC;padding:1.5rem;margin-bottom:1.5rem;">
          <table style="width:100%;border-collapse:collapse;font-family:'Inter',sans-serif;font-size:0.85rem;">
            <tr>
              <td style="padding:0.4rem 0;color:#6B6860;width:40%;">Tipo de sesión</td>
              <td style="padding:0.4rem 0;font-weight:500;">${escapeHtml(sessionLabel)}</td>
            </tr>
            <tr>
              <td style="padding:0.4rem 0;color:#6B6860;">Modalidad</td>
              <td style="padding:0.4rem 0;font-weight:500;">${escapeHtml(lugar)}</td>
            </tr>
            <tr>
              <td style="padding:0.4rem 0;color:#6B6860;">Fecha</td>
              <td style="padding:0.4rem 0;font-weight:500;">${formatDate(data.session_date)}</td>
            </tr>
            <tr>
              <td style="padding:0.4rem 0;color:#6B6860;">Hora</td>
              <td style="padding:0.4rem 0;font-weight:500;">${String(data.session_time).slice(0, 5)}</td>
            </tr>
            <tr>
              <td style="padding:0.4rem 0;color:#6B6860;">Valor</td>
              <td style="padding:0.4rem 0;font-weight:500;">${formatCLP(data.amount)}</td>
            </tr>
            <tr>
              <td style="padding:0.4rem 0;color:#6B6860;">Pago</td>
              <td style="padding:0.4rem 0;font-weight:500;">${payLabel}</td>
            </tr>
          </table>
        </div>

        ${data.is_new_patient ? `
        <div style="background:#F4F0EC;padding:1.25rem 1.5rem;margin-bottom:1.5rem;border-left:3px solid #576352;">
          <p style="font-family:'Inter',sans-serif;font-size:0.8rem;font-weight:600;color:#1A1A18;margin-bottom:0.75rem;text-transform:uppercase;letter-spacing:0.06em;">
            Condiciones del servicio
          </p>
          <ul style="font-family:'Inter',sans-serif;font-size:0.82rem;color:#6B6860;line-height:1.7;margin:0;padding-left:1.1rem;">
            <li>Las sesiones no se cancelan: solo puedes <strong>reagendar tu hora</strong> avisando con al menos <strong>24 horas de anticipación</strong>.</li>
            <li>Si soy yo quien debe cancelar, reagendamos tu sesión sin costo.</li>
            <li>Tu reserva está confirmada porque el <strong>pago fue procesado</strong>. Sin pago, el horario queda libre.</li>
          </ul>
          <p style="font-family:'Inter',sans-serif;font-size:0.78rem;color:#9B9485;margin-top:0.75rem;">
            <a href="https://www.valentinaorellana.cl/condiciones" style="color:#576352;">Ver condiciones completas →</a>
          </p>
        </div>
        ` : `
        <p style="font-family:'Inter',sans-serif;font-size:0.85rem;color:#6B6860;line-height:1.6;margin-bottom:1.5rem;">
          Si necesitas reagendar, escríbeme <strong>con al menos 24 horas de anticipación</strong>.
        </p>
        `}

        ${data.booking_id && sePuedeReagendar(data.session_date, data.session_time) ? `
        <div style="border:1px solid #DDD8CF;padding:1.1rem 1.25rem;margin-bottom:1.5rem;">
          <p style="font-family:'Inter',sans-serif;font-size:0.85rem;color:#1A1A18;margin:0 0 0.75rem;">¿Necesitas cambiar tu hora?</p>
          <a href="${urlReagendar(data.booking_id)}"
             style="display:inline-block;border:1px solid #576352;color:#576352;padding:0.6rem 1.2rem;
                    text-decoration:none;font-family:'Inter',sans-serif;font-size:0.75rem;
                    letter-spacing:0.08em;text-transform:uppercase;">
            Reagendar mi sesión
          </a>
          <p style="font-family:'Inter',sans-serif;font-size:0.78rem;color:#6B6860;margin:0.75rem 0 0;">
            <strong>${REAGENDAR_TEXTO}</strong> Después el enlace caduca.
          </p>
        </div>
        ` : ''}

        <a href="https://wa.me/56972735696"
           style="display:inline-block;background:#576352;color:white;padding:0.75rem 1.5rem;
                  text-decoration:none;font-family:'Inter',sans-serif;font-size:0.75rem;
                  letter-spacing:0.1em;text-transform:uppercase;">
          Escribir por WhatsApp
        </a>

        <p style="font-family:'Inter',sans-serif;font-size:0.75rem;color:#6B6860;margin-top:2rem;
                  padding-top:1.5rem;border-top:1px solid #DDD8CF;">
          Ps. Valentina Orellana · Psicóloga · Reg. Superintendencia de Salud N° 360070
        </p>
      </div>
    `,
  });
  await logEmail('email/confirmacion', data.patient_email, subject, !res.error, res.error?.message);
}

// ─── Email al cliente: su sesión cambió (reagendada o cambio de servicio) ───
// Aviso genérico para cuando la admin modifica una sesión ya agendada desde el
// calendario (reagendar con aviso, o cambiar el servicio) — para que el
// paciente no se entere solo al llegar a la hora equivocada.
export async function sendSessionUpdatedEmail(data: {
  patient_name:  string;
  patient_email: string;
  reason:        string; // ej. "Tu sesión fue reagendada" / "Se actualizó el servicio de tu sesión"
  session_type:  string;
  session_date:  string;
  session_time:  string;
  amount:        number;
  service_name?: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const client = getResend();
  if (!client) return { sent: false, reason: 'RESEND_API_KEY no configurado' };

  const sessionLabel = data.service_name ?? SESSION_LABELS[data.session_type] ?? data.session_type;
  const subject = `${data.reason} — Ps. Valentina Orellana`;
  // Dónde: dirección de la consulta (presencial) o aviso del Meet (online).
  const esOnline = (data.session_type ?? '').includes('online');
  let lugar = 'Online · el enlace de Google Meet está en la invitación de tu calendario';
  if (!esOnline) {
    const { data: addr } = await supabase.from('settings').select('value').eq('key', 'clinic_address').maybeSingle();
    lugar = addr?.value?.trim() || 'Presencial en consulta';
  }
  const res = await client.emails.send({
    from: FROM,
    to:   data.patient_email,
    subject,
    html: `
      <div style="font-family:'Georgia',serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        <h1 style="font-size:1.5rem;font-weight:400;margin-bottom:0.5rem;">${data.reason}</h1>
        <p style="color:#6B6860;font-size:0.9rem;margin-bottom:1.5rem;font-family:'Inter',sans-serif;">
          Hola ${escapeHtml(data.patient_name)}, así queda tu sesión ahora.
        </p>
        <div style="background:#F4F0EC;padding:1.5rem;margin-bottom:1.5rem;">
          <table style="width:100%;border-collapse:collapse;font-family:'Inter',sans-serif;font-size:0.85rem;">
            <tr><td style="padding:0.4rem 0;color:#6B6860;width:40%;">Tipo de sesión</td><td style="padding:0.4rem 0;font-weight:500;">${escapeHtml(sessionLabel)}</td></tr>
            <tr><td style="padding:0.4rem 0;color:#6B6860;">Fecha</td><td style="padding:0.4rem 0;font-weight:500;">${formatDate(data.session_date)}</td></tr>
            <tr><td style="padding:0.4rem 0;color:#6B6860;">Hora</td><td style="padding:0.4rem 0;font-weight:500;">${String(data.session_time).slice(0, 5)}</td></tr>
            <tr><td style="padding:0.4rem 0;color:#6B6860;">${esOnline ? 'Modalidad' : 'Dirección'}</td><td style="padding:0.4rem 0;font-weight:500;">${escapeHtml(lugar)}</td></tr>
            <tr><td style="padding:0.4rem 0;color:#6B6860;">Valor</td><td style="padding:0.4rem 0;font-weight:500;">${formatCLP(data.amount)}</td></tr>
          </table>
        </div>
        <p style="font-family:'Inter',sans-serif;font-size:0.85rem;color:#6B6860;line-height:1.6;">
          Si tienes dudas, escríbeme directamente.
        </p>
        <a href="https://wa.me/56972735696"
           style="display:inline-block;background:#576352;color:white;padding:0.75rem 1.5rem;margin-top:1rem;
                  text-decoration:none;font-family:'Inter',sans-serif;font-size:0.75rem;
                  letter-spacing:0.1em;text-transform:uppercase;">
          Escribir por WhatsApp
        </a>
        <p style="font-family:'Inter',sans-serif;font-size:0.75rem;color:#6B6860;margin-top:2rem;
                  padding-top:1.5rem;border-top:1px solid #DDD8CF;">
          Ps. Valentina Orellana · Psicóloga · Reg. Superintendencia de Salud N° 360070
        </p>
      </div>
    `,
  });
  await logEmail('email/sesion-actualizada', data.patient_email, subject, !res.error, res.error?.message);
  if (res.error) return { sent: false, reason: res.error.message };
  return { sent: true };
}

// ─── Email al cliente: link de pago (Flow) ──────────────────────────────────
export async function sendPaymentLinkEmail(opts: {
  patientName:  string;
  patientEmail: string;
  serviceName:  string;
  amount:       number;
  sessionDate?: string;
  sessionTime?: string;
  paymentUrl:   string;
}): Promise<{ sent: boolean; reason?: string }> {
  const client = getResend();
  if (!client) return { sent: false, reason: 'RESEND_API_KEY no configurado' };

  const subject = `Enlace de pago para tu sesión — Ps. Valentina Orellana`;
  const dateLine = opts.sessionDate
    ? `<tr><td style="padding:0.4rem 0;color:#6B6860;width:40%;">Fecha</td><td style="padding:0.4rem 0;font-weight:500;">${formatDate(opts.sessionDate)}${opts.sessionTime ? ' · ' + opts.sessionTime : ''}</td></tr>`
    : '';

  const res = await client.emails.send({
    from: FROM,
    to:   opts.patientEmail,
    subject,
    html: `
      <div style="font-family:'Georgia',serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        <h1 style="font-size:1.5rem;font-weight:400;margin-bottom:0.5rem;">Enlace de pago de tu sesión</h1>
        <p style="color:#6B6860;font-size:0.9rem;margin-bottom:1.5rem;font-family:'Inter',sans-serif;">
          Hola ${escapeHtml(opts.patientName)}, para confirmar tu reserva realiza el pago con el siguiente enlace seguro.
        </p>
        <div style="background:#F4F0EC;padding:1.5rem;margin-bottom:1.5rem;">
          <table style="width:100%;border-collapse:collapse;font-family:'Inter',sans-serif;font-size:0.85rem;">
            <tr><td style="padding:0.4rem 0;color:#6B6860;width:40%;">Servicio</td><td style="padding:0.4rem 0;font-weight:500;">${opts.serviceName}</td></tr>
            ${dateLine}
            <tr><td style="padding:0.4rem 0;color:#6B6860;">Valor</td><td style="padding:0.4rem 0;font-weight:500;">${formatCLP(opts.amount)}</td></tr>
          </table>
        </div>
        <a href="${opts.paymentUrl}"
           style="display:inline-block;background:#576352;color:white;padding:0.85rem 1.75rem;
                  text-decoration:none;font-family:'Inter',sans-serif;font-size:0.78rem;
                  letter-spacing:0.1em;text-transform:uppercase;border-radius:4px;">
          Pagar mi sesión
        </a>
        <p style="font-family:'Inter',sans-serif;font-size:0.78rem;color:#9B9485;margin-top:1rem;">
          Tu reserva queda confirmada una vez procesado el pago.
        </p>
        <p style="font-family:'Inter',sans-serif;font-size:0.75rem;color:#6B6860;margin-top:2rem;
                  padding-top:1.5rem;border-top:1px solid #DDD8CF;">
          Ps. Valentina Orellana · Psicóloga · Reg. Superintendencia de Salud N° 360070
        </p>
      </div>
    `,
  });
  await logEmail('email/link-pago', opts.patientEmail, subject, !res.error, res.error?.message);
  if (res.error) return { sent: false, reason: res.error.message };
  return { sent: true };
}

// ─── Email al paciente: saldo pendiente de sesiones anteriores ──────────────
// Se usa desde "Cobrar todo" en /admin/deudas cuando el paciente no tiene
// teléfono para WhatsApp — igual que el mensaje de WhatsApp, enlaza a /pagar/[id]
// (recalcula en vivo lo que debe al momento de abrirlo, no un monto congelado).
export async function sendDebtReminderEmail(opts: {
  patientName:  string;
  patientEmail: string;
  amount:       number;
  sessionsCount: number;
  payUrl:       string;
}): Promise<{ sent: boolean; reason?: string }> {
  const client = getResend();
  if (!client) return { sent: false, reason: 'RESEND_API_KEY no configurado' };

  const subject = `Saldo pendiente de tus sesiones — Ps. Valentina Orellana`;
  const res = await client.emails.send({
    from: FROM,
    to:   opts.patientEmail,
    subject,
    html: `
      <div style="font-family:'Georgia',serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        <h1 style="font-size:1.5rem;font-weight:400;margin-bottom:0.5rem;">Tienes un saldo pendiente</h1>
        <p style="color:#6B6860;font-size:0.9rem;margin-bottom:1.5rem;font-family:'Inter',sans-serif;">
          Hola ${escapeHtml(opts.patientName)}, tienes un saldo pendiente de ${formatCLP(opts.amount)}
          por ${opts.sessionsCount} sesión${opts.sessionsCount === 1 ? '' : 'es'} anterior${opts.sessionsCount === 1 ? '' : 'es'}.
          Puedes revisar el detalle y pagarlo con el siguiente enlace seguro.
        </p>
        <a href="${opts.payUrl}"
           style="display:inline-block;background:#576352;color:white;padding:0.85rem 1.75rem;
                  text-decoration:none;font-family:'Inter',sans-serif;font-size:0.78rem;
                  letter-spacing:0.1em;text-transform:uppercase;border-radius:4px;">
          Ver y pagar mi saldo
        </a>
        <p style="font-family:'Inter',sans-serif;font-size:0.75rem;color:#6B6860;margin-top:2rem;
                  padding-top:1.5rem;border-top:1px solid #DDD8CF;">
          Ps. Valentina Orellana · Psicóloga · Reg. Superintendencia de Salud N° 360070
        </p>
      </div>
    `,
  });
  await logEmail('email/saldo-pendiente', opts.patientEmail, subject, !res.error, res.error?.message);
  if (res.error) return { sent: false, reason: res.error.message };
  return { sent: true };
}

/** "hoy", "mañana" o "el martes 14 de octubre", respecto de hoy en Chile. */
export function diaRelativo(sessionDate: string): string {
  const hoy = todayCL();
  const [y, m, d] = hoy.split('-').map(Number);
  const manana = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  if (sessionDate === hoy) return 'hoy';
  if (sessionDate === manana) return 'mañana';
  const [sy, sm, sd] = sessionDate.split('-').map(Number);
  const f = new Date(Date.UTC(sy, sm - 1, sd));
  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return `el ${DIAS[f.getUTCDay()]} ${sd} de ${MESES[sm - 1]}`;
}

/** "de hoy" / "de mañana" / "del martes 14 de octubre" (no "de el martes"). */
export function deDiaRelativo(sessionDate: string): string {
  const dia = diaRelativo(sessionDate);
  return dia.startsWith('el ') ? `del ${dia.slice(3)}` : `de ${dia}`;
}

// ─── Email al cliente: recordatorio de sesión ────────────────────────────────
export async function sendReminderEmail(data: BookingEmailData): Promise<{ sent: boolean; reason?: string }> {
  const client = getResend();
  if (!client) return { sent: false, reason: 'RESEND_API_KEY no configurado' };

  const sessionLabel = data.service_name ?? SESSION_LABELS[data.session_type] ?? data.session_type;
  const isOnline = (data.session_type ?? '').includes('online');
  const lugar = await lugarSesion(data.session_type);
  // "hoy" / "mañana" / la fecha, según el día real de la sesión (hora de Chile).
  // Antes decía siempre "hoy", aunque el recordatorio sale hasta 24 h antes.
  const dia = diaRelativo(data.session_date);
  const subject = `Recordatorio: tu sesión es ${dia} — Ps. Valentina Orellana`;

  const res = await client.emails.send({
    from: FROM,
    to:   data.patient_email,
    subject,
    html: `
      <div style="font-family:'Georgia',serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        <h1 style="font-size:1.5rem;font-weight:400;margin-bottom:0.5rem;">Te espero pronto 🌿</h1>
        <p style="color:#6B6860;font-size:0.9rem;margin-bottom:1.5rem;font-family:'Inter',sans-serif;">
          Hola ${escapeHtml(data.patient_name)}, te recuerdo tu sesión ${deDiaRelativo(data.session_date)}.
        </p>
        <div style="background:#F4F0EC;padding:1.5rem;margin-bottom:1.5rem;font-family:'Inter',sans-serif;font-size:0.88rem;line-height:1.8;">
          <p style="margin:0;"><strong>${escapeHtml(sessionLabel)}</strong></p>
          <p style="margin:0.3rem 0 0;color:#6B6860;">${formatDate(data.session_date)} · ${String(data.session_time).slice(0, 5)}</p>
          <p style="margin:0.6rem 0 0;color:#6B6860;">${isOnline ? '🎥 La sesión es online — revisa la invitación con el enlace de Google Meet.' : `📍 ${escapeHtml(lugar)}`}</p>
        </div>
        <p style="font-family:'Inter',sans-serif;font-size:0.85rem;color:#6B6860;line-height:1.6;margin-bottom:1.5rem;">
          Recuerda que solo puedes reagendar avisando con al menos 24 horas de anticipación.
        </p>
        <a href="https://wa.me/56972735696"
           style="display:inline-block;background:#576352;color:white;padding:0.75rem 1.5rem;
                  text-decoration:none;font-family:'Inter',sans-serif;font-size:0.75rem;
                  letter-spacing:0.1em;text-transform:uppercase;border-radius:4px;">
          Escribir por WhatsApp
        </a>
        <p style="font-family:'Inter',sans-serif;font-size:0.75rem;color:#6B6860;margin-top:2rem;
                  padding-top:1.5rem;border-top:1px solid #DDD8CF;">
          Ps. Valentina Orellana · Psicóloga · Reg. Superintendencia de Salud N° 360070
        </p>
      </div>
    `,
  });
  await logEmail('email/recordatorio', data.patient_email, subject, !res.error, res.error?.message);
  if (res.error) return { sent: false, reason: res.error.message };
  return { sent: true };
}

// ─── Email al cliente: reserva liberada por falta de pago ────────────────────
// Si se pasa `recoverUrl`, se ofrece un botón para pagar y recuperar el mismo
// horario (disponible solo hasta 4 horas antes de la sesión y mientras el
// horario siga libre — esa validación real la hace la página de recuperación).
export async function sendPendingExpiredEmail(data: {
  patient_name: string; patient_email: string; session_date: string; session_time: string; recoverUrl?: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const client = getResend();
  if (!client) return { sent: false, reason: 'RESEND_API_KEY no configurado' };

  const subject = `Tu horario del ${formatDate(data.session_date)} fue liberado — Ps. Valentina Orellana`;

  const recoverBlock = data.recoverUrl ? `
        <div style="background:#F4F0EC;padding:1.25rem 1.5rem;margin-bottom:1.5rem;border-left:3px solid #576352;">
          <p style="font-family:'Inter',sans-serif;font-size:0.85rem;color:#1A1A18;line-height:1.6;margin:0 0 1rem;">
            Si todavía quieres <strong>ese mismo horario</strong>, puedes pagarlo ahora y lo recuperamos —
            siempre que sigan quedando más de <strong>4 horas</strong> antes de la sesión y nadie más lo haya tomado.
          </p>
          <a href="${data.recoverUrl}"
             style="display:inline-block;background:#576352;color:white;padding:0.75rem 1.5rem;
                    text-decoration:none;font-family:'Inter',sans-serif;font-size:0.75rem;
                    letter-spacing:0.1em;text-transform:uppercase;border-radius:4px;">
            Pagar y mantener mi hora
          </a>
        </div>
  ` : '';

  const res = await client.emails.send({
    from: FROM,
    to:   data.patient_email,
    subject,
    html: `
      <div style="font-family:'Georgia',serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        <h1 style="font-size:1.5rem;font-weight:400;margin-bottom:0.5rem;">Tu horario fue liberado</h1>
        <p style="color:#6B6860;font-size:0.9rem;margin-bottom:1.5rem;font-family:'Inter',sans-serif;line-height:1.6;">
          Hola ${escapeHtml(data.patient_name)}, habías reservado el <strong>${formatDate(data.session_date)} a las ${data.session_time}</strong>,
          pero el pago no se completó a tiempo, así que el horario quedó disponible nuevamente para otra persona.
        </p>
        ${recoverBlock}
        <p style="font-family:'Inter',sans-serif;font-size:0.85rem;color:#6B6860;line-height:1.6;margin-bottom:1.5rem;">
          Si prefieres agendar un horario distinto, puedes hacerlo aquí mismo o escribirme directamente.
        </p>
        <a href="https://www.valentinaorellana.cl/agenda"
           style="display:inline-block;background:transparent;color:#576352;padding:0.75rem 1.5rem;
                  text-decoration:none;font-family:'Inter',sans-serif;font-size:0.75rem;
                  letter-spacing:0.1em;text-transform:uppercase;border:1px solid #576352;border-radius:4px;margin-right:0.5rem;">
          Agendar otro horario
        </a>
        <a href="https://wa.me/56972735696"
           style="display:inline-block;background:transparent;color:#576352;padding:0.75rem 1.5rem;
                  text-decoration:none;font-family:'Inter',sans-serif;font-size:0.75rem;
                  letter-spacing:0.1em;text-transform:uppercase;border:1px solid #576352;border-radius:4px;">
          Escribir por WhatsApp
        </a>
        <p style="font-family:'Inter',sans-serif;font-size:0.75rem;color:#6B6860;margin-top:2rem;
                  padding-top:1.5rem;border-top:1px solid #DDD8CF;">
          Ps. Valentina Orellana · Psicóloga · Reg. Superintendencia de Salud N° 360070
        </p>
      </div>
    `,
  });
  await logEmail('email/reserva-liberada', data.patient_email, subject, !res.error, res.error?.message);
  if (res.error) return { sent: false, reason: res.error.message };
  return { sent: true };
}

// ─── Email al cliente: solicitud de reseña en Google ─────────────────────────
export async function sendReviewRequestEmail(opts: {
  patientName:  string;
  patientEmail: string;
  reviewUrl:    string;
}): Promise<{ sent: boolean; reason?: string }> {
  const client = getResend();
  if (!client) return { sent: false, reason: 'RESEND_API_KEY no configurado' };

  const res = await client.emails.send({
    from: FROM,
    to:   opts.patientEmail,
    subject: 'Tu opinión me ayudaría mucho 🌿',
    html: `
      <div style="font-family:'Georgia',serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        <h1 style="font-size:1.5rem;font-weight:400;margin-bottom:0.75rem;">Gracias por confiar en este proceso</h1>
        <p style="color:#6B6860;font-size:0.9rem;line-height:1.7;margin-bottom:1.25rem;font-family:'Inter',sans-serif;">
          Hola ${escapeHtml(opts.patientName)}, luego del proceso que has vivido en terapia, me encantaría poder
          pedirte un favor: que pudieras evaluarme como psicóloga con una breve reseña en Google.
        </p>
        <p style="color:#6B6860;font-size:0.9rem;line-height:1.7;margin-bottom:1.75rem;font-family:'Inter',sans-serif;">
          Hazlo solo si te sientes cómodo/a — no hay ninguna obligación. Para mí sería de mucha ayuda,
          y también le sirve a otras personas que están dando el primer paso en buscar apoyo.
          ¡Gracias de corazón!
        </p>
        <a href="${opts.reviewUrl}"
           style="display:inline-block;background:#576352;color:white;padding:0.85rem 1.75rem;
                  text-decoration:none;font-family:'Inter',sans-serif;font-size:0.78rem;
                  letter-spacing:0.1em;text-transform:uppercase;border-radius:4px;">
          Dejar mi reseña en Google
        </a>
        <p style="font-family:'Inter',sans-serif;font-size:0.75rem;color:#6B6860;margin-top:2rem;
                  padding-top:1.5rem;border-top:1px solid #DDD8CF;">
          Ps. Valentina Orellana · Psicóloga · Reg. Superintendencia de Salud N° 360070
        </p>
      </div>
    `,
  });
  await logEmail('email/reseña', opts.patientEmail, 'Solicitud de reseña de Google', !res.error, res.error?.message);
  if (res.error) return { sent: false, reason: res.error.message };
  return { sent: true };
}

// ─── Email al cliente: seguimiento/evaluación después de la sesión ──────────
// Contenido genérico (no es un instrumento clínico) — pensado como punto de
// partida: si querés otro texto, u otro instrumento/formulario específico,
// avísame y lo cambio. Si hay un link de formulario guardado en Configuración
// (evaluation_form_url), se agrega al correo; si no, el correo solo invita a
// responder por este medio.
export async function sendEvaluationEmail(opts: {
  patientName:  string;
  patientEmail: string;
  formUrl?:     string;
}): Promise<{ sent: boolean; reason?: string }> {
  const client = getResend();
  if (!client) return { sent: false, reason: 'RESEND_API_KEY no configurado' };

  const formBlock = opts.formUrl
    ? `
        <a href="${opts.formUrl}"
           style="display:inline-block;background:#576352;color:white;padding:0.85rem 1.75rem;
                  text-decoration:none;font-family:'Inter',sans-serif;font-size:0.78rem;
                  letter-spacing:0.1em;text-transform:uppercase;border-radius:4px;">
          Completar evaluación
        </a>`
    : `
        <p style="color:#6B6860;font-size:0.9rem;line-height:1.7;font-family:'Inter',sans-serif;">
          Puedes responder directamente a este correo contándome cómo te sentiste con la sesión.
        </p>`;

  const res = await client.emails.send({
    from: FROM,
    to:   opts.patientEmail,
    subject: '¿Cómo te sentiste con tu sesión?',
    html: `
      <div style="font-family:'Georgia',serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        <h1 style="font-size:1.5rem;font-weight:400;margin-bottom:0.75rem;">Un momento para ti</h1>
        <p style="color:#6B6860;font-size:0.9rem;line-height:1.7;margin-bottom:1.75rem;font-family:'Inter',sans-serif;">
          Hola ${escapeHtml(opts.patientName)}, quería saber cómo te sentiste después de nuestra última sesión.
          Tu evaluación me ayuda a acompañarte mejor en el proceso.
        </p>
        ${formBlock}
        <p style="font-family:'Inter',sans-serif;font-size:0.75rem;color:#6B6860;margin-top:2rem;
                  padding-top:1.5rem;border-top:1px solid #DDD8CF;">
          Ps. Valentina Orellana · Psicóloga · Reg. Superintendencia de Salud N° 360070
        </p>
      </div>
    `,
  });
  await logEmail('email/evaluación', opts.patientEmail, 'Evaluación post-sesión', !res.error, res.error?.message);
  if (res.error) return { sent: false, reason: res.error.message };
  return { sent: true };
}

// ─── WhatsApp: pasos a seguir (mensaje corto con el link a /pasos-a-seguir) ──
export function stepsWhatsappText(patientName: string, url: string): string {
  return `Hola ${patientName.split(' ')[0]} 🌿 Te comparto los pasos a seguir para tu proceso: qué vas a recibir, cómo son las sesiones y qué hacer si necesitas reagendar.\n\n${url}\n\nCualquier duda me escribes. Valentina`;
}

// ─── Email al cliente: pasos a seguir / qué esperar ──────────────────────────
// Mismo contenido (src/lib/stepsContent.ts) y misma imagen que la página
// oculta /pasos-a-seguir/<clave>: foto de cabecera, tarjetas numeradas y botón
// de WhatsApp. HTML de tablas con estilos en línea para que se vea igual en
// Gmail, Outlook y el celular.
export function stepsEmailHtml(opts: { patientName: string; clinicAddress?: string }): string {
  const SITE = 'https://www.valentinaorellana.cl';
  const pasos = stepsItems(opts.clinicAddress);
  const card = (p: { titulo: string; texto: string }, n: number, full = false) => `
    <td valign="top" ${full ? 'colspan="2" width="100%"' : 'width="50%"'} class="col" style="background:#FFFFFF;padding:28px 26px;border:1px solid #DDD8CF;">
      <p style="margin:0 0 14px;font-family:'Inter',Arial,sans-serif;font-size:11px;letter-spacing:0.2em;color:#A8906C;font-weight:600;">${String(n).padStart(2, '0')}</p>
      <p style="margin:0 0 12px;font-family:'Domine',Georgia,serif;font-size:19px;line-height:1.3;color:#1A1A18;font-weight:400;">${escapeHtml(p.titulo)}</p>
      <div style="width:40px;height:2px;background:#C9CEC6;margin:0 0 14px;line-height:2px;font-size:0;">&nbsp;</div>
      <p style="margin:0;font-family:'Inter',Arial,sans-serif;font-size:14px;line-height:1.7;color:#6B6860;font-weight:300;">${escapeHtml(p.texto)}</p>
    </td>`;
  const filas: string[] = [];
  for (let i = 0; i < pasos.length; i += 2) {
    filas.push(pasos[i + 1]
      ? `<tr>${card(pasos[i], i + 1)}${card(pasos[i + 1], i + 2)}</tr>`
      : `<tr>${card(pasos[i], i + 1, true)}</tr>`);
  }

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  @media (max-width:600px){ .col{display:block!important;width:100%!important;box-sizing:border-box;} .pad{padding-left:20px!important;padding-right:20px!important;} .hero-title{font-size:30px!important;} }
</style></head>
<body style="margin:0;padding:0;background:#FAF7F4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F4;">
  <tr><td align="center">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;">
      <tr><td class="pad" style="background:#F5F1EC;padding:22px 32px;border-bottom:1px solid #DDD8CF;font-family:'Domine',Georgia,serif;font-size:20px;color:#1A1A18;">Ps. Valentina Orellana</td></tr>
      <tr><td style="padding:0;line-height:0;font-size:0;">
        <img src="${SITE}/images/hero-paginas.jpg" width="640" alt="" style="display:block;width:100%;max-width:640px;height:auto;max-height:230px;object-fit:cover;object-position:50% 25%;border:0;">
      </td></tr>
      <tr><td class="pad" bgcolor="#2E2E2B" style="background:#2E2E2B;padding:28px 32px 32px;">
        <p style="margin:0 0 12px;font-family:'Inter',Arial,sans-serif;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:#C9C4BB;">Bienvenida/o a tu proceso</p>
        <div style="width:40px;height:2px;background:#8A877F;margin:0 0 16px;line-height:2px;font-size:0;">&nbsp;</div>
        <p class="hero-title" style="margin:0;font-family:'Domine',Georgia,serif;font-size:36px;line-height:1.1;color:#FFFFFF;">Pasos a seguir</p>
      </td></tr>
      <tr><td class="pad" style="padding:40px 32px 28px;">
        <p style="margin:0 0 10px;font-family:'Inter',Arial,sans-serif;font-size:15px;line-height:1.7;color:#1A1A18;">Hola ${escapeHtml(opts.patientName.split(' ')[0])},</p>
        <p style="margin:0;font-family:'Inter',Arial,sans-serif;font-size:15px;line-height:1.7;color:#6B6860;font-weight:300;">${escapeHtml(STEPS_INTRO)}</p>
      </td></tr>
      <tr><td class="pad" style="padding:0 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${filas.join('')}</table>
      </td></tr>
      <tr><td class="pad" align="center" style="padding:44px 32px 16px;">
        <p style="margin:0 0 8px;font-family:'Domine',Georgia,serif;font-size:22px;color:#1A1A18;">¿Te quedó alguna duda?</p>
        <p style="margin:0 0 24px;font-family:'Inter',Arial,sans-serif;font-size:14px;color:#6B6860;">Escríbeme y lo vemos antes de tu sesión.</p>
        <a href="https://wa.me/56972735696" style="display:inline-block;background:#576352;color:#FFFFFF;padding:14px 32px;text-decoration:none;font-family:'Inter',Arial,sans-serif;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;border-radius:4px;">Escribir por WhatsApp</a>
      </td></tr>
      <tr><td class="pad" align="center" style="padding:20px 32px 40px;">
        <p style="margin:0;font-family:'Inter',Arial,sans-serif;font-size:12px;color:#6B6860;">Revisa también las <a href="${SITE}/condiciones" style="color:#6B6860;">condiciones del servicio y la política de privacidad</a>.</p>
      </td></tr>
      <tr><td class="pad" style="background:#1A1A18;padding:28px 32px;">
        <p style="margin:0 0 4px;font-family:'Domine',Georgia,serif;font-size:17px;color:#FAF7F4;">Valentina Orellana</p>
        <p style="margin:0;font-family:'Inter',Arial,sans-serif;font-size:12px;color:rgba(250,247,244,0.5);">Psicóloga · Reg. Superintendencia de Salud N° 360070 · Santiago, Chile</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

export async function sendStepsEmail(opts: {
  patientName:   string;
  patientEmail:  string;
  clinicAddress?: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const client = getResend();
  if (!client) return { sent: false, reason: 'RESEND_API_KEY no configurado' };
  const res = await client.emails.send({
    from: FROM,
    to:   opts.patientEmail,
    subject: 'Pasos a seguir para tu proceso — Ps. Valentina Orellana',
    html: stepsEmailHtml(opts),
  });
  await logEmail('email/pasos', opts.patientEmail, 'Pasos a seguir', !res.error, res.error?.message);
  if (res.error) return { sent: false, reason: res.error.message };
  return { sent: true };
}

// ─── Enviar boleta de honorarios con el PDF adjunto (vía Resend) ─────────────
export async function sendBoletaEmail(opts: {
  to: string;
  patientName: string;
  folio: number | string | null;
  pdfBase64: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const client = getResend();
  if (!client) return { sent: false, reason: 'RESEND_API_KEY no configurado' };

  const folioTxt = opts.folio ? ` N° ${opts.folio}` : '';
  const res = await client.emails.send({
    from: FROM,
    to:   opts.to,
    subject: `Tu boleta de honorarios${folioTxt} — Ps. Valentina Orellana`,
    html: `
      <div style="font-family:'Inter',sans-serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        <p style="font-size:0.95rem;color:#6B6860;margin-bottom:1.25rem;">Hola ${escapeHtml(opts.patientName)},</p>
        <p style="font-size:0.92rem;line-height:1.7;">
          Gracias por tu pago. Te adjunto tu <strong>boleta de honorarios electrónica${folioTxt}</strong>
          por la atención psicológica.
        </p>
        <p style="font-size:0.92rem;line-height:1.7;">
          Puedes usar este documento para solicitar el <strong>reembolso en tu Isapre o en tu seguro complementario de salud</strong>,
          según tu plan.
        </p>
        <p style="font-family:'Inter',sans-serif;font-size:0.75rem;color:#6B6860;margin-top:2rem;
                  padding-top:1.5rem;border-top:1px solid #DDD8CF;">
          Ps. Valentina Orellana · Psicóloga · Reg. Superintendencia de Salud N° 360070
        </p>
      </div>`,
    attachments: [{ filename: `boleta-${opts.folio ?? 'honorarios'}.pdf`, content: opts.pdfBase64 }],
  });
  await logEmail('email/boleta', opts.to, `Boleta${folioTxt}`, !res.error, res.error?.message);
  if (res.error) return { sent: false, reason: res.error.message };
  return { sent: true };
}

// ─── Correo masivo a pacientes ───────────────────────────────────────────────
export interface BulkEmailResult { sent: number; failed: number; skipped: number; }

export async function sendBulkEmail(
  recipients: { name: string; email: string }[],
  subject: string,
  bodyHtml: string,
): Promise<BulkEmailResult> {
  const client = getResend();
  if (!client) { console.warn('[email] RESEND_API_KEY no configurado — envío masivo omitido'); return { sent: 0, failed: 0, skipped: recipients.length }; }

  let sent = 0, failed = 0, skipped = 0;

  for (const r of recipients) {
    if (!r.email) { skipped++; continue; }
    const html = `
      <div style="font-family:'Inter',sans-serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        <p style="font-size:0.9rem;color:#6B6860;margin-bottom:1.5rem;">Hola ${escapeHtml(r.name)},</p>
        <div style="font-size:0.92rem;line-height:1.7;color:#1A1A18;">${bodyHtml}</div>
        <p style="font-family:'Inter',sans-serif;font-size:0.75rem;color:#6B6860;margin-top:2rem;
                  padding-top:1.5rem;border-top:1px solid #DDD8CF;">
          Ps. Valentina Orellana · Psicóloga · Reg. Superintendencia de Salud N° 360070
        </p>
      </div>`;
    try {
      const res = await client.emails.send({ from: FROM, to: r.email, subject, html });
      if (res.error) { failed++; console.error('[email] bulk:', res.error); }
      else sent++;
    } catch (e) {
      failed++;
      console.error('[email] bulk exception:', e);
    }
  }

  return { sent, failed, skipped };
}

// ─── Email al admin: hora liberada automáticamente por falta de pago ────────
export async function sendExpiredBookingAdminAlert(
  data: { patient_name: string; patient_email: string; session_date: string; session_time: string },
  adminEmail: string,
) {
  const client = getResend();
  if (!client) { console.warn('[email] RESEND_API_KEY no configurado — email omitido'); return; }

  const res = await client.emails.send({
    from:    FROM,
    to:      adminEmail,
    subject: `⚠️ Hora liberada automáticamente — ${data.patient_name} · ${formatDate(data.session_date)} ${data.session_time}`,
    html: `
      <div style="font-family:'Inter',sans-serif;max-width:480px;margin:0 auto;padding:1.5rem;color:#1A1A18;background:#FAF7F4;">
        <h2 style="font-size:1rem;font-weight:600;margin-bottom:1.25rem;border-bottom:2px solid #b5533c;padding-bottom:0.5rem;">
          Hora liberada por falta de pago
        </h2>
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
          <tr><td style="padding:0.35rem 0;color:#6B6860;width:40%;">Paciente</td>
              <td style="padding:0.35rem 0;font-weight:500;">${escapeHtml(data.patient_name)}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Email</td>
              <td style="padding:0.35rem 0;">${escapeHtml(data.patient_email)}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Fecha reservada</td>
              <td style="padding:0.35rem 0;font-weight:500;">${formatDate(data.session_date)}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Hora</td>
              <td style="padding:0.35rem 0;font-weight:600;font-size:1rem;">${data.session_time}</td></tr>
        </table>
        <p style="font-family:'Inter',sans-serif;font-size:0.8rem;color:#6B6860;margin-top:1rem;line-height:1.5;">
          El pago no se completó a tiempo y el horario quedó disponible nuevamente para otra persona.
          Al paciente también se le avisó por correo.
        </p>
      </div>
    `,
  });
  await logEmail('email/hora-liberada-admin', adminEmail, 'Hora liberada automáticamente', !res.error, res.error?.message);
}

// ─── Email al admin: paciente reagendó su sesión desde el sitio ─────────────
// Antes /api/reschedule.ts (reagendamiento público) reusaba sendNotificationToAdmin,
// que dice "Nueva reserva confirmada" — indistinguible de una reserva nueva de
// verdad, aunque sea el mismo paciente moviendo la hora de una sesión ya pagada.
export async function sendRescheduleAdminAlert(
  data: {
    patient_name: string; patient_email: string;
    old_date: string; old_time: string;
    new_date: string; new_time: string;
  },
  adminEmail: string,
) {
  const client = getResend();
  if (!client) { console.warn('[email] RESEND_API_KEY no configurado — email omitido'); return; }

  const res = await client.emails.send({
    from:    FROM,
    to:      adminEmail,
    subject: `🔁 Sesión reagendada — ${data.patient_name} · ahora ${formatDate(data.new_date)} ${data.new_time}`,
    html: `
      <div style="font-family:'Inter',sans-serif;max-width:480px;margin:0 auto;padding:1.5rem;color:#1A1A18;background:#FAF7F4;">
        <h2 style="font-size:1rem;font-weight:600;margin-bottom:1.25rem;border-bottom:2px solid #576352;padding-bottom:0.5rem;">
          El paciente reagendó su sesión
        </h2>
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
          <tr><td style="padding:0.35rem 0;color:#6B6860;width:40%;">Paciente</td>
              <td style="padding:0.35rem 0;font-weight:500;">${escapeHtml(data.patient_name)}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Email</td>
              <td style="padding:0.35rem 0;">${escapeHtml(data.patient_email)}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Antes</td>
              <td style="padding:0.35rem 0;text-decoration:line-through;color:#9B968C;">${formatDate(data.old_date)} ${String(data.old_time).slice(0, 5)}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Ahora</td>
              <td style="padding:0.35rem 0;font-weight:600;font-size:1rem;">${formatDate(data.new_date)} ${String(data.new_time).slice(0, 5)}</td></tr>
        </table>
      </div>
    `,
  });
  await logEmail('email/reagendo-admin', adminEmail, 'Paciente reagendó', !res.error, res.error?.message);
}

// ─── Email al admin: nueva reserva ───────────────────────────────────────────
export async function sendNotificationToAdmin(data: BookingEmailData, adminEmail: string, pendingPayment = false) {
  const client = getResend();
  if (!client) { console.warn('[email] RESEND_API_KEY no configurado — email omitido'); return; }

  const sessionLabel = SESSION_LABELS[data.session_type] ?? data.session_type;
  // La oficina donde subarrienda usa Reservo para el registro de horas
  // presenciales, pero esa cuenta no es de Valentina (solo tiene un perfil
  // dentro de ella) — no se puede integrar por API, así que el recordatorio
  // es este aviso en el correo de cada reserva presencial.
  const isPresencial = data.session_type.includes('presencial');

  // CORREGIDO: cuando se genera un link de pago desde el panel (agendar +
  // "Enviar link de pago"), este correo se mandaba diciendo "confirmada"
  // aunque el paciente todavía no había pagado nada — la reserva queda en
  // pending_payment hasta que el pago llegue. Eso hacía pensar que la sesión
  // ya estaba pagada cuando en realidad seguía pendiente. `pendingPayment`
  // distingue ambos casos sin tocar el resto de las llamadas (todas confirman
  // de verdad, así que quedan con el texto de siempre).
  const res = await client.emails.send({
    from:    FROM,
    to:      adminEmail,
    subject: pendingPayment
      ? `Link de pago enviado — ${data.patient_name} · ${formatDate(data.session_date)} ${data.session_time}`
      : `Nueva reserva — ${data.patient_name} · ${formatDate(data.session_date)} ${data.session_time}`,
    html: `
      <div style="font-family:'Inter',sans-serif;max-width:480px;margin:0 auto;padding:1.5rem;color:#1A1A18;background:#FAF7F4;">
        <h2 style="font-size:1rem;font-weight:600;margin-bottom:1.25rem;border-bottom:2px solid #576352;padding-bottom:0.5rem;">
          ${pendingPayment ? 'Link de pago enviado — aún sin pagar' : 'Nueva reserva confirmada'}
        </h2>

        ${pendingPayment ? `
        <p style="font-size:0.8rem;background:#FDF2E9;border-left:3px solid #b5533c;padding:0.6rem 0.8rem;margin-bottom:1rem;">
          ⏳ Esta reserva queda pendiente hasta que el paciente pague el link — no la cuentes como confirmada todavía.
        </p>` : ''}

        ${isPresencial ? `
        <p style="font-size:0.8rem;background:#FDF2E9;border-left:3px solid #b5533c;padding:0.6rem 0.8rem;margin-bottom:1rem;">
          📋 Sesión presencial — recuerda anotarla también en Reservo.
        </p>` : ''}

        <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
          <tr><td style="padding:0.35rem 0;color:#6B6860;width:40%;">Paciente</td>
              <td style="padding:0.35rem 0;font-weight:500;">${escapeHtml(data.patient_name)}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Email</td>
              <td style="padding:0.35rem 0;">${escapeHtml(data.patient_email)}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Teléfono</td>
              <td style="padding:0.35rem 0;">${escapeHtml(data.patient_phone)}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Sesión</td>
              <td style="padding:0.35rem 0;">${sessionLabel}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Fecha</td>
              <td style="padding:0.35rem 0;font-weight:500;">${formatDate(data.session_date)}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Hora</td>
              <td style="padding:0.35rem 0;font-weight:600;font-size:1rem;">${String(data.session_time).slice(0, 5)}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Método de pago</td>
              <td style="padding:0.35rem 0;">${data.payment_method === 'manual' ? '💵 Pago en consulta' : '💳 Flow'}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Monto</td>
              <td style="padding:0.35rem 0;font-weight:500;">${formatCLP(data.amount)}</td></tr>
        </table>

        <a href="https://www.valentinaorellana.cl/admin/agenda"
           style="display:inline-block;margin-top:1.5rem;background:#1A1A18;color:white;
                  padding:0.6rem 1.2rem;text-decoration:none;font-size:0.72rem;
                  letter-spacing:0.1em;text-transform:uppercase;">
          Ver en panel admin
        </a>
      </div>
    `,
  });
  await logEmail('email/notif-admin', adminEmail, 'Nueva reserva', !res.error, res.error?.message);
}

function escapeHtml(s: string | null | undefined) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Email al admin: mensaje del formulario de contacto ──────────────────────
export async function sendContactFormEmail(data: {
  nombre:  string;
  email:   string;
  motivo?: string;
  mensaje?: string;
}, adminEmail: string): Promise<{ sent: boolean; reason?: string }> {
  const client = getResend();
  if (!client) return { sent: false, reason: 'RESEND_API_KEY no configurado' };

  // El formulario solo valida con un regex laxo (para no rechazar correos
  // raros pero válidos). Si ese correo no pasa el formato más estricto que
  // exige Resend para el header Reply-To, Resend rechazaba TODO el envío —
  // o sea Valentina se quedaba sin saber que alguien había escrito. Detectado
  // el 12-09-2026: un visitante escribió y el aviso nunca le llegó.
  // Ahora: si el correo no sirve como Reply-To, se manda igual sin ese header
  // — ella pierde el "responder directo" pero nunca el aviso del mensaje.
  const REPLY_TO_STRICT = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;
  const replyTo = REPLY_TO_STRICT.test(data.email) ? data.email : undefined;

  const res = await client.emails.send({
    from:     FROM,
    to:       adminEmail,
    ...(replyTo ? { replyTo } : {}),
    subject:  `Nuevo mensaje de contacto — ${data.nombre}`,
    html: `
      <div style="font-family:'Inter',sans-serif;max-width:480px;margin:0 auto;padding:1.5rem;color:#1A1A18;background:#FAF7F4;">
        <h2 style="font-size:1rem;font-weight:600;margin-bottom:1.25rem;border-bottom:2px solid #576352;padding-bottom:0.5rem;">
          Nuevo mensaje desde el sitio
        </h2>
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
          <tr><td style="padding:0.35rem 0;color:#6B6860;width:30%;">Nombre</td>
              <td style="padding:0.35rem 0;font-weight:500;">${escapeHtml(data.nombre)}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Correo</td>
              <td style="padding:0.35rem 0;">${escapeHtml(data.email)}</td></tr>
          ${data.motivo ? `<tr><td style="padding:0.35rem 0;color:#6B6860;">Motivo</td>
              <td style="padding:0.35rem 0;">${escapeHtml(data.motivo)}</td></tr>` : ''}
        </table>
        ${data.mensaje ? `<p style="font-size:0.85rem;line-height:1.6;margin-top:1rem;white-space:pre-wrap;">${escapeHtml(data.mensaje)}</p>` : ''}
      </div>
    `,
  });
  await logEmail('email/contacto', adminEmail, 'Nuevo mensaje de contacto', !res.error, res.error?.message);
  if (res.error) return { sent: false, reason: res.error.message };
  return { sent: true };
}

// ─── Consentimiento informado (Ley 21.719) ──────────────────────────────────
// Link para firmar: solo sale cuando Valentina aprieta "Enviar por correo" en
// la ficha (nunca automático).
export async function sendConsentLinkEmail(opts: {
  patientName:  string;
  patientEmail: string;
  url:          string;
}): Promise<{ sent: boolean; reason?: string }> {
  const client = getResend();
  if (!client) return { sent: false, reason: 'RESEND_API_KEY no configurado' };
  const subject = 'Consentimiento informado para tu terapia';
  const res = await client.emails.send({
    from: FROM,
    to:   opts.patientEmail,
    subject,
    html: `
      <div style="font-family:'Georgia',serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        <h1 style="font-size:1.5rem;font-weight:400;margin-bottom:0.75rem;">Consentimiento informado</h1>
        <p style="color:#6B6860;font-size:0.9rem;line-height:1.7;margin-bottom:1.75rem;font-family:'Inter',sans-serif;">
          Hola ${escapeHtml(opts.patientName.split(' ')[0])}, te comparto el consentimiento para el tratamiento de tus datos
          en la terapia, que pide la nueva ley de protección de datos personales. Toma unos 2 minutos:
          lo lees, marcas lo que autorizas y firmas con tu nombre y RUT (o tu documento de identidad, si no tienes RUT chileno).
        </p>
        <a href="${opts.url}"
           style="display:inline-block;background:#576352;color:white;padding:0.85rem 1.75rem;
                  text-decoration:none;font-family:'Inter',sans-serif;font-size:0.78rem;
                  letter-spacing:0.1em;text-transform:uppercase;border-radius:4px;">
          Leer y firmar
        </a>
        <p style="font-family:'Inter',sans-serif;font-size:0.75rem;color:#6B6860;margin-top:2rem;
                  padding-top:1.5rem;border-top:1px solid #DDD8CF;">
          Ps. Valentina Orellana · Psicóloga · Reg. Superintendencia de Salud N° 360070
        </p>
      </div>
    `,
  });
  await logEmail('email/consentimiento', opts.patientEmail, subject, !res.error, res.error?.message);
  if (res.error) return { sent: false, reason: res.error.message };
  return { sent: true };
}

// Copia del consentimiento firmado: al paciente (su respaldo) y a Valentina.
export async function sendConsentSignedCopy(opts: {
  to:         string[];
  signerName: string;
  signerRut:  string;
  signedAt:   string;   // ya formateada
  plainText:  string;
  marcadas:   string[];
}): Promise<void> {
  const client = getResend();
  if (!client || !opts.to.length) return;
  const subject = `Consentimiento firmado — ${opts.signerName}`;
  const res = await client.emails.send({
    from: FROM,
    to:   opts.to,
    subject,
    html: `
      <div style="font-family:'Inter',sans-serif;max-width:600px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;font-size:0.85rem;line-height:1.6;">
        <p style="margin-bottom:1rem;">Copia del consentimiento firmado electrónicamente por <strong>${escapeHtml(opts.signerName)}</strong>
          (RUT ${escapeHtml(opts.signerRut)}) el ${escapeHtml(opts.signedAt)}.</p>
        <p style="margin-bottom:0.25rem;"><strong>Autorizaciones marcadas:</strong></p>
        <ul style="margin:0 0 1.25rem 1.1rem;">${opts.marcadas.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
        <pre style="white-space:pre-wrap;font-family:inherit;color:#6B6860;border-top:1px solid #DDD8CF;padding-top:1rem;">${escapeHtml(opts.plainText)}</pre>
      </div>
    `,
  });
  await logEmail('email/consentimiento-copia', opts.to.join(', '), subject, !res.error, res.error?.message);
}

// ─── Email a Valentina: comprobante de transferencia POR CONFIRMAR ───────────
// La paciente subió su comprobante en /pagar/[id]. Nada se marcó pagado: el
// pago se confirma con "Confirmar pago" en el panel (aviso arriba en todas las
// páginas). Lleva el comprobante adjunto para revisarlo contra el banco.
export async function sendTransferReceiptAdmin(opts: {
  to:           string;
  patientName:  string;
  patientEmail: string;
  total:        number;
  sesiones:     { label: string; amount: number }[];
  fileName:     string;
  fileBase64:   string;
  panelUrl:     string;
}): Promise<{ sent: boolean; reason?: string }> {
  const client = getResend();
  if (!client) return { sent: false, reason: 'RESEND_API_KEY no configurado' };
  const clp = (n: number) => new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n);
  const subject = `Comprobante de transferencia por confirmar: ${opts.patientName} · ${clp(opts.total)}`;
  const filas = opts.sesiones.map(s => `<tr><td style="padding:0.3rem 0;">${escapeHtml(s.label)}</td><td style="padding:0.3rem 0;text-align:right;">${clp(s.amount)}</td></tr>`).join('');
  const res = await client.emails.send({
    from: FROM,
    to:   opts.to,
    subject,
    html: `
      <div style="font-family:'Inter',Arial,sans-serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        <h1 style="font-family:Georgia,serif;font-size:1.35rem;font-weight:400;margin:0 0 0.75rem;">Comprobante de transferencia por confirmar</h1>
        <p style="font-size:0.9rem;line-height:1.6;color:#4A4840;margin:0 0 1rem;">
          <strong>${escapeHtml(opts.patientName)}</strong> (${escapeHtml(opts.patientEmail)}) subió el comprobante adjunto.
          Revisa que la transferencia esté en tu banco y aprieta <strong>Confirmar pago</strong> en el aviso del panel: ahí queda pagado y se emite y envía la boleta.
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:0.88rem;">
          ${filas}
          <tr><td style="padding:0.5rem 0 0;font-weight:600;border-top:1px solid #DDD8CF;">Total</td><td style="padding:0.5rem 0 0;text-align:right;font-weight:600;border-top:1px solid #DDD8CF;">${clp(opts.total)}</td></tr>
        </table>
        <p style="margin:1.5rem 0 0;"><a href="${escapeHtml(opts.panelUrl)}" style="display:inline-block;background:#576352;color:#fff;padding:0.7rem 1.2rem;text-decoration:none;font-weight:600;">Abrir el panel</a></p>
      </div>`,
    attachments: [{ filename: opts.fileName, content: opts.fileBase64 }],
  });
  await logEmail('email/transferencia', opts.to, subject, !res.error, res.error?.message);
  return res.error ? { sent: false, reason: res.error.message } : { sent: true };
}
