import type { APIRoute } from 'astro';
import { agregarHoraExtra, quitarHoraExtra, type ModalidadExtra } from '../../../lib/horasExtra';
import { todayCL } from '../../../lib/dateUtils';

export const prerender = false;

// POST /api/admin/horas-extra — abrir o quitar una hora extra en un día
// específico (formulario de /admin/horarios). Ver src/lib/horasExtra.ts.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form   = await request.formData();
  const action = form.get('action')?.toString();
  const dest   = '/admin/horarios';

  if (action === 'quitar') {
    const id = form.get('id')?.toString() ?? '';
    if (id) await quitarHoraExtra(id);
    return redirect(`${dest}?saved=extra-quitada#horas-extra`);
  }

  if (action === 'agregar') {
    const fecha = form.get('fecha')?.toString() ?? '';
    const hora  = (form.get('hora')?.toString() ?? '').slice(0, 5);
    const mod   = form.get('modalidad')?.toString() as ModalidadExtra;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fecha < todayCL()) return redirect(`${dest}?error=extra-fecha#horas-extra`);
    if (!/^\d{2}:\d{2}$/.test(hora)) return redirect(`${dest}?error=extra-hora#horas-extra`);
    if (!['presencial', 'online', 'ambos'].includes(mod)) return redirect(`${dest}?error=extra-modalidad#horas-extra`);
    const ok = await agregarHoraExtra(fecha, hora, mod);
    return redirect(`${dest}?${ok ? 'saved=extra' : 'error=extra-guardar'}#horas-extra`);
  }

  return redirect(dest);
};
