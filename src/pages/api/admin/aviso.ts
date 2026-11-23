import type { APIRoute } from 'astro';
import { cambiarAviso } from '../../../lib/avisosPospuestos';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

// Botones "Recordar mañana", "Atiendo normal" y "Deshacer" de los avisos de la pantalla Hoy
// (ver src/lib/avisosPospuestos.ts). Solo esconden o muestran el aviso; no tocan nada de fondo.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const id = String(form.get('id') ?? '');
  const accionRaw = String(form.get('accion') ?? '');
  // «Esconder para siempre» solo para avisos informativos (tarifas y colegio); los demás se posponen hasta mañana.
  const informativo = /^(tarifas?|tarifaprox|colegio):/.test(id);
  const accion = accionRaw === 'deshacer' ? 'deshacer' : accionRaw === 'atendido' && informativo ? 'atendido' : 'manana';
  const destino = rutaInterna(form.get('redirect'), '/admin');
  const con = (p: string) => destino + (destino.includes('?') ? '&' : '?') + p;
  try {
    await cambiarAviso(id, accion);
  } catch {
    return redirect(con('error=aviso_guardar'), 303);
  }
  return redirect(accion === 'deshacer' ? destino : con(`aviso=${encodeURIComponent(id)}&hecho=${accion}`), 303);
};
