import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { logInfo } from '../../../lib/logger';
import { sincronizarEventoItem, type VitrinaItem } from '../../../lib/vitrina';
import { getValidAccessToken } from '../../../lib/syncCalendar';
import { deleteCalendarEvent } from '../../../lib/googleCalendar';
import { VITRINA_TIPOS, VITRINA_MODALIDADES, slugify, slugValido, chileLocalAISO } from '../../../lib/vitrinaUtils';

export const prerender = false;

// POST /api/admin/vitrina — items de la vitrina (formularios de /admin/vitrina).
// action: save | duplicate | toggle_visible | calendar | delete
// Vuelve a /admin/vitrina con ?ok=… o ?error=… (como Servicios).
export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const id = String(form.get('id') ?? '').trim();
  const get = (k: string) => String(form.get(k) ?? '').trim();

  const volver = (params: Record<string, string>) => {
    const u = new URLSearchParams(params);
    return new Response(null, { status: 302, headers: { Location: `/admin/vitrina?${u.toString()}` } });
  };
  const conError = (detalle: string, extra: Record<string, string> = {}) => volver({ error: detalle.slice(0, 200), ...extra });

  if (action === 'save') {
    const type = get('type');
    const modality = get('modality') || 'online';
    const title = get('title');
    if (!(VITRINA_TIPOS as readonly string[]).includes(type)) return conError('Tipo inválido.');
    if (!(VITRINA_MODALIDADES as readonly string[]).includes(modality)) return conError('Modalidad inválida.');
    if (title.length < 3 || title.length > 160) return conError('El título debe tener entre 3 y 160 caracteres.', id ? { edit: id } : { nuevo: '1' });
    const slug = slugify(get('slug') || title);
    if (!slugValido(slug)) return conError(`La dirección "${slug}" no sirve (usa letras, números y guiones; "confirmacion" está reservada).`, id ? { edit: id } : { nuevo: '1' });

    const precio = Math.round(Number(get('price') || '0'));
    if (!Number.isFinite(precio) || precio < 0 || (precio > 0 && precio < 100)) return conError('Precio inválido (0 = gratis; si cobras, mínimo $100).', id ? { edit: id } : { nuevo: '1' });
    const int = (k: string) => { const v = get(k); if (!v) return null; const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : NaN; };
    const duracion = int('duration_min');
    const cupo = int('capacity');
    if (Number.isNaN(duracion) || Number.isNaN(cupo)) return conError('Duración y cupos deben ser números mayores que 0 (o vacíos).', id ? { edit: id } : { nuevo: '1' });

    let startsAt: string | null = null;
    if (type !== 'contenido') {
      startsAt = chileLocalAISO(get('starts_at'));
      if (!startsAt) return conError('Falta la fecha y hora (hora de Chile) del taller o charla.', id ? { edit: id } : { nuevo: '1' });
    }
    const archivo = get('digital_file_path');
    if (archivo && /^http:\/\//i.test(archivo)) return conError('El enlace del contenido debe empezar con https://', id ? { edit: id } : { nuevo: '1' });
    const meet = get('meet_url');
    if (meet && !/^https:\/\/\S+$/i.test(meet)) return conError('El enlace de Meet debe empezar con https://', id ? { edit: id } : { nuevo: '1' });

    const datos: Record<string, unknown> = {
      type, modality: type === 'contenido' ? 'online' : modality, title, slug,
      short_description: get('short_description').slice(0, 300) || null,
      description: String(form.get('description') ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 10000) || null,
      price: precio,
      starts_at: startsAt,
      duration_min: duracion,
      capacity: type === 'contenido' ? null : cupo,
      image_url: get('image_url') || null,
      digital_file_path: type === 'contenido' ? (archivo || null) : null,
      meet_url: type !== 'contenido' && modality === 'online' ? (meet || null) : null,
      visible: form.get('visible') === 'on',
      sort_order: Math.round(Number(get('sort_order') || '0')) || 0,
      updated_at: new Date().toISOString(),
    };

    let previo: VitrinaItem | null = null;
    if (id) {
      const { data } = await supabase.from('vitrina_items').select('*').eq('id', id).maybeSingle();
      previo = data as VitrinaItem | null;
      if (!previo) return conError('El item ya no existe.');
    }
    const op = id
      ? supabase.from('vitrina_items').update(datos).eq('id', id).select('*').single()
      : supabase.from('vitrina_items').insert(datos).select('*').single();
    const { data: guardado, error } = await op;
    if (error || !guardado) {
      const msg = error?.code === '23505' ? `Ya existe otro item con la dirección "${slug}".` : `No se guardó: ${error?.message ?? 'error desconocido'}`;
      return conError(msg, id ? { edit: id } : { nuevo: '1' });
    }
    await logInfo('vitrina/admin', `${id ? 'Editado' : 'Creado'}: ${title}`, { itemId: guardado.id });

    // Evento en Google Calendar (y Meet si es online) al publicar, o si cambió la hora.
    const item = guardado as VitrinaItem;
    let aviso = '';
    const cambioHora = previo && previo.starts_at !== item.starts_at;
    const cambioModalidad = previo && previo.modality !== item.modality;
    if (cambioModalidad && item.google_event_id) {
      aviso = 'Cambiaste la modalidad: revisa el evento en Google Calendar (el Meet no se agrega ni se quita solo).';
    }
    if (item.type !== 'contenido' && item.starts_at && ((item.visible && !item.google_event_id) || (cambioHora && item.google_event_id))) {
      const r = await sincronizarEventoItem(item);
      if (!r.ok) aviso = `Guardado, pero no se pudo crear/actualizar el evento de Google Calendar: ${r.error ?? ''}`;
    }
    return volver(aviso ? { ok: 'guardado', aviso, item: item.id } : { ok: 'guardado', item: item.id });
  }

  if (!/^[0-9a-f-]{36}$/i.test(id)) return conError('Falta el item.');
  const { data: fila } = await supabase.from('vitrina_items').select('*').eq('id', id).maybeSingle();
  const item = fila as VitrinaItem | null;
  if (!item) return conError('El item ya no existe.');

  if (action === 'toggle_visible') {
    const visible = !item.visible;
    const { error } = await supabase.from('vitrina_items').update({ visible, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return conError(`No se pudo cambiar: ${error.message}`);
    let aviso = '';
    if (visible && item.type !== 'contenido' && item.starts_at && !item.google_event_id) {
      const r = await sincronizarEventoItem({ ...item, visible });
      if (!r.ok) aviso = `Publicado, pero no se pudo crear el evento de Google Calendar: ${r.error ?? ''}`;
    }
    return volver(aviso ? { ok: visible ? 'publicado' : 'ocultado', aviso } : { ok: visible ? 'publicado' : 'ocultado' });
  }

  if (action === 'calendar') {
    const r = await sincronizarEventoItem(item);
    return r.ok ? volver({ ok: 'calendario', item: id }) : conError(`Google Calendar: ${r.error ?? 'no se pudo'}`, { item: id });
  }

  if (action === 'duplicate') {
    // Copia oculta, sin evento de calendario ni Meet (son de la fecha original).
    let slug = `${item.slug}-copia`.slice(0, 74);
    for (let n = 2; n < 50; n++) {
      const { data: existe } = await supabase.from('vitrina_items').select('id').eq('slug', slug).maybeSingle();
      if (!existe) break;
      slug = `${item.slug}-copia-${n}`.slice(0, 80);
    }
    const { id: _id, created_at: _c, updated_at: _u, google_event_id: _g, meet_url: _m, ...resto } = item;
    const { data: copia, error } = await supabase.from('vitrina_items')
      .insert({ ...resto, slug, title: `${item.title} (copia)`.slice(0, 160), visible: false })
      .select('id').single();
    if (error || !copia) return conError(`No se pudo duplicar: ${error?.message ?? ''}`);
    return volver({ ok: 'duplicado', edit: copia.id });
  }

  if (action === 'delete') {
    // Solo sin inscripciones (con inscripciones se oculta: quedan los registros de pago).
    const { count } = await supabase.from('vitrina_inscripciones').select('id', { count: 'exact', head: true }).eq('item_id', id);
    if ((count ?? 0) > 0) return conError('Tiene inscripciones: en vez de eliminarlo, ocúltalo.');
    const { error } = await supabase.from('vitrina_items').delete().eq('id', id);
    if (error) return conError(`No se pudo eliminar: ${error.message}`);
    if (item.google_event_id) {
      try {
        const auth = await getValidAccessToken();
        if (auth) await deleteCalendarEvent(auth.token, auth.calendarId, item.google_event_id);
      } catch { /* el evento queda en el calendario; se puede borrar a mano */ }
    }
    await logInfo('vitrina/admin', `Eliminado: ${item.title}`, { itemId: id });
    return volver({ ok: 'eliminado' });
  }

  return conError('Acción desconocida.');
};
