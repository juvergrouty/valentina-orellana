import { Resend } from 'resend';

// Inicialización perezosa — no falla si la key no está configurada
let _resend: Resend | null = null;
function getResend(): Resend | null {
  const key = import.meta.env.RESEND_API_KEY;
  if (!key) return null;
  if (!_resend) _resend = new Resend(key);
  return _resend;
}

const FROM = import.meta.env.EMAIL_FROM ?? 'onboarding@resend.dev';

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
}

const SESSION_LABELS: Record<string, string> = {
  'online':            'Sesión Individual Online',
  'presencial':        'Sesión Individual Presencial',
  'pareja-online':     'Sesión de Pareja Online',
  'pareja-presencial': 'Sesión de Pareja Presencial',
};

// ─── Email al cliente: confirmación ──────────────────────────────────────────
export async function sendConfirmationToClient(data: BookingEmailData) {
  const client = getResend();
  if (!client) { console.warn('[email] RESEND_API_KEY no configurado — email omitido'); return; }

  const sessionLabel = data.service_name ?? SESSION_LABELS[data.session_type] ?? data.session_type;
  const payLabel = data.payment_method === 'manual'
    ? 'Pago en consulta'
    : data.payment_method === 'transferencia'
    ? 'Transferencia bancaria'
    : 'Pagado con Flow';

  await client.emails.send({
    from: FROM,
    to:   data.patient_email,
    subject: `Sesión confirmada — Ps. Valentina Orellana`,
    html: `
      <div style="font-family:'Georgia',serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        <h1 style="font-size:1.6rem;font-weight:400;margin-bottom:0.5rem;color:#1A1A18;">
          Tu sesión está confirmada
        </h1>
        <p style="color:#6B6860;font-size:0.9rem;margin-bottom:2rem;font-family:'Inter',sans-serif;">
          Hola ${data.patient_name}, aquí están los detalles de tu reserva.
        </p>

        <div style="background:#F4F0EC;padding:1.5rem;margin-bottom:1.5rem;">
          <table style="width:100%;border-collapse:collapse;font-family:'Inter',sans-serif;font-size:0.85rem;">
            <tr>
              <td style="padding:0.4rem 0;color:#6B6860;width:40%;">Tipo de sesión</td>
              <td style="padding:0.4rem 0;font-weight:500;">${sessionLabel}</td>
            </tr>
            <tr>
              <td style="padding:0.4rem 0;color:#6B6860;">Fecha</td>
              <td style="padding:0.4rem 0;font-weight:500;">${formatDate(data.session_date)}</td>
            </tr>
            <tr>
              <td style="padding:0.4rem 0;color:#6B6860;">Hora</td>
              <td style="padding:0.4rem 0;font-weight:500;">${data.session_time}</td>
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
            <li>Para <strong>reagendar</strong> avísame con al menos <strong>24 horas de anticipación</strong>.</li>
            <li>Las sesiones <strong>no se reembolsan</strong> por cancelación una vez confirmado el pago.</li>
            <li>Tu reserva está confirmada porque el <strong>pago fue procesado</strong>. Sin pago, el horario queda libre.</li>
          </ul>
          <p style="font-family:'Inter',sans-serif;font-size:0.78rem;color:#9B9485;margin-top:0.75rem;">
            <a href="https://valentina-orellana.vercel.app/condiciones" style="color:#576352;">Ver condiciones completas →</a>
          </p>
        </div>
        ` : `
        <p style="font-family:'Inter',sans-serif;font-size:0.85rem;color:#6B6860;line-height:1.6;margin-bottom:1.5rem;">
          Si necesitas reagendar, escríbeme <strong>con al menos 24 horas de anticipación</strong>.
        </p>
        `}

        <a href="https://wa.me/56972735696"
           style="display:inline-block;background:#576352;color:white;padding:0.75rem 1.5rem;
                  text-decoration:none;font-family:'Inter',sans-serif;font-size:0.75rem;
                  letter-spacing:0.1em;text-transform:uppercase;">
          Escribir por WhatsApp
        </a>

        <p style="font-family:'Inter',sans-serif;font-size:0.75rem;color:#6B6860;margin-top:2rem;
                  padding-top:1.5rem;border-top:1px solid #DDD8CF;">
          Ps. Valentina Orellana · Psicóloga Clínica · Santiago, Chile
        </p>
      </div>
    `,
  });
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
        <p style="font-size:0.9rem;color:#6B6860;margin-bottom:1.5rem;">Hola ${r.name},</p>
        <div style="font-size:0.92rem;line-height:1.7;color:#1A1A18;">${bodyHtml}</div>
        <p style="font-family:'Inter',sans-serif;font-size:0.75rem;color:#6B6860;margin-top:2rem;
                  padding-top:1.5rem;border-top:1px solid #DDD8CF;">
          Ps. Valentina Orellana · Psicóloga Clínica · Santiago, Chile
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

// ─── Email al admin: nueva reserva ───────────────────────────────────────────
export async function sendNotificationToAdmin(data: BookingEmailData, adminEmail: string) {
  const client = getResend();
  if (!client) { console.warn('[email] RESEND_API_KEY no configurado — email omitido'); return; }

  const sessionLabel = SESSION_LABELS[data.session_type] ?? data.session_type;

  await client.emails.send({
    from:    FROM,
    to:      adminEmail,
    subject: `Nueva reserva — ${data.patient_name} · ${formatDate(data.session_date)} ${data.session_time}`,
    html: `
      <div style="font-family:'Inter',sans-serif;max-width:480px;margin:0 auto;padding:1.5rem;color:#1A1A18;background:#FAF7F4;">
        <h2 style="font-size:1rem;font-weight:600;margin-bottom:1.25rem;border-bottom:2px solid #576352;padding-bottom:0.5rem;">
          Nueva reserva confirmada
        </h2>

        <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
          <tr><td style="padding:0.35rem 0;color:#6B6860;width:40%;">Paciente</td>
              <td style="padding:0.35rem 0;font-weight:500;">${data.patient_name}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Email</td>
              <td style="padding:0.35rem 0;">${data.patient_email}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Teléfono</td>
              <td style="padding:0.35rem 0;">${data.patient_phone}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Sesión</td>
              <td style="padding:0.35rem 0;">${sessionLabel}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Fecha</td>
              <td style="padding:0.35rem 0;font-weight:500;">${formatDate(data.session_date)}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Hora</td>
              <td style="padding:0.35rem 0;font-weight:600;font-size:1rem;">${data.session_time}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Método de pago</td>
              <td style="padding:0.35rem 0;">${data.payment_method === 'manual' ? '💵 Pago en consulta' : '💳 Flow'}</td></tr>
          <tr><td style="padding:0.35rem 0;color:#6B6860;">Monto</td>
              <td style="padding:0.35rem 0;font-weight:500;">${formatCLP(data.amount)}</td></tr>
        </table>

        <a href="https://valentina-orellana.vercel.app/admin/agenda"
           style="display:inline-block;margin-top:1.5rem;background:#1A1A18;color:white;
                  padding:0.6rem 1.2rem;text-decoration:none;font-size:0.72rem;
                  letter-spacing:0.1em;text-transform:uppercase;">
          Ver en panel admin
        </a>
      </div>
    `,
  });
}
