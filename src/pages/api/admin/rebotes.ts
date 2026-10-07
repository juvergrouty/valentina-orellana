import type { APIRoute } from 'astro';
import { quitarRebote } from '../../../lib/rebotes';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

// "Listo" en el aviso de correo rebotado del panel: lo quita de la lista.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const correo = String(form.get('correo') ?? '');
  if (correo) await quitarRebote(correo);
  return redirect(rutaInterna(form.get('redirect'), '/admin'), 303);
};
