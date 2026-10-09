import type { APIRoute } from 'astro';
import { marcarCambioTarifa } from '../../../lib/cambiosTarifa';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

// Botones del aviso de cambio de tarifa del panel: "Ya le avisé" / "Listo".
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const id = String(form.get('id') ?? '');
  const campo = form.get('campo') === 'aplicado' ? 'aplicado' : 'avisado';
  const destino = rutaInterna(form.get('redirect'), '/admin');
  try {
    if (id) await marcarCambioTarifa(id, campo);
  } catch {
    // No se guardó: el aviso sigue visible; se puede volver a apretar.
    return redirect(destino + (destino.includes('?') ? '&' : '?') + 'error=tarifa_guardar', 303);
  }
  return redirect(destino, 303);
};
