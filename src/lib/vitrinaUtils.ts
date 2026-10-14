// Ayudas puras de la vitrina (talleres, charlas y contenido digital): sin base
// de datos ni variables de entorno, para poder probarlas solas. Lo que toca
// Supabase, Flow o correos está en src/lib/vitrina.ts.

export const VITRINA_TIPOS = ['taller', 'charla', 'contenido'] as const;
export type VitrinaTipo = typeof VITRINA_TIPOS[number];
export const VITRINA_MODALIDADES = ['online', 'presencial'] as const;
export type VitrinaModalidad = typeof VITRINA_MODALIDADES[number];
export const VITRINA_ESTADOS = ['pending_payment', 'paid', 'free', 'cancelled', 'expired'] as const;
export type VitrinaEstado = typeof VITRINA_ESTADOS[number];

export const TIPO_LABEL: Record<VitrinaTipo, string> = {
  taller: 'Taller',
  charla: 'Charla',
  contenido: 'Contenido digital',
};
export const ESTADO_LABEL: Record<VitrinaEstado, string> = {
  pending_payment: 'Esperando pago',
  paid: 'Pagada',
  free: 'Gratis',
  cancelled: 'Cancelada',
  expired: 'Vencida (no pagó)',
};

// Rutas fijas dentro de /talleres: ningún item puede usar ese slug.
export const SLUGS_RESERVADOS = new Set(['confirmacion', 'index', 'admin', 'api']);

/** "Taller de Apego: ¿qué es?" → "taller-de-apego-que-es" */
export function slugify(texto: string): string {
  return String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

export function slugValido(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 80 && !SLUGS_RESERVADOS.has(slug);
}

// ── Hora de Chile ────────────────────────────────────────────────────────────
const TZ = 'America/Santiago';

/** Minutos que Chile está adelantado (negativo: atrasado) respecto de UTC en ese instante. */
function offsetChileMin(instante: Date): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instante);
  const v = (t: string) => Number(p.find(x => x.type === t)?.value ?? '0');
  const comoUTC = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour') % 24, v('minute'), v('second'));
  return Math.round((comoUTC - instante.getTime()) / 60000);
}

/** "2026-11-05T19:00" (hora de Chile, como la escribe un input datetime-local)
 *  → instante ISO en UTC. null si el texto no es una fecha válida. */
export function chileLocalAISO(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(local ?? '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const pared = Date.UTC(y, mo - 1, d, h, mi);
  // Dos pasadas: la segunda corrige si el cambio de horario cae entre medio.
  let t = pared - offsetChileMin(new Date(pared)) * 60000;
  t = pared - offsetChileMin(new Date(t)) * 60000;
  const r = new Date(t);
  return isNaN(r.getTime()) ? null : r.toISOString();
}

/** Instante ISO → { fecha: "YYYY-MM-DD", hora: "HH:MM" } en hora de Chile. */
export function partesChile(iso: string): { fecha: string; hora: string } | null {
  const d = new Date(iso);
  if (!iso || isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const v = (t: string) => p.find(x => x.type === t)?.value ?? '00';
  return { fecha: `${v('year')}-${v('month')}-${v('day')}`, hora: `${v('hour') === '24' ? '00' : v('hour')}:${v('minute')}` };
}

/** Valor para un input datetime-local (hora de Chile). */
export function isoAInputLocal(iso: string | null | undefined): string {
  const p = iso ? partesChile(iso) : null;
  return p ? `${p.fecha}T${p.hora}` : '';
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "jueves 5 de noviembre de 2026" (hora de Chile). */
export function fechaLargaChile(iso: string): string {
  const p = partesChile(iso);
  if (!p) return '';
  const [y, m, d] = p.fecha.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DIAS[dow]} ${d} de ${MESES[m - 1]} de ${y}`;
}

/** "19:00" (hora de Chile). */
export function horaChile(iso: string): string {
  return partesChile(iso)?.hora ?? '';
}

export function formatCLP(n: number): string {
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(n);
}

export function precioTexto(n: number): string {
  return n > 0 ? formatCLP(n) : 'Gratis';
}

/** Texto plano → párrafos (separados por una o más líneas en blanco). */
export function parrafos(texto: string | null | undefined): string[] {
  return String(texto ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
}

// ── Cupos ────────────────────────────────────────────────────────────────────
// Una inscripción "ocupa cupo" si está pagada, es gratis, o espera pago desde
// hace menos de 30 minutos (después de eso se libera, como las reservas).
export const VITRINA_EXPIRA_MS = 30 * 60 * 1000;

export function ocupaCupo(i: { status: string; created_at: string }, ahora = Date.now()): boolean {
  if (i.status === 'paid' || i.status === 'free') return true;
  if (i.status === 'pending_payment') return ahora - new Date(i.created_at).getTime() < VITRINA_EXPIRA_MS;
  return false;
}

export function cuposRestantes(capacity: number | null | undefined, ocupados: number): number | null {
  if (capacity == null) return null;
  return Math.max(0, capacity - ocupados);
}

/** ¿Ya pasó? Talleres y charlas: cuando empezó. El contenido nunca "pasa". */
export function yaPaso(item: { type: string; starts_at: string | null }, ahora = Date.now()): boolean {
  if (item.type === 'contenido' || !item.starts_at) return false;
  return new Date(item.starts_at).getTime() <= ahora;
}

// ── Validación de datos de la persona ───────────────────────────────────────
export function validarNombre(n: string): boolean {
  const t = String(n ?? '').trim();
  return t.length >= 2 && t.length <= 120 && !/[<>]/.test(t);
}
export function validarCorreo(e: string): boolean {
  const t = String(e ?? '').trim();
  return t.length <= 200 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(t);
}
export function validarTelefono(t: string): boolean {
  return /^[\d\s()+.-]{7,25}$/.test(String(t ?? '').trim());
}

// ── CSV ──────────────────────────────────────────────────────────────────────
/** Celda CSV segura: comillas, y sin fórmulas de Excel (=, +, -, @ al inicio). */
export function celdaCSV(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function filaCSV(valores: unknown[]): string {
  return valores.map(celdaCSV).join(',');
}

/** Orden de Flow para la vitrina: "VT-<id de la inscripción>" (las reservas usan el id solo). */
export const PREFIJO_ORDEN = 'VT-';
export function ordenFlow(inscripcionId: string): string {
  return `${PREFIJO_ORDEN}${inscripcionId}`;
}
export function idDesdeOrden(orden: string | null | undefined): string | null {
  const m = /^VT-([0-9a-f-]{36})$/i.exec(String(orden ?? ''));
  return m ? m[1].toLowerCase() : null;
}

/** ¿El archivo digital es un enlace externo (https) o una ruta del bucket privado? */
export function esEnlaceExterno(ruta: string | null | undefined): boolean {
  return /^https:\/\//i.test(String(ruta ?? '').trim());
}
