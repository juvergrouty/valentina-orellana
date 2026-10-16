// Transcriptor IA — supresión de una transcripción y exclusión de la IA a pedido del paciente.
// 80-revision-seguridad M3 (Ley 21.719: supresión "en minutos", con rastro) y 81-revision-etica-clinica H5.
//
// suprimirTranscripcion (irreversible):
//   1. Exige motivo (≥ 10 caracteres) y canal por el que lo pidió el paciente.
//   2. Bitácora OBLIGATORIA antes de borrar (si no se puede registrar, no se borra nada).
//   3. Borra el objeto cifrado en R2 y TODAS sus versiones en B2 (almacenamiento.borrarTranscripcion).
//   4. Fila de transcripciones: deleted_at, motivo_borrado, borrado_canal y dek_envuelta = null
//      (borrado criptográfico de la copia de la DEK). La fila queda como prueba de que existió.
//   5. La grabación queda excluida de la IA (excluir_ia_at) y se borran las preguntas a la IA
//      que usaron esa sesión (no son parte de la ficha: 0014 §6).
//   El resumen automático (anexo de la ficha) NO se borra: el trigger de 0014 lo impide y la decisión
//   sobre el anexo es de Vale/abogada (ver 01-decisiones-16oct.md, "Resuelto 16 oct").
// excluirDeIA (reversible solo por SQL): marca excluir_ia_at + motivo; preguntar.ts y
//   contextoSesionAnterior la dejan fuera.
import type { SupabaseClient } from '@supabase/supabase-js';
import { auditar, auditarObligatorio } from './auditoria';
import type { AccionAuditoria } from './tipos';

export const CANALES_PEDIDO = ['correo', 'whatsapp', 'presencial', 'otro'] as const;
export type CanalPedido = (typeof CANALES_PEDIDO)[number];
/** Lo que Vale debe escribir para confirmar la supresión (confirmación escrita en la página, sin confirm()). */
export const FRASE_CONFIRMAR_SUPRESION = 'BORRAR';

export interface PedidoSupresion { motivo: unknown; canal: unknown; confirmacion?: unknown }

export type ErrorPedido = { ok: false; status: number; error: string };

/** Valida motivo/canal/confirmación (función pura). */
export function validarPedido(p: PedidoSupresion, exigirFrase: boolean): { ok: true; motivo: string; canal: CanalPedido } | ErrorPedido {
  const motivo = typeof p.motivo === 'string' ? p.motivo.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
  if (motivo.length < 10) return { ok: false, status: 400, error: 'Escribe el motivo (al menos 10 caracteres): quién lo pidió, cuándo y qué pidió.' };
  const canal = typeof p.canal === 'string' && (CANALES_PEDIDO as readonly string[]).includes(p.canal) ? (p.canal as CanalPedido) : null;
  if (!canal) return { ok: false, status: 400, error: 'Indica cómo lo pidió el paciente (correo, WhatsApp, en persona u otro).' };
  if (exigirFrase && String(p.confirmacion ?? '').trim().toUpperCase() !== FRASE_CONFIRMAR_SUPRESION) {
    return { ok: false, status: 400, error: `Para confirmar, escribe ${FRASE_CONFIRMAR_SUPRESION} en el recuadro.` };
  }
  return { ok: true, motivo, canal };
}

export interface DepsSupresion {
  db: SupabaseClient;
  almacenamiento: { borrarTranscripcion(key: string): Promise<void> };
  ahora?: () => Date;
  request?: Request;
  clientAddress?: string | null;
}

export type ResultadoSupresion = { ok: true; mensaje: string } | ErrorPedido;

const ACC_SUPRIMIR = 'borrar_transcripcion' as AccionAuditoria;
const ACC_EXCLUIR = 'excluir_ia' as AccionAuditoria;

export async function suprimirTranscripcion(grabacionId: string, patientId: string, pedido: PedidoSupresion, deps: DepsSupresion): Promise<ResultadoSupresion> {
  const v = validarPedido(pedido, true);
  if (!v.ok) return v;
  const { db } = deps;
  const ahora = (deps.ahora ?? (() => new Date()))().toISOString();
  const { data: g, error: eg } = await db.from('grabaciones').select('id, patient_id, excluir_ia_at').eq('id', grabacionId).maybeSingle();
  if (eg) return { ok: false, status: 500, error: 'No se pudo leer la sesión. Intenta de nuevo.' };
  if (!g || (g as { patient_id: string | null }).patient_id !== patientId) return { ok: false, status: 404, error: 'No se encontró esta sesión en la ficha.' };
  const { data: tr, error: et } = await db.from('transcripciones').select('id, r2_key').eq('grabacion_id', grabacionId).is('deleted_at', null).maybeSingle();
  if (et) return { ok: false, status: 500, error: 'No se pudo leer la transcripción. Intenta de nuevo.' };
  if (!tr) return { ok: false, status: 409, error: 'Esta sesión ya no tiene transcripción guardada.' };
  const t = tr as { id: string; r2_key: string };
  const base = { grabacionId, patientId, request: deps.request, clientAddress: deps.clientAddress ?? null, cliente: db };

  try {
    await auditarObligatorio('vale', ACC_SUPRIMIR, { ...base, detalle: { fase: 'inicio', transcripcion_id: t.id, canal: v.canal, largo_motivo: v.motivo.length } });
  } catch {
    return { ok: false, status: 503, error: 'No se pudo registrar el pedido en la bitácora; por seguridad no se borró nada. Intenta de nuevo.' };
  }
  try {
    await deps.almacenamiento.borrarTranscripcion(t.r2_key);
  } catch (e) {
    await auditar('vale', ACC_SUPRIMIR, { ...base, resultado: 'error', detalle: { fase: 'almacenamiento', error: e instanceof Error ? e.name : 'error' } });
    return { ok: false, status: 502, error: 'No se pudo borrar el archivo cifrado (R2/B2). No se marcó como borrada; intenta de nuevo en unos minutos.' };
  }
  const { error: eu } = await db.from('transcripciones').update({
    deleted_at: ahora, motivo_borrado: v.motivo, borrado_canal: v.canal, dek_envuelta: null,
  }).eq('id', t.id).is('deleted_at', null);
  if (eu) {
    await auditar('vale', ACC_SUPRIMIR, { ...base, resultado: 'error', detalle: { fase: 'fila', codigo: eu.code ?? null } });
    return { ok: false, status: 500, error: 'El archivo se borró, pero no se pudo marcar en la base. Vuelve a intentarlo (es seguro repetirlo).' };
  }
  if (!(g as { excluir_ia_at?: string | null }).excluir_ia_at) {
    await db.from('grabaciones').update({ excluir_ia_at: ahora, excluir_ia_motivo: 'Transcripción suprimida a pedido del paciente' }).eq('id', grabacionId);
  }
  // Preguntas a la IA que usaron esta sesión (contienen texto derivado; no son parte de la ficha).
  let preguntas = 0;
  const { data: ps } = await db.from('preguntas_ia').select('id, grabacion_ids').eq('patient_id', patientId);
  const ids = ((ps ?? []) as { id: string; grabacion_ids: string[] | null }[]).filter((p) => (p.grabacion_ids ?? []).includes(grabacionId)).map((p) => p.id);
  if (ids.length) {
    const { error: ep } = await db.from('preguntas_ia').delete().in('id', ids);
    if (!ep) preguntas = ids.length;
  }
  await auditar('vale', ACC_SUPRIMIR, { ...base, detalle: { fase: 'listo', transcripcion_id: t.id, canal: v.canal, preguntas_borradas: preguntas } });
  return { ok: true, mensaje: 'Listo: la transcripción se borró de R2 y de todas las copias en B2. Queda constancia en la bitácora.' };
}

export async function excluirDeIA(grabacionId: string, patientId: string, pedido: PedidoSupresion, deps: DepsSupresion): Promise<ResultadoSupresion> {
  const v = validarPedido(pedido, false);
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
  return { ok: true, mensaje: 'Listo: esta sesión ya no se usa en las preguntas a la IA ni como contexto de resúmenes nuevos.' };
}
