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
  /** Indicador "Sin consentimiento firmado" (estadoConsentimiento.ts, calculado en el servidor; 19 oct). */
  consentEstado?: string | null;
}

export interface DatosGrabador {
  activo: boolean; errorLectura: boolean; hoy: string;
  ventana: CandidataGrabador[]; otras: CandidataGrabador[];
  pacientes: { id: string; name: string; consent?: string | null }[]; recientes: string[];
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

// ─── Seguir la misma sesión CON internet (19 oct) ───────────────────────────
// "Una sesión = una transcripción": si iOS descartó la pestaña y Vale reabre el grabador con internet, antes
// la grabación cortada se subía sola tal cual y lo que seguía quedaba en otra grabación (dos resúmenes). Ahora
// se ofrece "Seguir grabando" igual que sin internet (mismo gid, seq que continúa). Si Vale dice que no, o
// pasaron más de RETOMAR_MAX_MS, se sube como antes.

/** Qué hacer con una grabación guardada en el teléfono al revisar lo pendiente. */
export type DestinoPendiente = 'subir' | 'ofrecer_seguir' | 'ninguno';

export function destinoPendiente(g: GrabRetomar, abandonada: boolean, ahora: number): DestinoPendiente {
  if (g.estado === 'terminada') return 'subir';
  if (g.estado !== 'grabando' || !abandonada) return 'ninguno'; // la está grabando esta u otra pestaña
  return esRetomable(g, abandonada, ahora) ? 'ofrecer_seguir' : 'subir';
}

/** Respuesta de GET grabacion-finalizar?verificar=1 antes de seguir con internet. */
export interface VerificacionSeguir { ok?: boolean; acepta_audio?: boolean; puede_grabar?: boolean; error?: string }

/**
 * ¿Se puede seguir con internet? 'seguir' solo si el servidor confirma que la grabación sigue abierta y el
 * consentimiento vigente. 'no_acepta' = ya se cerró, canceló o subió desde otro dispositivo: no se sigue (se
 * sube lo grabado y la subida explica qué pasó). 'sin_consentimiento' = no se graba más. Si el servidor no
 * responde (red inestable) se sigue igual que sin internet: subida-url y finalizar vuelven a verificar.
 */
export function decidirSeguir(r: VerificacionSeguir | null): 'seguir' | 'no_acepta' | 'sin_consentimiento' {
  if (!r || r.ok !== true) return 'seguir';
  if (r.acepta_audio === false) return 'no_acepta';
  if (r.puede_grabar === false) return 'sin_consentimiento';
  return 'seguir';
}

// ─── Lista "grabaciones sin subir" ───────────────────────────────────────────

/**
 * Texto de la lista ámbar. Las que tienen un error definitivo (consentimiento retirado, cancelada, subida
 * desde otro dispositivo) NO se suben solas: no se puede decir "Se está subiendo sola" de ellas. Tampoco si
 * la sesión del panel venció (401): ahí se suben recién cuando Vale vuelve a entrar.
 */
export function textoSinSubir(total: number, conErrorDefinitivo: number, enLinea: boolean, sesionVencida = false): string {
  const resto = total - conErrorDefinitivo;
  if (total <= 0) return '';
  if (resto <= 0) return total === 1 ? 'No se pudo subir: abajo está el motivo.' : 'No se pudieron subir: abajo está el motivo de cada una.';
  const sola = !enLinea ? (resto === 1 ? 'se sube sola cuando vuelva internet' : 'se suben solas cuando vuelva internet')
    : sesionVencida ? (resto === 1 ? 'se sube cuando vuelvas a entrar al panel (tu sesión venció)' : 'se suben cuando vuelvas a entrar al panel (tu sesión venció)')
    : (resto === 1 ? 'se está subiendo sola' : 'se están subiendo solas');
  if (!conErrorDefinitivo) return `${sola[0].toUpperCase()}${sola.slice(1)}.`;
  return `${resto === 1 ? 'Una' : `${resto}`} ${sola}; ${conErrorDefinitivo === 1 ? (resto === 1 ? 'la otra no se pudo subir' : '1 no se pudo subir') : `${conErrorDefinitivo} no se pudieron subir`} (abajo está el motivo).`;
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
