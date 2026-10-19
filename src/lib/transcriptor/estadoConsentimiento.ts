// Indicador "Sin consentimiento firmado" (pedido de Vale, 19 oct 2026: "muéstrame siempre cuando un
// paciente no tiene el consentimiento firmado"). Lo usan la lista de pacientes, la cabecera de la ficha,
// la agenda (bloques y panel lateral de cada sesión, presencial y online), el calendario y el grabador.
//
// NO es una regla nueva: combina las dos que ya existen, para no duplicar lógica.
//   • "¿Firmó?" = el consentimiento propio vigente de la persona agendada (vigentePropio, la misma regla
//     que el aviso permanente del panel y la franja Pendientes; consent.ts → vigente la reutiliza).
//   • "¿Autoriza grabar?" = evaluarConsentimientos de consentimiento.ts (la MISMA del grabador y del
//     robot), sin mirar la edad: el indicador habla solo del consentimiento.
//   • "¿Es de pareja?" = fichaEsPareja / esReservaPareja (regla única de consentimiento.ts y pareja.ts).
// Estados:
//   sin_firma      → "Sin consentimiento firmado"
//   falta_pareja   → "Falta el consentimiento de la pareja" (ficha de pareja sin la 2.ª firma vigente)
//   sin_grabacion  → "Consentimiento sin autorización de grabación" (firmó, pero no autoriza grabar,
//                    o retiró solo la grabación)
//   firmado        → sin indicador
// Solo expone el estado (ningún dato clínico ni texto del consentimiento). Pruebas en
// estadoConsentimiento.test.ts.
import type { SupabaseClient } from '@supabase/supabase-js';
import { evaluarConsentimientos, fichaEsPareja, type FilaConsentimiento } from './consentimiento';
import { esReservaPareja, estadoPareja, soloPersona1, type InfoServicio, type ReservaMinima } from './pareja';
import type { EstadoConsentimiento } from './etiquetaConsentimiento';
export {
  ETIQUETA_CONSENTIMIENTO, claseConsentimiento, etiquetaConsentimiento, hrefEnviarConsentimiento, textoEnlaceConsentimiento,
  type EstadoConsentimiento,
} from './etiquetaConsentimiento';

/** Fila mínima: la de consentimiento.ts más lo que usa el consentimiento propio. */
export type FilaEstado = FilaConsentimiento & { accept_treatment?: boolean | null; persona?: number | null; patient_id?: string | null };

/**
 * Consentimiento vigente de la persona agendada (persona 1): el último firmado aceptando el tratamiento,
 * si no fue retirado. La firma de la pareja (persona 2) nunca tapa la falta del propio.
 * Es LA regla de consent.ts → vigente (que la reutiliza); vive aquí porque es pura (sin base de datos).
 */
export function vigentePropio<T extends { signed_at: string | null; accept_treatment?: boolean | null; revoked_at: string | null; persona?: number | null }>(rows: T[]): T | null {
  const firmados = soloPersona1(rows).filter((r) => r.signed_at && r.accept_treatment)
    .sort((a, b) => (b.signed_at ?? '').localeCompare(a.signed_at ?? ''));
  const ultimo = firmados[0];
  return ultimo && !ultimo.revoked_at ? ultimo : null;
}

export interface EntradaEstado {
  filas: FilaEstado[];
  /** La ficha es de pareja (regla única). */
  fichaPareja: boolean;
  /** Para reconocer a la persona agendada en parejas antiguas (estadoPareja). */
  rut?: string | null;
  nombre?: string | null;
}

/** Estado del consentimiento de una ficha (función pura). */
export function estadoConsentimiento(e: EntradaEstado): EstadoConsentimiento {
  if (!vigentePropio(e.filas)) return 'sin_firma';
  if (e.fichaPareja && !estadoPareja(e.filas, e.rut, e.nombre).firma) return 'falta_pareja';
  // Misma evaluación del grabador; la edad no se mira aquí (fechaNacimiento null).
  const v = evaluarConsentimientos({
    patientId: 'ficha', tipo: 'individual', fichaPareja: e.fichaPareja, fechaNacimiento: null, filas: e.filas, hoy: '2000-01-01',
  });
  if (v.puede) return 'firmado';
  return v.motivo === 'falta_segunda_firma' ? 'falta_pareja' : 'sin_grabacion';
}

// ─── Con base de datos (en lote, para listas) ────────────────────────────────

export interface FichaMinima { id: string; name?: string | null; email?: string | null; rut?: string | null }

const LOTE = 150;
const trozos = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function db(cliente?: SupabaseClient): Promise<SupabaseClient> {
  return cliente ?? (await import('../supabase')).supabase;
}

/**
 * Estado del consentimiento de varias fichas con pocas consultas (consents de esas fichas, reservas que
 * dicen "pareja", servicios y grabaciones de pareja). Lanza si no se pueden leer los consentimientos
 * (quien llama decide: las páginas no muestran el indicador antes que mostrar uno falso). Si fallan las
 * señales de pareja, nunca se dice "firmado" (esa ficha queda sin estado); lo que falta se sigue mostrando.
 */
export async function estadosConsentimientoEnBase(fichas: FichaMinima[], cliente?: SupabaseClient): Promise<Map<string, EstadoConsentimiento>> {
  const out = new Map<string, EstadoConsentimiento>();
  const unicas = [...new Map(fichas.filter((f) => f?.id).map((f) => [f.id, f])).values()];
  if (!unicas.length) return out;
  const c = await db(cliente);

  const filasPor = new Map<string, FilaEstado[]>();
  for (const ids of trozos(unicas.map((f) => f.id), LOTE)) {
    const { data, error } = await c.from('consents').select('*').in('patient_id', ids);
    if (error) throw new Error(`estadoConsentimiento: no se pudieron leer los consentimientos (${error.message})`);
    for (const r of (data ?? []) as FilaEstado[]) {
      const k = String(r.patient_id ?? '');
      (filasPor.get(k) ?? filasPor.set(k, []).get(k)!).push(r);
    }
  }

  // Señales de pareja (regla única de pareja.ts): reservas de pareja por correo y grabaciones de pareja.
  const correosPareja = new Set<string>();
  const sessionTypesPor = new Map<string, string[]>();
  const grabPareja = new Set<string>();
  let senalesOk = true;
  try {
    const { data: svcs, error: es } = await c.from('services_catalog').select('id, type, name');
    if (es) throw es;
    const servicios = new Map<string, InfoServicio>(((svcs ?? []) as { id: string; type?: string | null; name?: string | null }[])
      .map((s) => [String(s.id), { type: s.type ?? null, name: s.name ?? null }]));
    const idsPareja = [...servicios.entries()].filter(([id]) => esReservaPareja({ service_id: id }, servicios)).map(([id]) => id);
    const filtro = ['session_type.like.pareja*', 'custom_title.ilike.*pareja*', ...(idsPareja.length ? [`service_id.in.(${idsPareja.join(',')})`] : [])].join(',');
    // status: esReservaPareja no cuenta las anuladas ni las vencidas (19 oct 2026).
    const { data: bks, error: eb } = await c.from('bookings').select('patient_email, session_type, service_id, custom_title, status').or(filtro).limit(5000);
    if (eb) throw eb;
    for (const b of (bks ?? []) as (ReservaMinima & { patient_email?: string | null })[]) {
      if (!esReservaPareja(b, servicios)) continue;
      const k = String(b.patient_email ?? '').trim().toLowerCase();
      if (!k) continue;
      correosPareja.add(k);
      (sessionTypesPor.get(k) ?? sessionTypesPor.set(k, []).get(k)!).push(String(b.session_type ?? ''));
    }
    const { data: gs, error: eg } = await c.from('grabaciones').select('patient_id').eq('tipo', 'pareja').limit(5000);
    if (eg) throw eg;
    for (const g of (gs ?? []) as { patient_id?: string | null }[]) if (g.patient_id) grabPareja.add(String(g.patient_id));
  } catch (e) {
    // Sin las señales de pareja no se puede decir "firmado" (el grabador también bloquea): esas fichas quedan
    // sin estado (sin indicador). Lo que falta igual se muestra (no depende de si es pareja).
    senalesOk = false;
    console.warn('[estadoConsentimiento] señales de pareja:', e instanceof Error ? e.message : (e as { message?: string })?.message ?? e);
  }

  for (const f of unicas) {
    const filas = filasPor.get(f.id) ?? [];
    const correo = String(f.email ?? '').trim().toLowerCase();
    const fichaPareja = fichaEsPareja({
      sessionTypes: sessionTypesPor.get(correo) ?? [], servicioPareja: !!correo && correosPareja.has(correo),
      tiposGrabaciones: grabPareja.has(f.id) ? ['pareja'] : [], filas, nombre: f.name,
    });
    const estado = estadoConsentimiento({ filas, fichaPareja, rut: f.rut, nombre: f.name });
    if (estado === 'firmado' && !senalesOk) continue;
    out.set(f.id, estado);
  }
  return out;
}

/** Igual, pero nunca lanza: si la base falla, mapa vacío (sin indicador) y queda en el registro. */
export async function estadosConsentimientoSeguro(fichas: FichaMinima[], cliente?: SupabaseClient): Promise<Map<string, EstadoConsentimiento>> {
  try { return await estadosConsentimientoEnBase(fichas, cliente); }
  catch (e) { console.warn('[estadoConsentimiento]', e instanceof Error ? e.message : e); return new Map(); }
}
