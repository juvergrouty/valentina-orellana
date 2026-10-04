import { createHmac, timingSafeEqual } from 'node:crypto';

// Sesión del panel (3 oct 2026). Antes la cookie era el propio ADMIN_SECRET:
// igual para siempre, así que una cookie robada servía indefinidamente.
// Ahora es un token firmado con vencimiento de 8 horas: "v1.<vence>.<firma>".

export const COOKIE_ADMIN = 'vo_admin_token';
export const DURACION_SESION_MS = 8 * 60 * 60 * 1000;

function firmar(payload: string): string {
  return createHmac('sha256', `panel:${import.meta.env.ADMIN_SECRET ?? ''}`).update(payload).digest('hex');
}

export function crearTokenAdmin(): string {
  const payload = `v1.${Date.now() + DURACION_SESION_MS}`;
  return `${payload}.${firmar(payload)}`;
}

export function tokenAdminValido(token: string | undefined | null): boolean {
  if (!token || !import.meta.env.ADMIN_SECRET) return false;
  const partes = token.split('.');
  if (partes.length !== 3 || partes[0] !== 'v1') return false;
  const vence = Number(partes[1]);
  if (!Number.isFinite(vence) || vence < Date.now()) return false;
  const esperada = Buffer.from(firmar(`v1.${partes[1]}`));
  const recibida = Buffer.from(partes[2]);
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}

/** Compara dos textos en tiempo constante (para la contraseña). */
export function igualesSeguro(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'cmp').update(a).digest();
  const hb = createHmac('sha256', 'cmp').update(b).digest();
  return timingSafeEqual(ha, hb);
}
