// Transcriptor IA — parejas (decisión D de 02-decisiones-16oct-noche.md, que manda).
//   • La ficha es de pareja porque LA RESERVA lo dice: bookings.session_type 'pareja-online' /
//     'pareja-presencial', o el servicio reservado (bookings.service_id → services_catalog.type
//     = 'pareja'). El precio de pareja sale de ese mismo servicio (bookings.ts lo toma de
//     services_catalog), así que el servicio ya lo cubre; el monto solo no se usa porque cambia
//     con packs, descuentos y precios manuales. Nunca depende de lo que se elija en pantalla.
//   • Siempre 2 consentimientos distintos, uno por persona. La persona agendada firma el suyo
//     como hoy (consents.persona = 1). La segunda persona firma por SU link (persona = 2, 0021),
//     ligado a la misma ficha.
//   • Para grabar se exigen 2 firmas vigentes de 2 personas distintas (consentimiento.ts).
// Funciones puras con pruebas en pareja.test.ts; las de base de datos fallan cerrado (lanzan).
import type { SupabaseClient } from '@supabase/supabase-js';
import { identidadFirmante, type FilaConsentimiento } from './consentimiento';

/** 1 = persona agendada (todas las firmas anteriores a 0021); 2 = segunda persona de la pareja. */
export type Persona = 1 | 2;

/** consents.persona; sin la migración 0021 (columna ausente) todas las filas son de la persona 1. */
export function personaDe(f: { persona?: number | null }): Persona {
  return Number(f.persona) === 2 ? 2 : 1;
}

export interface ReservaMinima { session_type?: string | null; service_id?: string | null }

/** ¿Esta reserva es de pareja? Por su tipo o por el tipo del servicio reservado. */
export function esReservaPareja(b: ReservaMinima, tipoServicio: ReadonlyMap<string, string | null | undefined>): boolean {
  if (String(b.session_type ?? '').startsWith('pareja')) return true;
  const sid = String(b.service_id ?? '');
  return !!sid && String(tipoServicio.get(sid) ?? '') === 'pareja';
}

export function fichaConReservaPareja(bs: ReservaMinima[], tipoServicio: ReadonlyMap<string, string | null | undefined>): boolean {
  return bs.some((b) => esReservaPareja(b, tipoServicio));
}

/** Reservas de la ficha (por su correo, sin mayúsculas) y el tipo de cada servicio reservado. Lanza si la base falla. */
export async function reservasDeFicha(c: SupabaseClient, email: string | null | undefined): Promise<{ reservas: ReservaMinima[]; tipoServicio: Map<string, string | null> }> {
  const correo = String(email ?? '').trim();
  const tipoServicio = new Map<string, string | null>();
  if (!correo) return { reservas: [], tipoServicio };
  const { data, error } = await c.from('bookings').select('session_type, service_id')
    .ilike('patient_email', correo.replace(/[\\%_]/g, (m) => `\\${m}`)).limit(500);
  if (error) throw new Error(`pareja: no se pudieron leer las reservas (${error.message})`);
  const reservas = (data ?? []) as ReservaMinima[];
  const ids = [...new Set(reservas.map((b) => String(b.service_id ?? '')).filter(Boolean))];
  if (ids.length) {
    const { data: svcs, error: es } = await c.from('services_catalog').select('id, type').in('id', ids);
    if (es) throw new Error(`pareja: no se pudieron leer los servicios (${es.message})`);
    for (const s of (svcs ?? []) as { id: string; type?: string | null }[]) tipoServicio.set(String(s.id), s.type ?? null);
  }
  return { reservas, tipoServicio };
}

/** ¿La ficha tiene alguna reserva de pareja? Lanza si la base falla. */
export async function fichaEsParejaPorReserva(c: SupabaseClient, email: string | null | undefined): Promise<boolean> {
  const { reservas, tipoServicio } = await reservasDeFicha(c, email);
  return fichaConReservaPareja(reservas, tipoServicio);
}

type FilaPareja = FilaConsentimiento & { persona?: number | null; patient_id?: string | null; created_at?: string | null; sent_at?: string | null; token?: string | null };

export interface EstadoPareja {
  /** Firma vigente de la segunda persona (la más reciente), o null. */
  firma: FilaPareja | null;
  /** La última firma de la segunda persona fue retirada (completa). */
  retirada: FilaPareja | null;
  /** Link pendiente (sin firmar) de la segunda persona, si existe. */
  pendiente: FilaPareja | null;
}

/**
 * Estado del consentimiento de la segunda persona. Cuenta como "de la pareja":
 *   - una firma con persona = 2 (link nuevo), o
 *   - (parejas que ya firmaron antes de 0021, con dos links de la ficha) una firma de OTRA
 *     persona distinta de la agendada. La agendada se reconoce por el RUT de la ficha; si la
 *     ficha no tiene RUT, por el nombre de la ficha; si no calza, por la primera persona que firmó.
 */
export function estadoPareja(filas: FilaPareja[], rutFicha: string | null | undefined, nombreFicha?: string | null): EstadoPareja {
  const firmadas = filas.filter((f) => f.signed_at).sort((a, b) => String(b.signed_at).localeCompare(String(a.signed_at)));
  const rut = String(rutFicha ?? '').replace(/[^0-9kK]/g, '').toUpperCase();
  let principal: string | null = rut.length >= 7 ? `rut:${rut}` : null;
  if (!principal) {
    const p1s = [...firmadas].reverse().filter((f) => personaDe(f) === 1);
    const norm = (x: unknown) => String(x ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const porNombre = nombreFicha ? p1s.find((f) => norm(f.signer_name) === norm(nombreFicha)) : undefined;
    const p1 = porNombre ?? p1s[0];
    principal = p1 ? identidadFirmante(p1) : null;
  }
  const deLaPareja = firmadas.filter((f) => personaDe(f) === 2 || (principal !== null && identidadFirmante(f) !== principal));
  const ultima = deLaPareja[0] ?? null;
  const pendiente = filas.filter((f) => !f.signed_at && personaDe(f) === 2)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0] ?? null;
  if (ultima && ultima.revoked_at) return { firma: null, retirada: ultima, pendiente };
  return { firma: ultima, retirada: null, pendiente };
}

/** Filas de la persona agendada (persona 1): su consentimiento "vigente" nunca lo tapa la firma de la pareja. */
export function soloPersona1<T extends { persona?: number | null }>(filas: T[]): T[] {
  return filas.filter((f) => personaDe(f) === 1);
}

export class FaltaMigracion0021 extends Error {}

/**
 * Link pendiente (sin firmar) de esa persona de la ficha: reutiliza el último o crea uno nuevo.
 * Lee con select('*') y filtra aquí: sin la migración 0021 (sin columna persona) la persona 1 funciona
 * igual que siempre; la persona 2 lanza FaltaMigracion0021.
 */
export async function pendienteOCrear(c: SupabaseClient, patientId: string, persona: Persona, version: string, token: () => string): Promise<{ id: string; token: string }> {
  const { data: pendientes, error: ep } = await c.from('consents')
    .select('*').eq('patient_id', patientId).is('signed_at', null)
    .order('created_at', { ascending: false }).limit(50);
  if (ep) throw new Error(ep.message);
  const existing = ((pendientes ?? []) as { id: string; token: string; persona?: number | null }[]).find((r) => personaDe(r) === persona);
  if (existing) return { id: existing.id, token: existing.token };
  const fila: Record<string, unknown> = persona === 2
    ? { patient_id: patientId, token: token(), version, persona: 2 }
    : { patient_id: patientId, token: token(), version }; // sin columna persona: igual que antes de 0021
  const { data, error } = await c.from('consents').insert(fila).select('id, token').single();
  if (persona === 2 && error && (error.code === '42703' || error.code === 'PGRST204')) {
    throw new FaltaMigracion0021('Falta actualizar la base de datos (migración 0021) para crear el consentimiento de la pareja.');
  }
  if (error || !data) throw new Error(error?.message ?? 'No se pudo crear el consentimiento.');
  const d = data as { id: string; token: string };
  return { id: d.id, token: d.token };
}

/** ¿Este RUT/documento ya firmó en la ficha como otra persona? (la pareja debe firmar con el suyo). */
export function rutYaFirmoEnFicha(rut: string, filas: Pick<FilaConsentimiento, 'id' | 'signed_at' | 'signer_rut' | 'signer_email' | 'signer_name'>[], rutFicha?: string | null): boolean {
  const k = String(rut ?? '').replace(/[^0-9kK]/g, '').toUpperCase();
  if (k.length < 4) return false;
  if (String(rutFicha ?? '').replace(/[^0-9kK]/g, '').toUpperCase() === k) return true;
  return filas.some((f) => f.signed_at && String(f.signer_rut ?? '').replace(/[^0-9kK]/g, '').toUpperCase() === k);
}

/** Mensaje de WhatsApp para la segunda persona (Vale elige el contacto: wa.me sin número). */
export function mensajeWhatsAppPareja(nombrePilaFicha: string, url: string): string {
  const quien = nombrePilaFicha.trim() ? ` con ${nombrePilaFicha.trim()}` : '';
  return `Hola, ¿cómo estás? Soy Valentina Orellana, psicóloga. Te comparto tu consentimiento informado para la terapia de pareja${quien}: cada persona firma el suyo, así que este es solo para ti. Lo lees con calma, marcas lo que autorizas y firmas con tu nombre y RUT (o tu documento). Toma unos 2 minutos.\n\n${url}\n\nSi tienes cualquier duda, me escribes por aquí. Un abrazo,\nValentina`;
}

export function urlWhatsAppPareja(nombrePilaFicha: string, url: string): string {
  return `https://wa.me/?text=${encodeURIComponent(mensajeWhatsAppPareja(nombrePilaFicha, url))}`;
}

// ─── Envío del link a la segunda persona (añadido en t-n-pulido) ─────────────

/** Correo para mandarle el link a la segunda persona. Solo se usa para enviar: NO se guarda en la ficha. */
export function correoParejaValido(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const c = s.trim().toLowerCase();
  if (c.length < 6 || c.length > 120 || c.includes('..')) return null;
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(c) ? c : null;
}

/** Lo que el panel necesita para saber si la pareja ya firmó (se consulta mientras se muestra el QR). Sin RUT. */
export function resumenEstadoPareja(e: EstadoPareja): { firmado: boolean; nombre: string | null; firmado_at: string | null } {
  if (!e.firma) return { firmado: false, nombre: null, firmado_at: null };
  return { firmado: true, nombre: String(e.firma.signer_name ?? '').trim() || null, firmado_at: e.firma.signed_at ? String(e.firma.signed_at) : null };
}
