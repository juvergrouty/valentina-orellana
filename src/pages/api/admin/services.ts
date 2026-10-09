import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { todayCL } from '../../../lib/dateUtils';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form     = await request.formData();
  const action   = form.get('action') as string;
  // Solo rutas internas (8 oct 2026): antes se usaba tal cual venía del formulario.
  const redirect = rutaInterna(form.get('redirect'), '/admin/servicios');

  const get = (k: string) => (form.get(k) as string)?.trim() || null;

  // Vuelta con aviso de error visible (8 oct 2026): antes una falla al
  // guardar o eliminar volvía igual que un éxito ("✓ Servicio guardado").
  const conError = (codigo: string, detalle?: string) => {
    const u = new URL(redirect, 'http://local');
    u.searchParams.delete('saved');
    u.searchParams.set('error', codigo);
    if (detalle) u.searchParams.set('detail', detalle.slice(0, 200));
    return new Response(null, { status: 302, headers: { Location: u.pathname + '?' + u.searchParams.toString() } });
  };

  if (action === 'create' || action === 'update') {
    const modality = get('modality') ?? 'presencial';
    const isAmbos  = modality === 'ambos';

    const priceOnline     = parseInt(get('price_online')        ?? '0')  || 0;
    const pricePresencial = parseInt(get('price_presencial')    ?? '0')  || 0;
    const durOnline       = parseInt(get('duration_min_online') ?? '50') || 50;
    const durPresencial   = parseInt(get('duration_min_presencial') ?? '50') || 50;

    // Para "ambos": price = presencial como columna principal (fallback para bookings sin migration)
    const mainPrice = isAmbos ? (pricePresencial || priceOnline) : (parseInt(get('price') ?? '0') || 0);
    const mainDur   = isAmbos ? (durPresencial || durOnline)     : (parseInt(get('duration_min') ?? '50') || 50);

    const data: Record<string, unknown> = {
      name:                    get('name')!,
      description:             get('description'),
      type:                    get('type') ?? 'individual',
      modality,
      location:                get('location'),
      price:                   mainPrice,
      duration_min:            mainDur,
      price_online:            isAmbos ? priceOnline     : null,
      price_presencial:        isAmbos ? pricePresencial : null,
      duration_min_online:     isAmbos ? durOnline        : null,
      duration_min_presencial: isAmbos ? durPresencial    : null,
      visible:                 form.get('visible') === 'on',
      show_home:               form.get('show_home') === 'on',
      image_url:               get('image_url'),
      sort_order:              parseInt(get('sort_order') ?? '0'),
      fonasa_description:      get('fonasa_description') || null,  // = glosa de la boleta
      boleta_auto:             form.get('boleta_auto') === 'on',
      min_hours:               get('min_hours') ? parseInt(get('min_hours')!) : null,
      waitlist:                form.get('waitlist') === 'on',
      prepago:                 form.get('prepago') === 'on',
      pago_requerido:          form.get('pago_requerido') === 'on',
    };

    // Columnas que requieren la migration SQL
    const newCols = ['price_online', 'price_presencial', 'duration_min_online', 'duration_min_presencial',
                     'fonasa_description', 'boleta_auto', 'min_hours', 'waitlist', 'prepago', 'pago_requerido'];
    const basicData = Object.fromEntries(Object.entries(data).filter(([k]) => !newCols.includes(k)));

    // Devuelve el mensaje de error si no se pudo guardar (null = guardado).
    const saveRow = async (payload: Record<string, unknown>, id?: string): Promise<string | null> => {
      const op = id
        ? supabase.from('services_catalog').update(payload).eq('id', id)
        : supabase.from('services_catalog').insert(payload);
      const { error } = await op;
      if (error) {
        if (error.code === '42703') {
          // Columnas nuevas no existen todavía → guardar sin ellas (SQL migration pendiente)
          const op2 = id
            ? supabase.from('services_catalog').update(basicData).eq('id', id)
            : supabase.from('services_catalog').insert(basicData);
          const { error: e2 } = await op2;
          if (e2) { console.error('[services] save fallback:', e2.message); return e2.message; }
        } else {
          console.error('[services] save:', error.message);
          return error.message;
        }
      }
      return null;
    };

    const fallo = action === 'create' ? await saveRow(data) : await saveRow(data, get('id')!);
    if (fallo) return conError('servicio_guardar', fallo);
  }

  if (action === 'delete') {
    const id = get('id')!;
    // Con sesiones futuras agendadas no se elimina (8 oct 2026): antes se les
    // quitaba el servicio y quedaban sin precio/duración de referencia.
    const { count: futuras, error: futErr } = await supabase.from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('service_id', id)
      .gte('session_date', todayCL()).neq('session_date', '2099-12-31')
      .not('status', 'in', '(cancelled,expired)');
    if (futErr) return conError('servicio_eliminar', futErr.message);
    if ((futuras ?? 0) > 0) return conError('servicio_con_sesiones');

    // Quitar la referencia en reservas para no violar el foreign key (conserva el historial).
    // Se guardan cuáles eran para devolverles el servicio si el borrado falla.
    const { data: vinculadas, error: selErr } = await supabase.from('bookings').select('id').eq('service_id', id);
    if (selErr) return conError('servicio_eliminar', selErr.message);
    const ids = (vinculadas ?? []).map((b: { id: string }) => b.id);
    if (ids.length) {
      const { error: unlinkErr } = await supabase.from('bookings').update({ service_id: null }).eq('service_id', id);
      if (unlinkErr) return conError('servicio_eliminar', unlinkErr.message);
    }
    const { error } = await supabase.from('services_catalog').delete().eq('id', id);
    if (error) {
      console.error('[services] delete:', error.message, error.code);
      // De a 100 para no armar una consulta demasiado larga.
      for (let i = 0; i < ids.length; i += 100) {
        const { error: restErr } = await supabase.from('bookings').update({ service_id: id }).in('id', ids.slice(i, i + 100));
        if (restErr) console.error('[services] delete restaurar vínculos:', restErr.message);
      }
      return conError('servicio_eliminar', error.message);
    }
  }

  if (action === 'toggle_visible') {
    const id      = get('id')!;
    const current = form.get('current') === 'true';
    // Error visible (8 oct 2026): antes volvía como si se hubiera cambiado.
    const { error } = await supabase.from('services_catalog').update({ visible: !current }).eq('id', id);
    if (error) return conError('servicio_guardar', error.message);
  }

  if (action === 'toggle_home') {
    const id      = get('id')!;
    const current = form.get('current') === 'true';
    const { error } = await supabase.from('services_catalog').update({ show_home: !current }).eq('id', id);
    if (error) return conError('servicio_guardar', error.message);
  }

  if (action === 'duplicate') {
    const id = get('id');
    if (!id) return new Response(null, { status: 302, headers: { Location: redirect } });

    const { data: orig, error: fetchErr } = await supabase
      .from('services_catalog').select('*').eq('id', id).single();

    if (fetchErr || !orig) {
      console.error('[services] duplicate fetch:', fetchErr?.message);
      return new Response(null, { status: 302, headers: { Location: redirect } });
    }

    // Extraer solo los campos del servicio (sin id ni created_at)
    const { error: insertErr } = await supabase.from('services_catalog').insert({
      name:                    orig.name + ' (copia)',
      description:             orig.description,
      type:                    orig.type,
      modality:                orig.modality,
      location:                orig.location,
      duration_min:            orig.duration_min,
      price:                   orig.price,
      price_online:            orig.price_online,
      price_presencial:        orig.price_presencial,
      duration_min_online:     orig.duration_min_online,
      duration_min_presencial: orig.duration_min_presencial,
      visible:                 orig.visible,
      show_home:               orig.show_home,
      image_url:               orig.image_url,
      sort_order:              (orig.sort_order ?? 0) + 1,
    });

    if (insertErr) {
      console.error('[services] duplicate insert:', insertErr.message, insertErr.code);
      return conError('servicio_guardar', insertErr.message); // visible (8 oct 2026)
    }
  }

  return new Response(null, { status: 302, headers: { Location: redirect } });
};
