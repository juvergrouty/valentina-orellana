// Pruebas del aviso (webhook) de WhatsApp (18 nov 2026). Correr: pnpm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { firmaWhatsappValida, leerEventosWhatsapp } from './webhookWhatsapp';

test('firma X-Hub-Signature-256: válida, inválida y sin secreto (falla cerrado)', () => {
  const cuerpo = '{"object":"whatsapp_business_account"}';
  const firma = 'sha256=' + createHmac('sha256', 'secreto').update(cuerpo).digest('hex');
  assert.equal(firmaWhatsappValida(cuerpo, firma, 'secreto'), true);
  assert.equal(firmaWhatsappValida(cuerpo + ' ', firma, 'secreto'), false);
  assert.equal(firmaWhatsappValida(cuerpo, firma, 'otro'), false);
  assert.equal(firmaWhatsappValida(cuerpo, firma, undefined), false);
  assert.equal(firmaWhatsappValida(cuerpo, null, 'secreto'), false);
  assert.equal(firmaWhatsappValida(cuerpo, firma.slice(7), 'secreto'), false);
});

const envolver = (field: string, value: unknown) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field, value }] }] });

test('mensaje entrante desde un anuncio (referral) y con código del sitio', () => {
  const ev = leerEventosWhatsapp(envolver('messages', {
    messaging_product: 'whatsapp',
    contacts: [{ wa_id: '56912345678', profile: { name: 'Camila Rojas' } }],
    messages: [
      { from: '56912345678', id: 'a', timestamp: '1763470800', type: 'text', text: { body: 'Hola, vi su anuncio' }, referral: { source_type: 'ad', source_id: '1', ctwa_clid: 'x' } },
      { from: '56912345678', id: 'b', timestamp: '1763470900', type: 'text', text: { body: 'Hola Valentina. (código G-7K3Q)' } },
      { from: '56912345678', id: 'c', timestamp: '1763471000', type: 'image' },
    ],
  }));
  assert.equal(ev.length, 3);
  assert.deepEqual(ev[0], { tipo: 'entrante', telefono: '56912345678', nombre: 'Camila Rojas', at: new Date(1763470800 * 1000).toISOString(), anuncio: true, codigo: null });
  assert.equal(ev[1].tipo === 'entrante' && ev[1].codigo, 'G-7K3Q');
  assert.equal(ev[2].tipo === 'entrante' && (ev[2].anuncio || !!ev[2].codigo), false);
  // Nunca se devuelve el texto del mensaje.
  assert.doesNotMatch(JSON.stringify(ev), /vi su anuncio/);
});

test('respuesta de Vale desde la app (smb_message_echoes); borrar o editar no cuenta', () => {
  const ev = leerEventosWhatsapp(envolver('smb_message_echoes', {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '56972735696', phone_number_id: '1' },
    message_echoes: [
      { from: '56972735696', to: '56912345678', id: 'x', timestamp: '1763471000', type: 'text', text: { body: 'Hola Camila' } },
      { from: '56972735696', to: '56912345678', id: 'y', timestamp: '1763471100', type: 'revoke' },
    ],
  }));
  assert.deepEqual(ev, [{ tipo: 'respuesta_vale', telefono: '56912345678', at: new Date(1763471000 * 1000).toISOString() }]);
});

test('otros avisos (estados de entrega, objeto distinto) se ignoran', () => {
  assert.deepEqual(leerEventosWhatsapp(envolver('messages', { statuses: [{ id: 'x', status: 'delivered' }] })), []);
  assert.deepEqual(leerEventosWhatsapp({ object: 'page', entry: [] }), []);
  assert.deepEqual(leerEventosWhatsapp(null), []);
});
