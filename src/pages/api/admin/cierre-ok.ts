import type { APIRoute } from 'astro';
import { marcarCierreOk } from '../../../lib/blockedDayAlerts';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

// Botón "OK" del aviso "Próximo cierre en tu agenda": oculta ese cierre.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const clave = String(form.get('clave') ?? '');
  const agendadas = Math.max(0, Number(form.get('agendadas')) || 0);
  const destino = rutaInterna(form.get('redirect'), '/admin');
  try {
    if (!/^\d{4}-\d{2}-\d{2}\|(dia|\d{2}:\d{2}–\d{2}:\d{2})$/.test(clave)) throw new Error('cierre inválido');
    await marcarCierreOk(clave, agendadas);
  } catch {
    return redirect(destino + (destino.includes('?') ? '&' : '?') + 'error=cierre_guardar', 303);
  }
  return redirect(destino, 303);
};
