// Cobros con tarjeta en la consulta con SumUp (Tap to Pay en el iPhone de Vale, 18 nov 2026).
//
// SumUp no sabe de qué sesión es cada cobro: Vale cobra en su app de SumUp y la página lo lee después
// por la API (transactions/history). Este archivo decide, sin tocar la base, a qué sesión corresponde
// cada cobro. Funciones puras: las usan el cron, el panel y las pruebas (sumupMatch.test.ts).
//
// Regla para asociar SOLA un cobro (si hay cualquier duda, queda "por asociar" y Vale elige en Cobros):
//   - cobro presencial (tarjeta frente a Vale), nunca uno por link;
//   - el cobro se hizo el mismo día de la sesión (hora de Chile), desde 30 min antes de que empiece
//     hasta 90 min después de que termine;
//   - en esa ventana cae UNA sola sesión del día, contando también las ya pagadas (si la paciente de
//     las 15:00 ya pagó por Flow y Vale le cobra otra cosa, ese cobro no puede ir a la sesión de las
//     16:00 de otra persona); solo se excluyen las canceladas y las reservas web vencidas;
//   - esa sesión está sin pagar, no anulada, y su monto es exactamente el del cobro.

// payment_note de la sesión pagada (se ve en la agenda como "Pagado · Tarjeta (SumUp)" y en Finanzas).
export const NOTA_PAGO_SUMUP = 'Tarjeta (SumUp)';
const ANTES_MIN = 30;
const DESPUES_MIN = 90;

export type CobroSumUp = {
  codigo: string;        // transaction_code (el que aparece en el recibo y en la app de SumUp)
  modo?: string | null;  // entry_mode de SumUp (contactless, chip…): solo lo presencial se asocia por hora
  monto: number;       // CLP
  cuando: string;      // ISO (UTC) del cobro
  tarjeta?: string | null;
  estado?: string | null;
};

export type SesionCandidata = {
  id: string;
  session_date: string;          // YYYY-MM-DD (Chile)
  session_time: string;          // HH:MM[:SS] (Chile)
  duration_min?: number | null;
  amount?: number | null;
  status?: string | null;
  paid_at?: string | null;
  debt_voided?: boolean | null;
};

/** Fecha (YYYY-MM-DD) y minuto del día de un instante, en hora de Chile. No depende del huso del servidor. */
export function enHoraChile(iso: string): { fecha: string; minuto: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const h = Number(v('hour')) % 24;
  return { fecha: `${v('year')}-${v('month')}-${v('day')}`, minuto: h * 60 + Number(v('minute')) };
}

const aMinutos = (hhmm: string) => {
  const [h, m] = String(hhmm ?? '00:00').slice(0, 5).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** ¿La sesión sigue cobrable (sin pagar, vigente)? Una reserva web vencida ('expired', no pagó a
 *  tiempo y su hora pudo pasar a otra) nunca se asocia sola ni se ofrece: se reagenda primero. */
export function sesionCobrable(s: SesionCandidata): boolean {
  if (s.paid_at || s.debt_voided === true) return false;
  if (s.status === 'cancelled' || s.status === 'expired') return false;
  return (s.amount ?? 0) > 0 && s.session_date !== '2099-12-31';
}

/** ¿El cobro cae en la ventana de esa sesión (mismo día, de 30 min antes a 90 min después de terminar)? */
export function enVentana(cobro: CobroSumUp, s: SesionCandidata): boolean {
  const c = enHoraChile(cobro.cuando);
  if (c.fecha !== s.session_date) return false;
  const ini = aMinutos(s.session_time);
  const fin = ini + (s.duration_min ?? 50);
  return c.minuto >= ini - ANTES_MIN && c.minuto <= fin + DESPUES_MIN;
}

// Cobros hechos con la tarjeta frente a Vale (Tap to Pay o lector). Un pago por link (online) puede
// llegar a cualquier hora: nunca se asocia por monto y hora, solo por su link.
const MODOS_PRESENCIALES = new Set(['contactless', 'chip', 'magstripe', 'contactless_magstripe']);
export const esPresencial = (c: CobroSumUp) => MODOS_PRESENCIALES.has(String(c.modo ?? '').toLowerCase());

/** La única sesión que corresponde sin duda a este cobro, o null (ninguna o más de una).
 *  `sesionesDelDia`: TODAS las sesiones de ese día (pagadas o no, cualquier monto). */
export function sesionParaCobro(cobro: CobroSumUp, sesionesDelDia: SesionCandidata[]): SesionCandidata | null {
  if (!esPresencial(cobro)) return null;
  const enHora = sesionesDelDia.filter((s) => s.status !== 'cancelled' && s.status !== 'expired' && enVentana(cobro, s));
  if (enHora.length !== 1) return null;
  const s = enHora[0];
  return sesionCobrable(s) && Number(s.amount) === Number(cobro.monto) ? s : null;
}

/** Lo que queda en bookings.mp_payment_id al pagar con SumUp (como "transferencia-…"): marca el
 *  cobro como usado (nunca paga dos sesiones con el mismo cobro) y nombra sus envíos ("boleta#sumup-…"). */
export const pagoSumUp = (codigo: string) => `sumup-${codigo}`;
export const codigoDePago = (mpPaymentId: string | null | undefined) =>
  String(mpPaymentId ?? '').startsWith('sumup-') ? String(mpPaymentId).slice(6) : null;

/** Código de transacción de SumUp con forma válida (nunca se mete otra cosa en una consulta). */
export const codigoValido = (c: unknown): c is string => typeof c === 'string' && /^[A-Z0-9]{6,20}$/.test(c);
