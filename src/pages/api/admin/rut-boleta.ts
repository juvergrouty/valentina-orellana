import type { APIRoute } from 'astro';
import { rutaInterna } from '../../../lib/rutaInterna';
import { guardarRutYEmitir } from '../../../lib/rutFaltante';

export const prerender = false;

// Botón «Agregar RUT» del aviso obligatorio de RUT (Inicio, ficha y sesión; 23 nov 2026).
// Guarda el RUT y la boleta sale sola con la fecha del pago (src/lib/rutFaltante.ts).
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const id = String(form.get('id') ?? '');
  const rut = String(form.get('rut') ?? '').trim();
  const destino = rutaInterna(form.get('redirect'), '/admin');
  const con = (q: string) => destino + (destino.includes('?') ? '&' : '?') + q;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return redirect(destino, 303);
  const r = await guardarRutYEmitir(id, rut);
  if (!r.ok) return redirect(con(`error=${r.error === 'rut_invalido' ? 'rut_aviso_invalido' : 'rut_aviso_guardar'}`), 303);
  return redirect(con(`rut_boleta=${r.boleta}`), 303);
};
