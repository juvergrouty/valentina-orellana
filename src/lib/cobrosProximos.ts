import { supabase } from './supabase';
import { hoursUntilSessionCL } from './dateUtils';
import { comprobanteEnRevision } from './comprobantes';
import { esPagoEnConsulta } from './pagoEnConsulta';

// Plazo de pago (Valentina, 14 oct 2026): el pago de una sesión debe quedar
// confirmado con un plazo máximo de 24 horas antes de la sesión. Se dice desde
// el primer mensaje (WhatsApp y correo con el link de pago), y el panel avisa
// desde 32 horas antes qué sesiones siguen sin pagar: así alcanza a cobrar y,
// si es presencial, a mover el box de Espacio Cala (se puede con 24 h).

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "martes 3 de noviembre" para una fecha YYYY-MM-DD. */
export function fechaSesionLarga(fecha: string): string {
  const [y, m, d] = fecha.split('-').map(Number);
  return `${DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} de ${MESES[m - 1]}`;
}

/** Frase del plazo para el mensaje de pago. Si ya faltan menos de 24 horas,
 *  el plazo pasó: se pide confirmar antes de la sesión. */
export function frasePlazoPago(fecha: string, hora: string): string {
  const h = hora.slice(0, 5);
  if (hoursUntilSessionCL(fecha, h) < 24) return `el cual debe quedar confirmado antes de tu sesión del ${fechaSesionLarga(fecha)} a las ${h}`;
  return `el cual debe quedar confirmado con un plazo máximo de 24 horas antes de tu sesión del ${fechaSesionLarga(fecha)} a las ${h}`;
}

/** Va en todos los mensajes de pago, online y presencial (Valentina, 14 oct
 *  2026): forma el hábito de pagar a tiempo. Dicho con suavidad, sin sonar a multa. */
export const AVISO_REAGENDAR = 'Si no alcanzas a pagar dentro de ese plazo, te escribo para que busquemos otro horario.';

/** Formas de pago del link combinado /pagar/<ficha> (Vale, 20 oct 2026: "que salga Flow y
 *  transferencia"). Va en el correo y el WhatsApp del link; no con el link directo de Flow de respaldo,
 *  que no ofrece transferencia. El script de la agenda (Cobrar) repite el mismo texto. */
export const FORMAS_DE_PAGO = 'Puedes pagar con tarjeta por Flow o por transferencia subiendo el comprobante.';
const conFormasDePago = (url: string) => (/\/pagar\//.test(url) ? `\n${FORMAS_DE_PAGO}` : '');

/** Mensaje de WhatsApp con el link de pago (el mismo texto que usaba
 *  Valentina a mano). Sin fecha de sesión, solo el link. */
export function mensajeLinkPago(nombre: string, url: string, fecha?: string | null, hora?: string | null): string {
  const primerNombre = (nombre || '').trim().split(/\s+/)[0] || '';
  const saludo = primerNombre ? `Hola ${primerNombre} 👋` : 'Hola 👋';
  if (fecha && hora && /^\d{4}-\d{2}-\d{2}$/.test(fecha) && hoursUntilSessionCL(fecha, hora.slice(0, 5)) > 0) {
    return `${saludo} Te comparto el link de pago, ${frasePlazoPago(fecha, hora)}: ${url}${conFormasDePago(url)}\n${AVISO_REAGENDAR}`;
  }
  return `${saludo} Te comparto el link de pago: ${url}${conFormasDePago(url)}`;
}

export const HORAS_AVISO_COBRO = 32;

export type CobroProximo = {
  id: string;
  paciente: string;
  fecha: string;
  hora: string;
  presencial: boolean;
  monto: number;
  waUrl: string | null;  // WhatsApp con el mensaje y el link listos
  sinLink: boolean;      // no hay link de pago que mandar (sin ficha ni orden de Flow)
  // "Pago en consulta" (19 oct 2026, ver pagoEnConsulta.ts): se cobra en la sesión, sin link ni plazo de 24 h.
  enConsulta: boolean;
};

/** Sesiones de la página (no las de Encuadrado) que empiezan en las próximas
 *  32 horas y siguen sin pagar. */
export async function cobrosProximos(origen: string): Promise<CobroProximo[]> {
  const hoy = new Date();
  const desde = new Date(hoy.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const hasta = new Date(hoy.getTime() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('bookings')
    .select('id, patient_name, patient_email, patient_phone, session_date, session_time, session_type, amount, status, paid_at, debt_voided, no_show, mp_preference_id, created_by_admin, notes, payment_method')
    .gte('session_date', desde).lte('session_date', hasta)
    .is('paid_at', null)
    .not('status', 'in', '(cancelled,expired)');
  if (error) throw new Error(error.message);
  // Import diferido: debt.ts → apigateway → email.ts, y email.ts importa este archivo (ciclo).
  const { esCobrable } = await import('./debt');

  const filas = (data ?? []).filter((b) => {
    // Misma regla única de cobro (esCobrable, auditoría 19 oct 2026): sin reservas web que la paciente
    // está pagando en Flow ni las que Flow ya informó pagadas (PagoSinAviso). Tampoco las que ya
    // tienen comprobante de transferencia por confirmar: eso es "Confirmar transferencia", no "Cobrar".
    if (!esCobrable(b) || comprobanteEnRevision(b.notes) || b.no_show || !b.session_time) return false;
    const h = hoursUntilSessionCL(b.session_date, String(b.session_time).slice(0, 5));
    return h > 0 && h <= HORAS_AVISO_COBRO;
  });
  if (!filas.length) return [];

  const correos = [...new Set(filas.map((b) => String(b.patient_email ?? '').toLowerCase()).filter(Boolean))];
  const { data: fichas } = correos.length
    ? await supabase.from('patients').select('id, email').in('email', correos)
    : { data: [] as { id: string; email: string }[] };
  const idPorCorreo = new Map((fichas ?? []).map((p) => [String(p.email).toLowerCase(), p.id as string]));

  const { data: envRow } = await supabase.from('settings').select('value').eq('key', 'flow_env').maybeSingle();
  const flowBase = envRow?.value === 'production' ? 'https://www.flow.cl/app/web/pay.php' : 'https://sandbox.flow.cl/app/web/pay.php';

  return filas
    .map((b) => {
      const hora = String(b.session_time).slice(0, 5);
      const pid = idPorCorreo.get(String(b.patient_email ?? '').toLowerCase());
      // Con ficha: /pagar/[id] cobra todo lo pendiente (igual que el botón "Cobrar").
      const url = pid ? `${origen}/pagar/${pid}` : (b.mp_preference_id ? `${flowBase}?token=${b.mp_preference_id}` : null);
      const digitos = String(b.patient_phone ?? '').replace(/\D/g, '');
      const tel = digitos.length === 9 ? '56' + digitos : digitos;
      const presencial = !String(b.session_type ?? '').includes('online');
      const enConsulta = esPagoEnConsulta(b);
      const texto = url ? mensajeLinkPago(b.patient_name, url, b.session_date, hora) : `Hola ${String(b.patient_name).split(' ')[0]} 👋`;
      return {
        id: b.id,
        paciente: b.patient_name,
        fecha: b.session_date,
        hora,
        presencial,
        monto: Number(b.amount),
        // Paga en consulta: sin WhatsApp de cobro (no hay link que mandar ni plazo que recordar).
        waUrl: !enConsulta && tel.length >= 10 ? `https://wa.me/${tel}?text=${encodeURIComponent(texto)}` : null,
        sinLink: !enConsulta && !url,
        enConsulta,
      };
    })
    .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
}

/** Momento límite (24 h antes) en texto: "lunes 2 de noviembre a las 09:00". */
export function limite24h(fecha: string, hora: string): string {
  const [y, m, d] = fecha.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  return `${fechaSesionLarga(prev)} a las ${hora}`;
}
