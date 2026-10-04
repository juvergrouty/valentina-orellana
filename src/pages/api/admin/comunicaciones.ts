import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendBulkEmail } from '../../../lib/email';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

export const POST: APIRoute = async ({ request, redirect }) => {
  const form    = await request.formData();
  const action  = form.get('action')?.toString();
  const dest    = rutaInterna(form.get('redirect'), '/admin/comunicaciones');

  if (action === 'send-bulk') {
    const subject = form.get('subject')?.toString().trim() ?? '';
    const body    = form.get('body')?.toString().trim() ?? '';
    const target  = form.get('target')?.toString() ?? 'activos'; // activos | todos | seleccion
    const selRaw  = form.get('selected')?.toString() ?? '';

    if (!subject || !body) return redirect(dest + '?error=missing');

    // Solo dos destinos válidos. Antes, "Selección manual" sin marcar a nadie
    // (o cualquier otro valor) mandaba el correo a TODA la base de pacientes,
    // incluidos archivados y de prueba.
    if (target !== 'activos' && target !== 'seleccion') return redirect(dest + '?error=target');
    const elegidos = new Set(selRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
    if (target === 'seleccion' && !elegidos.size) return redirect(dest + '?error=none_selected');

    // Resolver destinatarios: siempre entre pacientes activos con correo.
    const { data: patients } = await supabase.from('patients').select('name, email').eq('active', true);
    let recipients = (patients ?? []).filter(p => p.email);
    if (target === 'seleccion') recipients = recipients.filter(p => elegidos.has((p.email ?? '').toLowerCase()));
    if (!recipients.length) return redirect(dest + '?error=none_selected');

    // El texto se escapa (un "<" ya no rompe el correo) y los saltos de línea pasan a <br>.
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const bodyHtml = esc(body).replace(/\n/g, '<br>');

    const result = await sendBulkEmail(
      recipients.map(r => ({ name: r.name, email: r.email as string })),
      subject,
      bodyHtml,
    );

    // Registrar el envío (si la tabla existe)
    await supabase.from('bulk_emails' as never).insert({
      subject,
      body,
      target,
      sent_count:    result.sent,
      failed_count:  result.failed,
    } as never).then(({ error }) => {
      if (error && error.code !== '42P01') console.error('[comunicaciones] log:', error.message);
    });

    return redirect(`${dest}?sent=${result.sent}&failed=${result.failed}`);
  }

  return redirect(dest);
};
