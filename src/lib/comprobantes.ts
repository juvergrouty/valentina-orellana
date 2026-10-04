import { supabase } from './supabase';

// Comprobantes de transferencia — pago por transferencia como EXCEPCIÓN
// (Valentina, 3 oct 2026). La paciente sube el comprobante desde su link de
// pago /pagar/[id]; las sesiones quedan "por confirmar" (NO se marcan pagadas
// solas). Valentina ve un aviso en el panel y recibe un correo con el
// comprobante adjunto; al apretar "Confirmar pago" se usa el mismo "Marcar
// como pagado" de siempre (pago, calendario, boleta, Pasos a seguir).
//
// La marca vive en bookings.notes: `ComprobanteTransferencia <iso> <ruta>`.
// Mientras la sesión no tenga paid_at, sale en el aviso del panel.

export const BUCKET_COMPROBANTES = 'comprobantes'; // privado: solo desde el panel
export const MARCA_COMPROBANTE = 'ComprobanteTransferencia';

/** Último comprobante registrado en las notas de una sesión. */
export function comprobanteDe(notes: string | null): { at: string; path: string } | null {
  const lineas = [...(notes ?? '').matchAll(new RegExp(`${MARCA_COMPROBANTE} (\\S+) (\\S+)`, 'g'))];
  const ultima = lineas.at(-1);
  return ultima ? { at: ultima[1], path: ultima[2] } : null;
}

/** ¿La sesión tiene un comprobante de transferencia esperando confirmación?
 *  Esas sesiones no se vuelven a cobrar en /pagar (evita el doble pago). */
export function comprobanteEnRevision(notes: string | null | undefined): boolean {
  return !!comprobanteDe(notes ?? null);
}

export interface ComprobanteAlert {
  path:        string;
  subidoEl:    string;
  patientName: string;
  fichaId?:    string;
  total:       number;
  bookingIds:  string[];
}

/** Comprobantes subidos cuyas sesiones todavía no están pagadas (agrupados por archivo). */
export async function getComprobanteAlerts(): Promise<ComprobanteAlert[]> {
  const { data: rows } = await supabase
    .from('bookings')
    .select('id, patient_name, patient_email, amount, notes, paid_at, debt_voided, status')
    .ilike('notes', `%${MARCA_COMPROBANTE}%`)
    .is('paid_at', null)
    .limit(100);

  const porArchivo = new Map<string, ComprobanteAlert & { email: string }>();
  for (const b of rows ?? []) {
    if (b.debt_voided || b.status === 'cancelled' || b.status === 'expired') continue;
    const c = comprobanteDe(b.notes);
    if (!c) continue;
    const a = porArchivo.get(c.path) ?? { path: c.path, subidoEl: c.at, patientName: b.patient_name ?? '(sin nombre)', email: String(b.patient_email ?? '').toLowerCase(), total: 0, bookingIds: [] };
    a.total += b.amount ?? 0;
    a.bookingIds.push(b.id);
    porArchivo.set(c.path, a);
  }
  const alerts = [...porArchivo.values()];
  if (!alerts.length) return [];

  const emails = [...new Set(alerts.map(a => a.email).filter(Boolean))];
  const { data: fichas } = await supabase.from('patients').select('id, email').in('email', emails);
  const fichaDe = new Map((fichas ?? []).map((p: { id: string; email: string }) => [String(p.email).toLowerCase(), p.id]));
  return alerts
    .map(({ email, ...a }) => ({ ...a, fichaId: fichaDe.get(email) }))
    .sort((x, y) => x.subidoEl.localeCompare(y.subidoEl));
}
