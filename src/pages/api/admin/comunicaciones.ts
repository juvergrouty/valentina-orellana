import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { sendBulkEmail } from '../../../lib/email';

export const prerender = false;

export const POST: APIRoute = async ({ request, redirect }) => {
  const form    = await request.formData();
  const action  = form.get('action')?.toString();
  const dest    = form.get('redirect')?.toString() ?? '/admin/comunicaciones';

  if (action === 'send-bulk') {
    const subject = form.get('subject')?.toString().trim() ?? '';
    const body    = form.get('body')?.toString().trim() ?? '';
    const target  = form.get('target')?.toString() ?? 'activos'; // activos | todos | seleccion
    const selRaw  = form.get('selected')?.toString() ?? '';

    if (!subject || !body) return redirect(dest + '?error=missing');

    // Resolver destinatarios
    let query = supabase.from('patients').select('name, email');
    if (target === 'activos') query = query.eq('active', true);
    const { data: patients } = await query;

    let recipients = (patients ?? []).filter(p => p.email);
    if (target === 'seleccion' && selRaw) {
      const emails = new Set(selRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
      recipients = recipients.filter(p => emails.has((p.email ?? '').toLowerCase()));
    }

    // Convertir saltos de línea a <br>
    const bodyHtml = body.replace(/\n/g, '<br>');

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
