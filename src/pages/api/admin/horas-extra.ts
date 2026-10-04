import type { APIRoute } from 'astro';
import { agregarHoraExtra, quitarHoraExtra, quitarHoraDelDia, type ModalidadExtra } from '../../../lib/horasExtra';
import { todayCL } from '../../../lib/dateUtils';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

// POST /api/admin/horas-extra — abrir o quitar una hora extra en un día
// específico (formulario de /admin/horarios). Ver src/lib/horasExtra.ts.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form   = await request.formData();
  const action = form.get('action')?.toString();
  // Vuelve a la página desde donde se envió (Feriados o el horario de un servicio).
  const volver = form.get('volver')?.toString() ?? '';
  const dest   = /^\/admin\/[\w\-/]*(\?[\w=&-]*)?$/.test(volver) ? volver : '/admin/horarios';
  const sep    = dest.includes('?') ? '&' : '?';

  if (action === 'quitar') {
    const id = form.get('id')?.toString() ?? '';
    if (id) await quitarHoraExtra(id);
    return redirect(`${dest}${sep}saved=extra-quitada#horas-extra`);
  }

  // Quitar una hora del horario semanal SOLO en esa fecha, para un servicio.
  if (action === 'quitar-dia') {
    const fecha = form.get('fecha')?.toString() ?? '';
    const hora  = (form.get('hora')?.toString() ?? '').slice(0, 5);
    const svcId = form.get('servicio_id')?.toString() ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^\d{2}:\d{2}$/.test(hora) || !svcId) return redirect(`${dest}${sep}error=extra-guardar`);
    const ok = await quitarHoraDelDia(fecha, hora, svcId);
    return redirect(`${dest}${sep}${ok ? 'saved=hora-quitada-dia' : 'error=extra-guardar'}`);
  }

  // Quitar una hora del horario semanal de un servicio para TODAS las semanas
  // (desactiva esa franja; las sesiones ya agendadas no se tocan).
  if (action === 'quitar-semanal') {
    const slotId = form.get('slot_id')?.toString() ?? '';
    if (!slotId) return redirect(`${dest}${sep}error=extra-guardar`);
    const { error } = await supabase.from('availability_slots').update({ active: false }).eq('id', slotId);
    // Lleva el id para poder ofrecer "Deshacer" en el aviso.
    return redirect(`${dest}${sep}${error ? 'error=extra-guardar' : `saved=hora-quitada-semanal&deshacer=${encodeURIComponent(slotId)}`}`);
  }

  // Deshacer "Todas las semanas": vuelve a activar esa franja del horario semanal.
  if (action === 'restaurar-semanal') {
    const slotId = form.get('slot_id')?.toString() ?? '';
    if (!slotId) return redirect(`${dest}${sep}error=extra-guardar`);
    const { error } = await supabase.from('availability_slots').update({ active: true }).eq('id', slotId);
    return redirect(`${dest}${sep}${error ? 'error=extra-guardar' : 'saved=hora-restaurada'}`);
  }

  if (action === 'agregar') {
    const fecha = form.get('fecha')?.toString() ?? '';
    const hora  = (form.get('hora')?.toString() ?? '').slice(0, 5);
    // "destino": 'mod:presencial' | 'mod:online' | 'mod:ambos' | 'svc:<id del servicio>'
    const destino = form.get('destino')?.toString() ?? `mod:${form.get('modalidad')?.toString() ?? ''}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || fecha < todayCL()) return redirect(`${dest}${sep}error=extra-fecha#horas-extra`);
    if (!/^\d{2}:\d{2}$/.test(hora)) return redirect(`${dest}${sep}error=extra-hora#horas-extra`);
    let mod: ModalidadExtra;
    let servicioId: string | undefined;
    if (destino.startsWith('svc:')) {
      servicioId = destino.slice(4);
      const { data: svc } = await supabase.from('services_catalog').select('id, modality').eq('id', servicioId).maybeSingle();
      if (!svc) return redirect(`${dest}${sep}error=extra-modalidad#horas-extra`);
      mod = (['presencial', 'online'].includes(svc.modality) ? svc.modality : 'ambos') as ModalidadExtra;
    } else {
      mod = destino.slice(4) as ModalidadExtra;
      if (!['presencial', 'online', 'ambos'].includes(mod)) return redirect(`${dest}${sep}error=extra-modalidad#horas-extra`);
    }
    const ok = await agregarHoraExtra(fecha, hora, mod, servicioId);
    return redirect(`${dest}${sep}${ok ? 'saved=extra' : 'error=extra-guardar'}#horas-extra`);
  }

  return redirect(dest);
};
