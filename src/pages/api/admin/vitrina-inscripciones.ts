import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { logInfo } from '../../../lib/logger';
import { enviarConfirmacion } from '../../../lib/vitrina';
import { filaCSV, ESTADO_LABEL, type VitrinaEstado } from '../../../lib/vitrinaUtils';
import { origenTexto } from '../../../lib/origen';

export const prerender = false;

// POST /api/admin/vitrina-inscripciones — acciones sobre una inscripción:
//   marcar_pagado (pagó por otro medio; envía la confirmación), cancelar,
//   reenviar (vuelve a mandar la confirmación con un link de descarga nuevo).
export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const id = String(form.get('id') ?? '').trim();
  const itemId = String(form.get('item_id') ?? '').trim();
  const volver = (p: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/admin/vitrina?${new URLSearchParams({ item: itemId, ...p }).toString()}` } });

  if (!/^[0-9a-f-]{36}$/i.test(id)) return volver({ error: 'Falta la inscripción.' });
  const { data: insc } = await supabase.from('vitrina_inscripciones').select('*').eq('id', id).maybeSingle();
  if (!insc) return volver({ error: 'La inscripción ya no existe.' });

  if (action === 'marcar_pagado') {
    if (insc.status === 'paid' || insc.status === 'free') return volver({ error: 'Ya estaba confirmada.' });
    const medio = String(form.get('medio') ?? '').trim().slice(0, 60) || 'Pago manual';
    const { data: upd, error } = await supabase.from('vitrina_inscripciones')
      .update({ status: 'paid', paid_at: new Date().toISOString(), payment_note: medio })
      .eq('id', id).is('paid_at', null).select('id');
    if (error) return volver({ error: `No se pudo marcar: ${error.message}` });
    if (!upd?.length) return volver({ error: 'Esa inscripción ya tenía un pago registrado.' });
    await logInfo('vitrina/admin', `Marcada pagada a mano (${medio}): ${insc.name}`, { inscripcionId: id });
    const r = await enviarConfirmacion(id);
    return volver(r.sent ? { ok: 'pagada' } : { ok: 'pagada', aviso: `Quedó pagada, pero el correo no salió: ${r.reason ?? ''}` });
  }

  if (action === 'cancelar') {
    if (insc.status === 'cancelled') return volver({ error: 'Ya estaba cancelada.' });
    const { error } = await supabase.from('vitrina_inscripciones').update({ status: 'cancelled' }).eq('id', id);
    if (error) return volver({ error: `No se pudo cancelar: ${error.message}` });
    await logInfo('vitrina/admin', `Inscripción cancelada: ${insc.name}`, { inscripcionId: id, estabaPagada: !!insc.paid_at });
    return volver(insc.paid_at
      ? { ok: 'cancelada', aviso: 'Cancelada. Ojo: estaba pagada; si corresponde, devuelve el pago desde Flow o por transferencia.' }
      : { ok: 'cancelada' });
  }

  if (action === 'reenviar') {
    const r = await enviarConfirmacion(id, { forzar: true });
    return r.sent ? volver({ ok: 'reenviada' }) : volver({ error: `No se pudo reenviar: ${r.reason ?? ''}` });
  }

  return volver({ error: 'Acción desconocida.' });
};

// GET /api/admin/vitrina-inscripciones?item=<id> — CSV de inscripciones del item.
export const GET: APIRoute = async ({ url }) => {
  const itemId = url.searchParams.get('item') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return new Response('Falta el item', { status: 400 });
  const { data: item } = await supabase.from('vitrina_items').select('slug, title').eq('id', itemId).maybeSingle();
  if (!item) return new Response('Item no encontrado', { status: 404 });
  const { data: filas, error } = await supabase.from('vitrina_inscripciones').select('*').eq('item_id', itemId).order('created_at');
  if (error) return new Response(`Error: ${error.message}`, { status: 500 });

  const cl = (iso: string | null) => iso ? new Date(iso).toLocaleString('es-CL', { timeZone: 'America/Santiago' }) : '';
  const lineas = [
    filaCSV(['Nombre', 'Correo', 'Teléfono', 'Estado', 'Monto', 'Pago', 'Orden Flow', 'Pagado el', 'Inscrita el', 'Origen']),
    ...(filas ?? []).map((i) => filaCSV([
      i.name, i.email, i.phone, ESTADO_LABEL[i.status as VitrinaEstado] ?? i.status, i.amount, i.payment_note ?? '',
      i.flow_order ?? '', cl(i.paid_at), cl(i.created_at), origenTexto(i.origen) ?? '',
    ])),
  ];
  // BOM para que Excel lea bien las tildes.
  return new Response('﻿' + lineas.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="inscripciones-${item.slug}.csv"`,
    },
  });
};
