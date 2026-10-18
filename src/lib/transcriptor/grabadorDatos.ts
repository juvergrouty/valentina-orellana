// Datos y lógica pura del componente Grabador (src/components/admin/Grabador.astro), con pruebas en
// ronda2.test.ts. Ronda 2 (18 oct 2026): retomar sin internet, fecha de nacimiento, dos dispositivos.
// Este archivo lo importan el servidor (páginas) y el navegador (script del componente): sin dependencias.

export type TipoGrabador = 'individual' | 'pareja';

export interface CandidataGrabador {
  clave: string; fuente: 'reserva' | 'calendario' | 'ficha'; bookingId: string | null; googleEventId: string | null;
  patientId: string | null; nombre: string; fecha: string; hora: string; dur: number; tipo: TipoGrabador | null;
  faltaMin: number; consentOk: boolean | null; consentTexto: string | null; firmantes: string[];
  /** Motivo del bloqueo (consentimiento.ts) para mostrar qué hacer. */
  consentMotivo?: string | null;
}

export interface DatosGrabador {
  activo: boolean; errorLectura: boolean; hoy: string;
  ventana: CandidataGrabador[]; otras: CandidataGrabador[];
  pacientes: { id: string; name: string }[]; recientes: string[];
  demo: string | null; pedida: string | null; pacientePedido: string | null;
  /** Página estática /grabar-sin-internet (la sirve el service worker sin red): solo retomar y ver lo pendiente. */
  sinInternet?: boolean;
}

/** Datos de la página estática: no lleva NINGÚN dato de pacientes (se genera al compilar). */
export const DATOS_SIN_INTERNET: DatosGrabador = {
  activo: true, errorLectura: false, hoy: '', ventana: [], otras: [], pacientes: [], recientes: [],
  demo: null, pedida: null, pacientePedido: null, sinInternet: true,
};

// ─── Retomar sin internet ────────────────────────────────────────────────────

/**
 * Hasta cuánto después del último latido se ofrece "Seguir grabando" una grabación que se cortó (iOS
 * descartó la pestaña). Pasado esto ya no es la misma sesión: se sube tal cual quedó.
 */
export const RETOMAR_MAX_MS = 3 * 3600_000;
export const MAX_SEGMENTOS = 999;

interface SegRetomar { seq: number; inicioMs: number; finMs: number | null }
interface GrabRetomar { estado: string; inicioMs: number; vivoMs?: number; segmentos: SegRetomar[] }

/**
 * ¿Se puede seguir grabando esta grabación guardada en el teléfono? Solo si quedó 'grabando' (Safari se
 * cerró en plena sesión), nadie la tiene abierta (abandonada = sin Web Lock / latido viejo), es reciente y
 * le quedan segmentos. La autorización (gid) se obtuvo CON internet al prepararla; sin internet nunca se
 * crea una grabación nueva (el consentimiento se verifica en el servidor).
 */
export function esRetomable(g: GrabRetomar, abandonada: boolean, ahora: number): boolean {
  if (g.estado !== 'grabando' || !abandonada) return false;
  const ultimo = g.vivoMs ?? g.inicioMs;
  return ahora - ultimo <= RETOMAR_MAX_MS && ahora >= g.inicioMs && g.segmentos.length <= MAX_SEGMENTOS;
}

/**
 * Antes de seguir: el último segmento quedó sin hora de fin (Safari se cerró grabando). Se cierra con la
 * hora del último trozo guardado (lo que de verdad hay), igual que al subir. Devuelve el seq que sigue.
 */
export function cerrarSegmentoCortado(g: GrabRetomar, tiemposTrozosUltimo: number[]): number {
  const ult = g.segmentos[g.segmentos.length - 1];
  if (ult && ult.finMs === null) ult.finMs = tiemposTrozosUltimo.length ? Math.max(ult.inicioMs, ...tiemposTrozosUltimo) : ult.inicioMs;
  return g.segmentos.length;
}

// ─── Dos dispositivos (iPhone y Mac en la misma sesión) ──────────────────────

/** Clave de localStorage con la grabación preparada en ESTE dispositivo para esa sesión y día. */
export function claveReutilizar(clave: string, hoy: string): string {
  return `vo-grabar-prep:${hoy}:${clave}`.slice(0, 200);
}

export interface SegServidor { seq: number; bytes: number | null; sha256: string | null }
interface SegLocalCmp { seq: number; bytes?: number; sha256?: string | null }

/**
 * El servidor dice que la grabación ya se cerró (o que un segmento ya está subido). Solo se puede borrar
 * el audio local si TODO lo de este teléfono ya está allá, igual (mismo seq y tamaño; y mismo SHA-256 si
 * ambos lo tienen). Si no (otro dispositivo subió otra cosa con la misma grabación), NO se borra.
 */
export function localYaEnServidor(locales: SegLocalCmp[], servidor: SegServidor[]): boolean {
  const porSeq = new Map(servidor.map((s) => [s.seq, s]));
  return locales.every((l) => {
    const s = porSeq.get(l.seq);
    if (!s || typeof l.bytes !== 'number' || s.bytes !== l.bytes) return false;
    return !(l.sha256 && s.sha256) || l.sha256 === s.sha256;
  });
}

// ─── Qué hacer cuando no se puede grabar ─────────────────────────────────────

/** Texto corto en la lista de sesiones y debajo del nombre (el largo viene de consentimiento.textoMotivo). */
export function etiquetaBloqueo(motivo: string | null | undefined): string {
  if (motivo === 'sin_fecha_nacimiento') return 'Falta la fecha de nacimiento en la ficha';
  if (motivo === 'menor_de_edad') return 'Menor de 18: no se graba';
  return 'Falta consentimiento de grabación';
}

/** Qué hacer (segunda línea del aviso rojo) y adónde ir. */
export function arregloBloqueo(motivo: string | null | undefined, patientId: string | null): { texto: string; href: string | null; etiqueta: string | null; reintentar: boolean } {
  if (motivo === 'sin_fecha_nacimiento') {
    return { texto: 'Después de guardarla, toca Reintentar.', href: patientId ? `/admin/pacientes/${patientId}?tab=info#pf-nacimiento` : null, etiqueta: 'Completar la ficha', reintentar: true };
  }
  if (motivo === 'menor_de_edad') return { texto: '', href: null, etiqueta: null, reintentar: false };
  return { texto: 'Pídele que lo firme desde la ficha (botón Enviar consentimiento).', href: patientId ? `/admin/pacientes/${patientId}` : null, etiqueta: 'Enviar consentimiento', reintentar: false };
}
