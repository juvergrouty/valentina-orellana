import type { APIRoute } from 'astro';
import { marcarPagoResuelto } from '../../../lib/pagosPorDevolver';
import { rutaInterna } from '../../../lib/rutaInterna';
import { COOKIE_ADMIN, nivelTokenAdmin } from '../../../lib/adminSession';

export const prerender = false;

// Botón "Resuelto" del aviso "Pago por devolver o reagendar" (ver src/lib/pagosPorDevolver.ts).
// No borra ni cambia la reserva: solo deja el registro de quién/cuándo lo resolvió.
export const POST: APIRoute = async ({ request, redirect, cookies, clientAddress }) => {
  const form = await request.formData();
  const id = String(form.get('id') ?? '');
  const destino = rutaInterna(form.get('redirect'), '/admin');
  const nivel = nivelTokenAdmin(cookies.get(COOKIE_ADMIN)?.value);
  let ip: string | null = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip')?.trim() || null;
  if (!ip) { try { ip = clientAddress ?? null; } catch { ip = null; } }
  const r = await marcarPagoResuelto(id, {
    sesion: nivel ?? 'desconocida',
    ip,
    navegador: request.headers.get('user-agent'),
  }).catch(() => ({ ok: false as const, error: 'guardar' as const }));
  if (!r.ok) return redirect(destino + (destino.includes('?') ? '&' : '?') + 'error=pago_resuelto_' + r.error, 303);
  return redirect(destino, 303);
};
