// Transcriptor IA — "Excluir de las preguntas a la IA" a pedido del paciente (81-revision-etica-clinica H5).
// Se mantiene por decisión de Vale (02-decisiones-16oct-noche, C). La SUPRESIÓN de transcripciones se
// eliminó por completo (la ley exige conservar la ficha 15 años): este módulo reemplaza a supresion.ts
// y NO borra nada; solo marca grabaciones.excluir_ia_at + motivo (0019). preguntar.ts y
// contextoSesionAnterior dejan fuera esa sesión. Reversible solo por SQL (con constancia).
import type { SupabaseClient } from '@supabase/supabase-js';
import { auditar } from './auditoria';
import type { AccionAuditoria } from './tipos';

export const CANALES_PEDIDO = ['correo', 'whatsapp', 'presencial', 'otro'] as const;
export type CanalPedido = (typeof CANALES_PEDIDO)[number];

export interface PedidoExclusion { motivo: unknown; canal: unknown }
export type ErrorPedido = { ok: false; status: number; error: string };
export type ResultadoExclusion = { ok: true; mensaje: string } | ErrorPedido;

export const ACC_EXCLUIR = 'excluir_ia' as AccionAuditoria;

/** Valida motivo y canal (función pura). */
export function validarPedido(p: PedidoExclusion): { ok: true; motivo: string; canal: CanalPedido } | ErrorPedido {
  const motivo = typeof p.motivo === 'string' ? p.motivo.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  if (motivo.length < 10) return { ok: false, status: 400, error: 'Escribe el motivo (al menos 10 caracteres): quién lo pidió, cuándo y qué pidió.' };
  const canal = typeof p.canal === 'string' && (CANALES_PEDIDO as readonly string[]).includes(p.canal) ? (p.canal as CanalPedido) : null;
  if (!canal) return { ok: false, status: 400, error: 'Indica cómo lo pidió el paciente (correo, WhatsApp, en persona u otro).' };
  return { ok: true, motivo, canal };
}

export interface DepsExclusion {
  db: SupabaseClient;
  ahora?: () => Date;
  request?: Request;
  clientAddress?: string | null;
}

export async function excluirDeIA(grabacionId: string, patientId: string, pedido: PedidoExclusion, deps: DepsExclusion): Promise<ResultadoExclusion> {
  const v = validarPedido(pedido);
  if (!v.ok) return v;
  const { db } = deps;
  const { data: g, error: eg } = await db.from('grabaciones').select('id, patient_id, excluir_ia_at').eq('id', grabacionId).maybeSingle();
  if (eg) return { ok: false, status: 500, error: 'No se pudo leer la sesión. Intenta de nuevo.' };
  if (!g || (g as { patient_id: string | null }).patient_id !== patientId) return { ok: false, status: 404, error: 'No se encontró esta sesión en la ficha.' };
  if ((g as { excluir_ia_at?: string | null }).excluir_ia_at) return { ok: true, mensaje: 'Esta sesión ya estaba excluida de las preguntas a la IA.' };
  const { error } = await db.from('grabaciones').update({
    excluir_ia_at: (deps.ahora ?? (() => new Date()))().toISOString(), excluir_ia_motivo: `${v.motivo} (pedido por ${v.canal})`.slice(0, 600),
  }).eq('id', grabacionId).is('excluir_ia_at', null);
  if (error) return { ok: false, status: 500, error: error.code === '42703' ? 'Falta actualizar la base de datos (migración 0019).' : 'No se pudo guardar. Intenta de nuevo.' };
  await auditar('vale', ACC_EXCLUIR, { grabacionId, patientId, request: deps.request, clientAddress: deps.clientAddress ?? null, cliente: db, detalle: { canal: v.canal } });
  return { ok: true, mensaje: 'Listo: esta sesión ya no se usa en las preguntas a la IA ni como contexto de resúmenes nuevos. La transcripción y el resumen siguen en la ficha.' };
}
