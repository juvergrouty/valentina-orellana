import type { APIRoute } from 'astro';
import { marcarBoxCala } from '../../../lib/boxCala';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

// Botones del aviso de box en Espacio Cala del panel: "Ya compré el box" / "Ya lo liberé".
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const slot = String(form.get('slot') ?? '');
  const accion = form.get('accion') === 'liberado' ? 'liberado' : 'reservado';
  const destino = rutaInterna(form.get('redirect'), '/admin');
  try {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(slot)) throw new Error('horario inválido');
    await marcarBoxCala(accion, {
      slot,
      fecha: slot.slice(0, 10),
      hora: slot.slice(11, 16),
      paciente: String(form.get('paciente') ?? '').slice(0, 120),
    });
  } catch {
    // No se guardó: el aviso sigue visible; se puede volver a apretar.
    return redirect(destino + (destino.includes('?') ? '&' : '?') + 'error=box_guardar', 303);
  }
  return redirect(destino, 303);
};
