import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';
import { getTotalOwedByEmail, manualChargeLabel } from '../../lib/debt';
import { sendTransferReceiptAdmin, ADMIN_EMAIL_FALLBACK } from '../../lib/email';
import { agregarLineaNotas } from '../../lib/apigateway';
import { BUCKET_COMPROBANTES, MARCA_COMPROBANTE, MARCA_TRANSFERENCIA_POR_REVISAR, comprobanteEnRevision } from '../../lib/comprobantes';
import { encolarTareas, procesarTareas, ejecutarTarea, nombreTarea, tareasDePago, sesionVigente, type TareaPago } from '../../lib/tareasEnvio';
import { upsertPatientFromBooking, fichaDesdePrimerPago } from '../../lib/patients';
import { logError, logInfo } from '../../lib/logger';

export const prerender = false;

// POST /api/comprobante-transferencia — la paciente sube el comprobante desde
// /pagar/[id]. Desde el 28 oct 2026 (Valentina: "que se le mande todo, pero que
// en el Inicio me haga un recordatorio para revisar manualmente el pago") las
// sesiones quedan PAGADAS al instante ("Transferencia") con los mismos envíos que
// un pago con Flow (confirmación con Meet, calendario, boleta, Pasos y
// consentimiento), y el Inicio pide revisar el banco (TransferenciaPorRevisar,
// ver src/lib/comprobantes.ts). Si no se puede confirmar, queda como antes:
// "por confirmar" hasta que Valentina apriete "Confirmar pago".

const MAX_SIZE = 4 * 1024 * 1024; // el cuerpo de una petición en Vercel admite hasta 4,5 MB
const TIPOS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
};

// El tipo real se saca de los primeros bytes del archivo, no de file.type, que
// lo manda el navegador y se puede falsear (8 oct 2026). Solo JPG, PNG, WEBP,
// HEIC/HEIF (fotos de iPhone) y PDF; cualquier otra cosa se rechaza.
const ASCII = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
const MARCAS_HEIC = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']);
const MARCAS_HEIF = new Set(['mif1', 'msf1', 'heif']);
function tipoReal(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 4 && ASCII(b, 0, 4) === '%PDF') return 'application/pdf';
  if (b.length >= 12 && ASCII(b, 0, 4) === 'RIFF' && ASCII(b, 8, 4) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && ASCII(b, 4, 4) === 'ftyp') {
    const marca = ASCII(b, 8, 4);
    if (MARCAS_HEIC.has(marca)) return 'image/heic';
    if (MARCAS_HEIF.has(marca)) return 'image/heif';
  }
  return null;
}
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
  const bytes = await file.arrayBuffer();
  const tipo = tipoReal(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 16)));
  const ext = tipo ? TIPOS[tipo] : undefined;
  if (!tipo || !ext) return json({ error: 'Sube una foto (JPG o PNG) o un PDF del comprobante.' }, 400);

  const { data: patient } = await supabase.from('patients').select('id, name, email').eq('id', patientId).maybeSingle();
  if (!patient?.email) return json({ error: 'Link no válido. Escríbele a Valentina para que te mande uno nuevo.' }, 404);

  const todo = await getTotalOwedByEmail(patient.email);
  if (!todo.length) return json({ error: 'Ya no tienes pagos pendientes. Si crees que es un error, escríbele a Valentina.' }, 400);
  // Un comprobante por cobro: si ya hay uno en revisión, no se suben más (evita
  // correos y archivos repetidos). Si se equivocó de archivo, escribe a Valentina.
  const pending = todo.filter(b => !comprobanteEnRevision(b.notes));
  if (!pending.length) return json({ error: 'Ya recibí tu comprobante y lo estoy revisando. Si necesitas cambiarlo, escríbeme por WhatsApp.' }, 400);
  const total = pending.reduce((s, b) => s + b.amount, 0);

  // Guardar el comprobante en un bucket privado (con el tipo detectado).
  const path = `${patient.id}/${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}.${ext}`;
  {
    const { error: bErr } = await supabase.storage.getBucket(BUCKET_COMPROBANTES);
    if (bErr) await supabase.storage.createBucket(BUCKET_COMPROBANTES, { public: false });
    const { error: upErr } = await supabase.storage.from(BUCKET_COMPROBANTES).upload(path, bytes, { contentType: tipo, upsert: false });
    if (upErr) {
      await logError('transferencia/comprobante', 'No se pudo guardar un comprobante de transferencia', { patientId, error: upErr.message });
      return json({ error: 'No se pudo subir el comprobante. Intenta de nuevo en unos minutos o escríbele a Valentina.' }, 500);
    }
  }

  // Marca "por confirmar" en cada sesión cubierta (sale en el aviso del panel).
  const iso = new Date().toISOString();
  for (const b of pending) await agregarLineaNotas(b.id, `${MARCA_COMPROBANTE} ${iso} ${path}`);
  await logInfo('transferencia', `Comprobante de transferencia por confirmar: ${patient.name}`, { patientId, ids: pending.map(b => b.id), total, path });

  // Se confirma al instante: pagada, con todos los envíos (misma cola que Flow).
  // La marca "por revisar en el banco" va ANTES de pagar: si la función se corta,
  // la tarea del Inicio aparece igual, y el barrido del cron (tareasEnvio.ts,
  // por mp_payment_id) recupera los envíos que no alcanzaron a registrarse.
  let confirmadas = 0;
  try {
    const ids = pending.map(b => b.id);
    for (const id of ids) await agregarLineaNotas(id, `${MARCA_TRANSFERENCIA_POR_REVISAR} ${iso} ${path}`);
    const { data: antes } = await supabase.from('bookings').select('id, status, session_date').in('id', ids);
    const pago = `transferencia-${Date.parse(iso)}`;
    const datosPago = { status: 'confirmed', paid_at: iso, payment_note: 'Transferencia', mp_payment_id: pago };
    let { data: pagadas, error: payErr } = await supabase.from('bookings')
      .update(datosPago).in('id', ids).is('paid_at', null).select();
    // Una sesión choca con otra reserva: se confirman una por una (igual que Flow); la que choca queda por confirmar a mano.
    if (payErr?.code === '23P01' || payErr?.code === '23505') {
      const ok: any[] = [];
      for (const id of ids) {
        const r = await supabase.from('bookings').update(datosPago).eq('id', id).is('paid_at', null).select();
        if (!r.error) ok.push(...(r.data ?? []));
        else await logError('transferencia/confirmar', 'Una sesión de la transferencia choca con otra reserva: queda para confirmar a mano', { patientId, bookingId: id, error: r.error.message });
      }
      pagadas = ok; payErr = null;
    }
    if (payErr) throw new Error(payErr.message);
    let conPasos = false;
    const enCola: string[] = [];
    const sinCola: { id: string; t: TareaPago[] }[] = [];
    for (const r of pagadas ?? []) {
      const previa = (antes ?? []).find((a: { id: string }) => a.id === r.id);
      const t: TareaPago[] = tareasDePago(previa?.status === 'pending_payment' && sesionVigente(previa.session_date));
      if (!conPasos) { conPasos = true; t.push('pasos'); }
      if (await encolarTareas(r.id, t, pago)) enCola.push(r.id); else sinCola.push({ id: r.id, t });
    }
    confirmadas = (pagadas ?? []).length;
    const idsPagadas = (pagadas ?? []).map((r: { id: string }) => r.id);
    for (const r of pagadas ?? []) {
      await upsertPatientFromBooking({ patient_name: r.patient_name, patient_email: r.patient_email, patient_phone: r.patient_phone, rut: r.patient_rut }).catch(console.error);
      await fichaDesdePrimerPago(r, idsPagadas).catch(console.error);
    }
    const plazo = Date.now() + 20_000;
    if (enCola.length) await procesarTareas({ bookingIds: enCola, hastaMs: plazo });
    // Respaldo si no se pudo registrar (igual que Flow); las llaves de idempotencia evitan duplicar.
    for (const { id, t } of sinCola) for (const tarea of t) if (Date.now() < plazo) await ejecutarTarea(id, nombreTarea(tarea, pago));
    if (confirmadas) await logInfo('transferencia/confirmada', `Transferencia de ${patient.name} confirmada al subir el comprobante; queda por revisar en el banco`, { patientId, ids: idsPagadas, total });
  } catch (e) {
    // No se pudo confirmar: queda "por confirmar" como antes (aviso del panel y "Confirmar pago").
    await logError('transferencia/confirmar', 'No se pudo confirmar sola la transferencia; queda para confirmar a mano', { patientId, error: e instanceof Error ? e.message : String(e) });
  }

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

  return json({ ok: true, confirmada: confirmadas > 0 });
};
