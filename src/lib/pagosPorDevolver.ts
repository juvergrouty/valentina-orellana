import { supabase } from './supabase';
import { logInfo } from './logger';

// Pago por devolver o reagendar (decisión de Vale, 19 oct 2026): una sesión que
// ya estaba PAGADA y quedó anulada (la anuló Vale) o vencida (Flow pagó tarde y
// la hora ya estaba tomada) deja un aviso en el panel:
//   "Pago por devolver o reagendar: <paciente>, <fecha>, $<monto>"
// El aviso se queda hasta que Vale aprieta "Resuelto" ("ok, más el botón
// resuelto, porque eso ha ocurrido con sesiones de prueba").
//
// "Resuelto" NO borra ni cambia la reserva (ni su pago ni su boleta): solo deja
// un registro en settings ("pago_devolver_ok:<id de reserva>" → cuándo, desde
// qué sesión del panel, IP y navegador), igual que "Ya lo hice" de impuestos y
// "Listo" de Encuadrado. Sin migración. Además queda una línea en /admin/logs.
export const PREFIJO_RESUELTO = 'pago_devolver_ok:';
const SIN_FECHA = '2099-12-31'; // cobro manual sin sesión
const SIN_COSTO = 'Sin costo';
const LOTE = 150;

export type PagoPorDevolver = {
  id: string; paciente: string; fecha: string | null; hora: string | null; monto: number; estado: 'cancelled' | 'expired';
  /** Dónde verla: la ficha (muestra las sesiones anuladas; la agenda no) o la búsqueda de pacientes. */
  href: string;
};

type Fila = {
  id: string; patient_name?: string | null; patient_email?: string | null; session_date?: string | null; session_time?: string | null;
  status?: string | null; paid_at?: string | null; amount?: number | null; payment_note?: string | null;
};

/** ¿Esta reserva es un pago que hay que devolver o reagendar? (pagada de verdad, con monto, y anulada o vencida) */
export function esPagoPorDevolver(b: Fila): boolean {
  if (b.status !== 'cancelled' && b.status !== 'expired') return false;
  if (!b.paid_at) return false;
  if (!((Number(b.amount) || 0) > 0)) return false;
  return (b.payment_note ?? '') !== SIN_COSTO;
}

/** Texto del aviso: "Pago por devolver o reagendar: Ana Pérez, 22-10 18:00, $40.000". */
export function textoPagoPorDevolver(p: Pick<PagoPorDevolver, 'paciente' | 'fecha' | 'hora' | 'monto'>): string {
  const cuando = p.fecha && p.fecha !== SIN_FECHA
    ? `${p.fecha.slice(8, 10)}-${p.fecha.slice(5, 7)}-${p.fecha.slice(0, 4)}${p.hora ? ` ${p.hora}` : ''}`
    : 'cobro sin fecha';
  const monto = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(p.monto);
  return `Pago por devolver o reagendar: ${p.paciente}, ${cuando}, ${monto}`;
}

const trozos = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Pagos por devolver o reagendar que Vale todavía no marcó "Resuelto". Lanza si la base falla. */
export async function avisosPagosPorDevolver(): Promise<PagoPorDevolver[]> {
  const { data, error } = await supabase.from('bookings')
    .select('id, patient_name, patient_email, session_date, session_time, status, paid_at, amount, payment_note')
    .in('status', ['cancelled', 'expired'])
    .not('paid_at', 'is', null)
    .gt('amount', 0)
    .limit(1000);
  if (error) throw new Error(error.message);
  const filas = ((data ?? []) as Fila[]).filter(esPagoPorDevolver);
  if (!filas.length) return [];
  const resueltos = new Set<string>();
  for (const ids of trozos(filas.map((b) => b.id), LOTE)) {
    const { data: oks, error: e2 } = await supabase.from('settings').select('key').in('key', ids.map((id) => PREFIJO_RESUELTO + id));
    if (e2) throw new Error(e2.message);
    for (const r of oks ?? []) resueltos.add(String((r as { key: string }).key).slice(PREFIJO_RESUELTO.length));
  }
  const pendientes = filas.filter((b) => !resueltos.has(b.id));
  if (!pendientes.length) return [];
  // Ficha de cada paciente (por correo, sin mayúsculas) para el botón "Ver sesión". Si falla, se busca por nombre.
  const correos = [...new Set(pendientes.map((b) => String(b.patient_email ?? '').trim().toLowerCase()).filter(Boolean))];
  const fichaPorCorreo = new Map<string, string>();
  if (correos.length) {
    const { data: fichas } = await supabase.from('patients').select('id, email').in('email', correos);
    for (const f of (fichas ?? []) as { id: string; email: string | null }[]) if (f.email) fichaPorCorreo.set(String(f.email).toLowerCase(), f.id);
  }
  return pendientes
    .map((b) => ({
      id: b.id,
      paciente: String(b.patient_name ?? '').trim() || 'Paciente sin nombre',
      fecha: b.session_date && b.session_date !== SIN_FECHA ? String(b.session_date) : null,
      hora: b.session_date && b.session_date !== SIN_FECHA && b.session_time ? String(b.session_time).slice(0, 5) : null,
      monto: Number(b.amount) || 0,
      estado: b.status === 'expired' ? 'expired' as const : 'cancelled' as const,
      href: (() => {
        const pid = fichaPorCorreo.get(String(b.patient_email ?? '').trim().toLowerCase());
        return pid
          ? `/admin/pacientes/${encodeURIComponent(pid)}?tab=sesiones#s-${encodeURIComponent(b.id)}`
          : `/admin/pacientes?q=${encodeURIComponent(String(b.patient_name ?? '').trim())}`;
      })(),
    }))
    .sort((a, b) => `${a.fecha ?? '9999'}${a.hora ?? ''}`.localeCompare(`${b.fecha ?? '9999'}${b.hora ?? ''}`));
}

/** Quién apretó "Resuelto" (no hay usuarios: es el panel de Vale; se guarda cómo entró y desde dónde). */
export type QuienResuelve = { sesion: 'passkey' | 'contrasena' | 'desconocida'; ip: string | null; navegador: string | null };

/**
 * Botón "Resuelto": guarda el registro (sin tocar la reserva). Solo para reservas que de verdad son un
 * pago por devolver. Si ya estaba resuelto, no lo pisa (conserva quién y cuándo de la primera vez).
 */
export async function marcarPagoResuelto(bookingId: string, quien: QuienResuelve): Promise<{ ok: true } | { ok: false; error: 'no_existe' | 'no_aplica' | 'guardar' }> {
  if (!/^[0-9a-zA-Z-]{1,64}$/.test(bookingId)) return { ok: false, error: 'no_existe' };
  const { data: b, error } = await supabase.from('bookings')
    .select('id, patient_name, session_date, session_time, status, paid_at, amount, payment_note')
    .eq('id', bookingId).maybeSingle();
  if (error) return { ok: false, error: 'guardar' };
  if (!b) return { ok: false, error: 'no_existe' };
  if (!esPagoPorDevolver(b as Fila)) return { ok: false, error: 'no_aplica' };
  const ahora = new Date().toISOString();
  const registro = {
    resuelto_at: ahora,
    por: 'panel',
    sesion: quien.sesion,
    ip: quien.ip ? quien.ip.slice(0, 100) : null,
    navegador: quien.navegador ? quien.navegador.slice(0, 200) : null,
    paciente: (b as Fila).patient_name ?? null,
    fecha: (b as Fila).session_date ?? null,
    monto: Number((b as Fila).amount) || 0,
  };
  // ignoreDuplicates: un segundo clic (u otra pestaña) no pisa el primer registro.
  const { error: e2 } = await supabase.from('settings').upsert(
    { key: PREFIJO_RESUELTO + bookingId, value: JSON.stringify(registro), updated_at: ahora },
    { onConflict: 'key', ignoreDuplicates: true },
  );
  if (e2) return { ok: false, error: 'guardar' };
  await logInfo('pagos/resuelto', `Pago por devolver o reagendar marcado como resuelto: ${(b as Fila).patient_name ?? ''} (${(b as Fila).session_date ?? ''})`, { bookingId, ...registro });
  return { ok: true };
}
