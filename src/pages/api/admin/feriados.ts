import type { APIRoute } from 'astro';
import { decidirFeriado } from '../../../lib/feriados';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

// POST /api/admin/feriados — Valentina decide si cierra o atiende un feriado
// (aviso del panel 2 semanas antes y lista en Horarios).
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const fecha = form.get('fecha')?.toString() ?? '';
  const decision = form.get('decision')?.toString();
  const [dest, ancla] = rutaInterna(form.get('redirect'), '/admin/horarios').split('#');
  const sep = dest.includes('?') ? '&' : '?';
  const fin = ancla ? `#${ancla}` : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || (decision !== 'cerrar' && decision !== 'atender')) {
    return redirect(`${dest}${sep}error=feriado${fin}`);
  }
  const ok = await decidirFeriado(fecha, decision);
  return redirect(`${dest}${sep}${ok ? `saved=feriado-${decision}` : 'error=feriado'}${fin}`);
};
