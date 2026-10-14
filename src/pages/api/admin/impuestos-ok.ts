import type { APIRoute } from 'astro';
import { marcarImpuestosPagados } from '../../../lib/impuestos';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

// Botón "Ya lo hice" del aviso mensual de impuestos (ver src/lib/impuestos.ts).
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const mes = String(form.get('mes') ?? '');
  const destino = rutaInterna(form.get('redirect'), '/admin');
  try {
    await marcarImpuestosPagados(mes);
  } catch {
    return redirect(destino + (destino.includes('?') ? '&' : '?') + 'error=impuestos_guardar', 303);
  }
  return redirect(destino, 303);
};
