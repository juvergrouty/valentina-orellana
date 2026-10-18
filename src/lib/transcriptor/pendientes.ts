// Franja "Pendientes" de la ficha del paciente (pedido de Vale, 17 oct 2026): justo debajo del nombre,
// una línea por cada cosa que NO se ha hecho, con "Enviar" (o "Completar") y "Ya está hecho".
//   • "Ya está hecho" (tabla ficha_pendientes_gestionados, migración 0023) solo saca la línea de la
//     franja y la deja en el historial plegado. NO cambia ninguna regla: si una firma sigue faltando,
//     la grabación sigue bloqueada y el bloque de consentimientos lo dice.
//   • Cuando lo que faltaba se hace (llega la firma, se envían los pasos), el pendiente desaparece solo.
//   • Si vuelve a hacer falta después de marcarlo (por ejemplo, la pareja retiró su firma), vuelve a
//     aparecer: lo marcado solo vale desde `desde` en adelante.
// Funciones puras con pruebas en pendientes.test.ts; las de base fallan abierto (se muestran).
import type { SupabaseClient } from '@supabase/supabase-js';

export type AccionPendiente =
  | { tipo: 'consentimiento'; panel: string }   // abre las opciones de envío (WhatsApp / Copiar / QR / Correo)
  | { tipo: 'pasos' }                           // manda "Pasos a seguir" (mismo botón de la cabecera)
  | { tipo: 'ir'; href: string; etiqueta: string };

export interface Pendiente {
  clave: string;
  texto: string;
  /** Detalle corto (opcional), en gris al lado. */
  detalle?: string;
  accion: AccionPendiente;
  /** Lo marcado como hecho antes de esta fecha no cuenta (volvió a hacer falta). */
  desde?: string | null;
}

export interface Gestionado { clave: string; texto: string; gestionado_at: string }

export interface EntradaPendientes {
  nombre: string;
  activo: boolean;
  email?: string | null;
  /** Consentimiento propio vigente (persona 1). */
  consentimientoPropio: boolean;
  /** Fecha del último retiro del consentimiento propio, si lo hubo. */
  retiroPropio?: string | null;
  /** La ficha es de pareja (regla única de consentimiento.ts) y falta la firma de la segunda persona. */
  faltaPareja: boolean;
  /** Nombre de la segunda persona si se conoce (firmó antes y retiró). */
  nombrePareja?: string | null;
  retiroPareja?: string | null;
  /** "Pasos a seguir": null = nunca enviado. undefined = no se sabe (columna ausente): no se muestra. */
  pasosEnviadosAt?: string | null;
  tieneSesiones: boolean;
  faltanDatos: string[];
  hrefInfo: string;
  /** Ronda 2 (18 oct): sin fecha de nacimiento no se graba (chequeo de menores, consentimiento.ts). */
  faltaNacimiento?: boolean;
}

export const ID_PANEL_PROPIO = 'cf-envio-propio';
export const ID_PANEL_PAREJA = 'cf-envio-pareja';

const pila = (n: string | null | undefined) => String(n ?? '').trim().split(/\s+/)[0] ?? '';

/** Todos los pendientes de la ficha, antes de quitar los marcados como hechos. */
export function calcularPendientes(e: EntradaPendientes): Pendiente[] {
  const out: Pendiente[] = [];
  if (!e.consentimientoPropio) {
    const quien = pila(e.nombre);
    out.push({
      clave: 'consentimiento_propio',
      texto: `Falta el consentimiento de ${quien || 'la paciente'}`,
      accion: { tipo: 'consentimiento', panel: ID_PANEL_PROPIO },
      desde: e.retiroPropio ?? null,
    });
  }
  if (e.faltaPareja) {
    const quien = pila(e.nombrePareja);
    out.push({
      clave: 'consentimiento_pareja',
      texto: quien ? `Falta el consentimiento de ${quien}` : 'Falta el consentimiento de la pareja',
      detalle: 'sin las dos firmas no se graba',
      accion: { tipo: 'consentimiento', panel: ID_PANEL_PAREJA },
      desde: e.retiroPareja ?? null,
    });
  }
  if (e.activo && e.email && e.tieneSesiones && e.pasosEnviadosAt === null) {
    out.push({ clave: 'pasos_a_seguir', texto: 'Falta enviar «Pasos a seguir»', accion: { tipo: 'pasos' } });
  }
  if (e.faltaNacimiento) {
    out.push({
      clave: 'fecha_nacimiento',
      texto: 'Falta la fecha de nacimiento',
      detalle: 'sin ella no se graba la sesión',
      accion: { tipo: 'ir', href: `${e.hrefInfo}#pf-nacimiento`, etiqueta: 'Completar' },
    });
  }
  if (e.faltanDatos.length) {
    // La clave incluye qué falta: si después falta otra cosa, vuelve a aparecer.
    out.push({
      clave: `datos_ficha:${[...e.faltanDatos].sort().join(',')}`.slice(0, 120),
      texto: `Faltan datos de la ficha: ${e.faltanDatos.join(', ')}`,
      accion: { tipo: 'ir', href: e.hrefInfo, etiqueta: 'Completar' },
    });
  }
  return out;
}

/** ¿Este pendiente fue marcado como hecho (después de `desde`)? */
export function estaGestionado(p: Pick<Pendiente, 'clave' | 'desde'>, gestionados: Gestionado[]): boolean {
  return gestionados.some((g) => g.clave === p.clave && (!p.desde || String(g.gestionado_at) >= String(p.desde)));
}

/** Separa lo que se muestra en la franja de lo ya gestionado (que sigue faltando). */
export function separarPendientes(todos: Pendiente[], gestionados: Gestionado[]): { visibles: Pendiente[]; gestionadosAbiertos: Pendiente[] } {
  const visibles: Pendiente[] = [];
  const gestionadosAbiertos: Pendiente[] = [];
  for (const p of todos) (estaGestionado(p, gestionados) ? gestionadosAbiertos : visibles).push(p);
  return { visibles, gestionadosAbiertos };
}

const CLAVE_VALIDA = /^(consentimiento_propio|consentimiento_pareja|pasos_a_seguir|fecha_nacimiento|datos_ficha:[\p{L}, ]{1,100})$/u;
export function claveValida(c: unknown): c is string {
  return typeof c === 'string' && c.length <= 120 && CLAVE_VALIDA.test(c);
}
export function textoValido(t: unknown): string | null {
  if (typeof t !== 'string') return null;
  const s = t.replace(/\s+/g, ' ').trim().slice(0, 300);
  return s || null;
}

export class FaltaMigracion0023 extends Error {}
const faltaTabla = (code?: string) => code === '42P01' || code === 'PGRST205' || code === 'PGRST204';

/** Historial de pendientes marcados como hechos (más reciente primero). Si la tabla no está, lista vacía. */
export async function leerGestionados(c: SupabaseClient, patientId: string): Promise<Gestionado[]> {
  try {
    const { data, error } = await c.from('ficha_pendientes_gestionados')
      .select('clave, texto, gestionado_at').eq('patient_id', patientId)
      .order('gestionado_at', { ascending: false }).limit(100);
    if (error) return [];
    return (data ?? []) as Gestionado[];
  } catch { return []; }
}

export async function marcarGestionado(c: SupabaseClient, patientId: string, clave: string, texto: string): Promise<Gestionado> {
  const { data, error } = await c.from('ficha_pendientes_gestionados')
    .insert({ patient_id: patientId, clave, texto }).select('clave, texto, gestionado_at').single();
  if (error && faltaTabla(error.code)) throw new FaltaMigracion0023('Falta actualizar la base de datos (migración 0023) para guardar "Ya está hecho".');
  if (error || !data) throw new Error(error?.message ?? 'No se pudo guardar.');
  return data as Gestionado;
}
