// "Cambiar a link de pago" (pedido de Vale, 20 oct 2026): una hora agendada como "Paga en consulta"
// pasa a ser una hora por pagar normal. Solo se quita la marca PagoEnConsulta de las notas (ver
// pagoEnConsulta.ts): no se toca la fecha, la hora, el monto, el estado ni el evento de Google. Desde
// ahí la sesión se ve "Por pagar" y "💳 Cobrar" ofrece el link combinado /pagar/<ficha> (Flow o
// transferencia con comprobante), igual que cualquier hora por pagar. Queda registrado en /admin/logs.
import { supabase } from './supabase';
import { cambiarNotas } from './apigateway';
import { upsertPatientFromBooking } from './patients';
import { logInfo } from './logger';
import { esPagoEnConsulta, MARCA_PAGO_EN_CONSULTA } from './pagoEnConsulta';

export type ResultadoALink =
  | { ok: true; patientId: string | null }
  | { ok: false; error: 'no_encontrada' | 'no_en_consulta' | 'guardar'; detalle?: string };

/** Notas sin la línea de la marca (exacta, como la reconoce tieneMarcaPagoEnConsulta). */
export function notasSinMarcaConsulta(notes: string): string {
  return notes.split('\n').filter((l) => l.trim() !== MARCA_PAGO_EN_CONSULTA).join('\n');
}

export async function cambiarConsultaALink(id: string): Promise<ResultadoALink> {
  const { data: b } = await supabase.from('bookings')
    .select('id, status, paid_at, debt_voided, notes, payment_method, patient_name, patient_email, patient_phone, session_date, session_time, amount')
    .eq('id', id).maybeSingle();
  if (!b) return { ok: false, error: 'no_encontrada' };
  // Solo una hora vigente, sin pagar ni anular y con la marca (si ya se cambió, no se repite).
  if (!esPagoEnConsulta(b)) return { ok: false, error: 'no_en_consulta' };

  const r = await cambiarNotas(id, (n) => {
    const nuevo = notasSinMarcaConsulta(n);
    return nuevo === n ? null : nuevo;
  });
  if (!r.ok && !r.aborted) return { ok: false, error: 'guardar', detalle: r.error };

  // El link /pagar/<id> necesita la ficha: se asegura (solo completa datos vacíos de una ficha existente).
  let patientId: string | null = null;
  try {
    patientId = await upsertPatientFromBooking({ patient_name: b.patient_name, patient_email: b.patient_email, patient_phone: b.patient_phone });
  } catch (e) { console.error('[consulta-a-link] ficha:', e); }

  const hora = String(b.session_time ?? '').slice(0, 5);
  await logInfo('agenda/consulta-a-link',
    `Sesión de ${b.patient_name} del ${b.session_date} ${hora} cambiada de "Paga en consulta" a link de pago (fecha, hora y monto sin cambios)`,
    { bookingId: id, amount: b.amount, session_date: b.session_date, session_time: hora, patientId });
  return { ok: true, patientId };
}
