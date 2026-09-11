import type { APIRoute } from 'astro';
import { createMessageTemplate } from '../../../../lib/whatsapp';
import { supabase } from '../../../../lib/supabase';

export const prerender = false;

// POST /api/admin/whatsapp/create-template
// Envía una plantilla a revisión de Meta (queda "PENDING" hasta que la aprueben,
// normalmente en minutos a un día). Body: { name, bodyText, sampleValues[] }.
export const POST: APIRoute = async ({ request }) => {
  let body: Record<string, unknown> = {};
  try { body = await request.json(); } catch { /* form fallback abajo */ }
  if (!body.bodyText) {
    const form = await request.formData().catch(() => null);
    if (form) form.forEach((v, k) => { body[k] = String(v); });
  }

  const name     = String(body.name ?? '').trim();
  const bodyText = String(body.bodyText ?? '').trim();
  // 'reminder' (recordatorio 4h) o 'payment' (link de pago al reservar) — decide
  // en qué settings queda guardado el nombre, para que cada automatización use
  // la plantilla que le corresponde.
  const kind = body.kind === 'payment' ? 'payment' : 'reminder';
  const sampleValues = Array.isArray(body.sampleValues)
    ? (body.sampleValues as string[])
    : String(body.sampleValues ?? '').split('|').map(s => s.trim()).filter(Boolean);

  if (!name || !bodyText) {
    return json({ ok: false, error: 'Falta el nombre o el texto de la plantilla.' }, 400);
  }

  const res = await createMessageTemplate({ name, bodyText, sampleValues });
  if (!res.ok) return json({ ok: false, error: res.reason ?? 'No se pudo crear la plantilla.' }, 502);

  // Guarda el nombre para que la automatización correspondiente la use en cuanto
  // Meta la apruebe (el envío se intenta igual antes; si aún no está aprobada,
  // Meta lo rechaza con un motivo explícito y simplemente reintenta más tarde).
  await supabase.from('settings').upsert(
    [
      { key: `whatsapp_${kind}_template_name`, value: name, updated_at: new Date().toISOString() },
      { key: `whatsapp_${kind}_template_lang`,  value: 'es', updated_at: new Date().toISOString() },
    ],
    { onConflict: 'key' },
  );

  return json({ ok: true, id: res.id, status: res.status });
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
