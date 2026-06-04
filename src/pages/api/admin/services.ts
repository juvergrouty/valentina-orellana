import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const form     = await request.formData();
  const action   = form.get('action') as string;
  const redirect = (form.get('redirect') as string) ?? '/admin/servicios';

  const get = (k: string) => (form.get(k) as string)?.trim() || null;

  if (action === 'create' || action === 'update') {
    const data = {
      name:         get('name')!,
      description:  get('description'),
      type:         get('type') ?? 'individual',
      modality:     get('modality') ?? 'presencial',
      location:     get('location'),
      duration_min: parseInt(get('duration_min') ?? '50'),
      price:        parseInt(get('price') ?? '0'),
      visible:      form.get('visible') === 'on',
      show_home:    form.get('show_home') === 'on',
      image_url:    get('image_url'),
      sort_order:   parseInt(get('sort_order') ?? '0'),
    };

    if (action === 'create') {
      const { error } = await supabase.from('services_catalog').insert(data);
      if (error) console.error('[services] create:', error.message);
    } else {
      const id = get('id')!;
      const { error } = await supabase.from('services_catalog').update(data).eq('id', id);
      if (error) console.error('[services] update:', error.message);
    }
  }

  if (action === 'delete') {
    const id = get('id')!;
    await supabase.from('services_catalog').delete().eq('id', id);
  }

  if (action === 'toggle_visible') {
    const id      = get('id')!;
    const current = form.get('current') === 'true';
    await supabase.from('services_catalog').update({ visible: !current }).eq('id', id);
  }

  if (action === 'toggle_home') {
    const id      = get('id')!;
    const current = form.get('current') === 'true';
    await supabase.from('services_catalog').update({ show_home: !current }).eq('id', id);
  }

  if (action === 'duplicate') {
    const id = get('id')!;
    const { data: orig } = await supabase.from('services_catalog').select('*').eq('id', id).single();
    if (orig) {
      const { id: _id, created_at, ...rest } = orig;
      await supabase.from('services_catalog').insert({ ...rest, name: rest.name + ' (copia)' });
    }
  }

  return new Response(null, { status: 302, headers: { Location: redirect } });
};
