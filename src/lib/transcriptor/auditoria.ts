// Bitácora de accesos del transcriptor (D41 art. 9; 30-seguridad §7.1; 10-etica-legal §4.10).
// Tabla transcriptor_auditoria: solo inserción (service_role tiene select+insert y un trigger
// rechaza update/delete/truncate). El detalle NUNCA lleva contenido clínico: las llaves que
// suenan a contenido se descartan antes de escribir.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccionAuditoria, ActorAuditoria, ResultadoAuditoria } from './tipos';

export interface OpcionesAuditoria {
  grabacionId?: string | null;
  patientId?: string | null;
  /** Si viene, se guardan IP (x-forwarded-for / x-real-ip) y user-agent. */
  request?: Request | null;
  /** IP conocida por Astro (clientAddress) si no hay cabecera. */
  clientAddress?: string | null;
  resultado?: ResultadoAuditoria;
  detalle?: Record<string, unknown> | null;
  cliente?: SupabaseClient;
}

/** Llaves prohibidas en `detalle` (podrían llevar texto de la sesión, de preguntas o secretos). */
const LLAVES_PROHIBIDAS = /^(texto|contenido|transcripcion|transcript|pregunta|respuesta|resumen|words|utterances|text|prompt|mensaje|audio_url|url|token|secret|clave|key)$/i;
const MAX_TEXTO = 300;

/** Limpia el detalle: quita llaves prohibidas (a cualquier profundidad) y acorta textos largos. */
export function sanearDetalle(detalle: unknown, profundidad = 0): unknown {
  if (detalle == null) return null;
  if (profundidad > 4) return '[omitido]';
  if (typeof detalle === 'string') return detalle.length > MAX_TEXTO ? `${detalle.slice(0, MAX_TEXTO)}…` : detalle;
  if (typeof detalle === 'number' || typeof detalle === 'boolean') return detalle;
  if (Array.isArray(detalle)) return detalle.slice(0, 50).map((x) => sanearDetalle(x, profundidad + 1));
  if (typeof detalle === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(detalle as Record<string, unknown>)) {
      if (LLAVES_PROHIBIDAS.test(k)) continue;
      out[k] = sanearDetalle(v, profundidad + 1);
    }
    return out;
  }
  return null;
}

export function ipDeRequest(request?: Request | null, clientAddress?: string | null): string | null {
  const xff = request?.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = xff || request?.headers.get('x-real-ip')?.trim() || clientAddress || null;
  return ip ? ip.slice(0, 100) : null;
}

/**
 * Registra una acción. Devuelve true si quedó escrita. No lanza: para lecturas de contenido
 * clínico usar `auditarObligatorio`, que sí corta el acceso si no se pudo registrar.
 */
export async function auditar(actor: ActorAuditoria, accion: AccionAuditoria, op: OpcionesAuditoria = {}): Promise<boolean> {
  try {
    const db = op.cliente ?? (await import('../supabase')).supabase;
    const fila = {
      actor,
      accion,
      resultado: op.resultado ?? 'ok',
      grabacion_id: op.grabacionId ?? null,
      patient_id: op.patientId ?? null,
      ip: ipDeRequest(op.request, op.clientAddress),
      user_agent: op.request?.headers.get('user-agent')?.slice(0, 500) ?? null,
      detalle: sanearDetalle(op.detalle ?? null),
    };
    const { error } = await db.from('transcriptor_auditoria').insert(fila);
    if (error) {
      console.warn('[transcriptor/auditoria] no se pudo registrar:', accion, error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[transcriptor/auditoria] no se pudo registrar:', accion, e instanceof Error ? e.message : e);
    return false;
  }
}

/** Igual que auditar, pero lanza si no se pudo registrar (ver transcripción, preguntar, exportar). */
export async function auditarObligatorio(actor: ActorAuditoria, accion: AccionAuditoria, op: OpcionesAuditoria = {}): Promise<void> {
  if (!(await auditar(actor, accion, op))) {
    throw new Error('No se pudo registrar el acceso en la bitácora; por seguridad no se muestra el contenido.');
  }
}
