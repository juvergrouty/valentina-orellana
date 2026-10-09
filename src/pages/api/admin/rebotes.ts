import type { APIRoute } from 'astro';
import { quitarRebote } from '../../../lib/rebotes';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

// "Listo" en el aviso de correo rebotado del panel: lo quita de la lista.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const correo = String(form.get('correo') ?? '');
  const destino = rutaInterna(form.get('redirect'), '/admin');
  try {
    if (correo) await quitarRebote(correo);
  } catch {
    // No se guardó (8 oct 2026): antes era un 500 crudo. El aviso sigue
    // visible; se puede volver a apretar "Listo".
    return redirect(destino + (destino.includes('?') ? '&' : '?') + 'error=rebote_guardar', 303);
  }
  return redirect(destino, 303);
};
