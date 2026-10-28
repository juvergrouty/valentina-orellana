import type { APIRoute } from 'astro';
import { agregarLineaNotas } from '../../../lib/apigateway';
import { MARCA_TRANSFERENCIA_REVISADA } from '../../../lib/comprobantes';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

// Botón "Ya la revisé" de la tarea "Revisar en tu banco la transferencia de…"
// del Inicio (ver getTransferenciasPorRevisar en src/lib/comprobantes.ts).
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const ids = String(form.get('ids') ?? '').split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const destino = rutaInterna(form.get('redirect'), '/admin');
  try {
    if (!ids.length) throw new Error('sin sesiones');
    const iso = new Date().toISOString();
    await Promise.all(ids.map((id) => agregarLineaNotas(id, `${MARCA_TRANSFERENCIA_REVISADA} ${iso}`)));
  } catch {
    return redirect(destino + (destino.includes('?') ? '&' : '?') + 'error=transferencia_guardar', 303);
  }
  return redirect(destino, 303);
};
