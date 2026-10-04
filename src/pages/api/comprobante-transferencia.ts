import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { getTotalOwedByEmail, manualChargeLabel } from '../../lib/debt';
import { sendTransferReceiptAdmin, ADMIN_EMAIL_FALLBACK } from '../../lib/email';
import { agregarLineaNotas } from '../../lib/apigateway';
import { BUCKET_COMPROBANTES, MARCA_COMPROBANTE, comprobanteEnRevision } from '../../lib/comprobantes';
import { logError, logInfo } from '../../lib/logger';

export const prerender = false;

// POST /api/comprobante-transferencia — la paciente sube el comprobante desde
// /pagar/[id]. Solo se GUARDA y se AVISA: las sesiones quedan "por confirmar"
// hasta que Valentina apriete "Confirmar pago" en el panel (ver
// src/lib/comprobantes.ts). Nada se marca pagado aquí.

const MAX_SIZE = 4 * 1024 * 1024; // el cuerpo de una petición en Vercel admite hasta 4,5 MB
const TIPOS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
};
const SESSION_LABELS: Record<string, string> = {
  'online': 'Sesión individual online', 'presencial': 'Sesión individual presencial',
  'pareja-online': 'Sesión de pareja online', 'pareja-presencial': 'Sesión de pareja presencial',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try { form = await request.formData(); }
  catch { return json({ error: 'No se pudo leer el archivo. Intenta de nuevo.' }, 400); }

  const patientId = form.get('patientId')?.toString() ?? '';
  const file = form.get('comprobante') as File | null;
  if (!patientId) return json({ error: 'Link no válido.' }, 400);
  if (!file || !file.size) return json({ error: 'Adjunta la foto o captura de tu comprobante.' }, 400);
  if (file.size > MAX_SIZE) return json({ error: 'El archivo es muy grande (máximo 4 MB). Prueba con una captura de pantalla.' }, 400);
  const ext = TIPOS[file.type];
  if (!ext) return json({ error: 'Sube una foto (JPG o PNG) o un PDF del comprobante.' }, 400);

  const { data: patient } = await supabase.from('patients').select('id, name, email').eq('id', patientId).maybeSingle();
  if (!patient?.email) return json({ error: 'Link no válido. Escríbele a Valentina para que te mande uno nuevo.' }, 404);

  const todo = await getTotalOwedByEmail(patient.email);
  if (!todo.length) return json({ error: 'Ya no tienes pagos pendientes. Si crees que es un error, escríbele a Valentina.' }, 400);
  // Un comprobante por cobro: si ya hay uno en revisión, no se suben más (evita
  // correos y archivos repetidos). Si se equivocó de archivo, escribe a Valentina.
  const pending = todo.filter(b => !comprobanteEnRevision(b.notes));
  if (!pending.length) return json({ error: 'Ya recibí tu comprobante y lo estoy revisando. Si necesitas cambiarlo, escríbeme por WhatsApp.' }, 400);
  const total = pending.reduce((s, b) => s + b.amount, 0);

  // Guardar el comprobante en un bucket privado.
  const bytes = await file.arrayBuffer();
  const path = `${patient.id}/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}.${ext}`;
  {
    const { error: bErr } = await supabase.storage.getBucket(BUCKET_COMPROBANTES);
    if (bErr) await supabase.storage.createBucket(BUCKET_COMPROBANTES, { public: false });
    const { error: upErr } = await supabase.storage.from(BUCKET_COMPROBANTES).upload(path, bytes, { contentType: file.type, upsert: false });
    if (upErr) {
      await logError('transferencia/comprobante', 'No se pudo guardar un comprobante de transferencia', { patientId, error: upErr.message });
      return json({ error: 'No se pudo subir el comprobante. Intenta de nuevo en unos minutos o escríbele a Valentina.' }, 500);
    }
  }

  // Marca "por confirmar" en cada sesión cubierta (sale en el aviso del panel).
  const iso = new Date().toISOString();
  for (const b of pending) await agregarLineaNotas(b.id, `${MARCA_COMPROBANTE} ${iso} ${path}`);
  await logInfo('transferencia', `Comprobante de transferencia por confirmar: ${patient.name}`, { patientId, ids: pending.map(b => b.id), total, path });

  // Correo a Valentina con el comprobante adjunto.
  const { data: notifRow } = await supabase.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  const site = new URL(request.url).origin;
  const r = await sendTransferReceiptAdmin({
    to: notifRow?.value || ADMIN_EMAIL_FALLBACK,
    patientName: patient.name,
    patientEmail: patient.email,
    total,
    sesiones: pending.map(b => ({
      label: `${manualChargeLabel(b.notes) ?? SESSION_LABELS[b.session_type] ?? b.session_type}${b.session_date !== '2099-12-31' ? ` · ${b.session_date}` : ''}`,
      amount: b.amount,
    })),
    fileName: `comprobante-${(patient.name.split(' ')[0] || 'paciente').toLowerCase()}.${ext}`,
    fileBase64: Buffer.from(bytes).toString('base64'),
    panelUrl: `${site}/admin/pacientes/${patient.id}?tab=sesiones`,
  });
  if (!r.sent) await logError('transferencia/aviso', 'No se pudo enviar a Valentina el correo del comprobante', { patientId, error: r.reason });

  return json({ ok: true });
};
