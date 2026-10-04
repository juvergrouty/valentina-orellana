import { createHmac, timingSafeEqual } from 'node:crypto';
import { hoursUntilSessionCL } from './dateUtils';

// Link personal para que la paciente reagende sola desde su correo — a pedido
// de Valentina (3 oct 2026). Solo sirve hasta 24 horas antes de la sesión;
// después caduca. La clave se firma con ADMIN_SECRET: no se puede adivinar ni
// sirve para otra reserva, y evita pedirle el correo de nuevo.

export const REAGENDAR_HORAS_MIN = 24;
export const REAGENDAR_TEXTO = 'Solo puedes reagendar tu sesión hasta con 24 horas de anticipación.';
const SITE = 'https://www.valentinaorellana.cl';

function firma(bookingId: string): string {
  return createHmac('sha256', `reagendar:${import.meta.env.ADMIN_SECRET ?? ''}`).update(bookingId).digest('hex').slice(0, 32);
}

export function claveReagendarValida(bookingId: string, k: string | null | undefined): boolean {
  if (typeof bookingId !== 'string' || typeof k !== 'string' || !bookingId || !k || !import.meta.env.ADMIN_SECRET) return false;
  const a = Buffer.from(firma(bookingId));
  const b = Buffer.from(k);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function urlReagendar(bookingId: string): string {
  return `${SITE}/reagendar?id=${encodeURIComponent(bookingId)}&k=${firma(bookingId)}`;
}

/** ¿Todavía se puede reagendar en línea esta sesión? */
export function sePuedeReagendar(sessionDate: string, sessionTime: string): boolean {
  return hoursUntilSessionCL(sessionDate, sessionTime) >= REAGENDAR_HORAS_MIN;
}
