// Lectura del aviso (webhook) de WhatsApp Cloud API: puro, sin base de datos (webhookWhatsapp.test.ts).
// Del cuerpo de cada mensaje solo se usa, en memoria, si trae el código del sitio; NO se guarda.
// Formatos según la documentación de Meta (webhooks/reference/messages y smb_message_echoes):
//  - field "messages":           value.contacts[{ profile.name, wa_id }], value.messages[{ from, timestamp, type, text.body, referral }]
//  - field "smb_message_echoes": value.message_echoes[{ from (número de Vale), to (la persona), timestamp, type }]
import { createHmac, timingSafeEqual } from 'node:crypto';
import { detectarCodigo, normalizarTelefono } from './reglas';

/** X-Hub-Signature-256: "sha256=" + HMAC-SHA256 (hex) del cuerpo crudo con el secreto de la app. */
export function firmaWhatsappValida(cuerpo: string, cabecera: string | null, secreto: string | undefined): boolean {
  if (!secreto || !cabecera || !cabecera.startsWith('sha256=')) return false;
  const dada = Buffer.from(cabecera.slice(7).trim().toLowerCase());
  const esperada = Buffer.from(createHmac('sha256', secreto).update(cuerpo, 'utf8').digest('hex'));
  return dada.length === esperada.length && timingSafeEqual(dada, esperada);
}

export type EventoWhatsapp =
  | { tipo: 'entrante'; telefono: string; nombre: string | null; at: string; anuncio: boolean; codigo: string | null }
  | { tipo: 'respuesta_vale'; telefono: string; at: string };

const fechaDe = (ts: unknown): string => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString();
};

type Valor = {
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: { from?: string; timestamp?: string; type?: string; text?: { body?: string }; button?: { text?: string }; referral?: unknown }[];
  message_echoes?: { to?: string; timestamp?: string; type?: string }[];
};

export function leerEventosWhatsapp(payload: unknown): EventoWhatsapp[] {
  const out: EventoWhatsapp[] = [];
  const p = payload as { object?: string; entry?: { changes?: { field?: string; value?: Valor }[] }[] };
  if (!p || p.object !== 'whatsapp_business_account' || !Array.isArray(p.entry)) return out;
  for (const entry of p.entry) {
    for (const ch of entry?.changes ?? []) {
      const v = ch?.value ?? {};
      if (ch?.field === 'messages') {
        for (const m of v.messages ?? []) {
          const telefono = normalizarTelefono(m.from);
          if (!telefono) continue;
          const contacto = (v.contacts ?? []).find((c) => normalizarTelefono(c.wa_id) === telefono) ?? (v.contacts ?? [])[0];
          const nombre = String(contacto?.profile?.name ?? '').trim().slice(0, 120) || null;
          const texto = m.type === 'text' ? m.text?.body : m.type === 'button' ? m.button?.text : '';
          out.push({ tipo: 'entrante', telefono, nombre, at: fechaDe(m.timestamp), anuncio: !!m.referral && typeof m.referral === 'object', codigo: detectarCodigo(texto) });
        }
      } else if (ch?.field === 'smb_message_echoes') {
        for (const e of v.message_echoes ?? []) {
          // Borrar o editar un mensaje no es una respuesta nueva.
          if (e.type === 'revoke' || e.type === 'edit') continue;
          const telefono = normalizarTelefono(e.to);
          if (telefono) out.push({ tipo: 'respuesta_vale', telefono, at: fechaDe(e.timestamp) });
        }
      }
    }
  }
  return out;
}
