import type { APIRoute } from 'astro';
import { marcarEncuadradoListo, marcarEncuadradoEliminado } from '../../../lib/encuadrado';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

// Botón "Listo" del aviso "Encuadrado" del panel (ver src/lib/encuadrado.ts):
// accion=listo → ya la agendó o reagendó allá; accion=eliminado → ya la borró.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const id = String(form.get('id') ?? '');
  const accion = form.get('accion') === 'eliminado' ? 'eliminado' : 'listo';
  const destino = rutaInterna(form.get('redirect'), '/admin');
  try {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('sesión inválida');
    if (accion === 'eliminado') await marcarEncuadradoEliminado(id);
    else {
      const fecha = String(form.get('fecha') ?? '');
      const hora = String(form.get('hora') ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^\d{2}:\d{2}$/.test(hora)) throw new Error('fecha inválida');
      await marcarEncuadradoListo(id, fecha, hora);
    }
  } catch {
    // No se guardó: el aviso sigue visible; se puede volver a apretar.
    return redirect(destino + (destino.includes('?') ? '&' : '?') + 'error=encuadrado_guardar', 303);
  }
  return redirect(destino, 303);
};
