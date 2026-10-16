// Transcriptor IA — acciones que REPARAN cada aviso (decisión A, 02-decisiones-16oct-noche.md).
//
// Reglas:
//   • Cada aviso tiene al menos una acción que fuerza la solución (Reintentar, Reintentar resumen,
//     Rehacer copia en B2, Borrar en AssemblyAI, Lanzar respaldo ahora, …). Si no hay arreglo
//     automático (falta una llave, presupuesto), la acción es "Volver a revisar": re-ejecuta ESE
//     chequeo al instante y el texto dice exactamente qué hacer.
//   • NO existe "Marcar como resuelto". Un aviso se cierra solo cuando el problema se arregla:
//     el paso de la grabación salió bien (la grabación avanzó más allá del paso que falló) o el
//     chequeo volvió a OK. Siempre resuelta_por = 'sistema'.
//   • Toda acción se ejecuta por POST (panel o página /admin/transcriptor/accion); nunca por GET.
//
// Tabla completa tipo de aviso → acción → qué hace: docs/transcriptor/84-avisos-acciones.md.
// Las funciones puras (catálogo, cierre) tienen pruebas en accionesAlerta.test.ts; la ejecución
// usa `OpsAcciones` (dobles en las pruebas, Supabase/R2/B2/AssemblyAI/Fly en producción).
import type { AlertaFila, SesionDeAlerta } from './alertas';
import type { EstadoGrabacion } from './tipos';
import { planReintento, ejecutarReintento, opsReintentoSupabase, type OpsReintento } from './reintentoAlerta';
import { CLAVE_ROBOT_SESION, PASOS_RELOGIN, PREFIJO_BOT_ERROR, PREFIJO_ROBOT_INVITADO } from './avisosRobot';

// ─── Catálogo ─────────────────────────────────────────────────────────────────

export type AccionAviso =
  | 'reintentar' | 'reintentar_resumen' | 'rescatar' | 'apagar_bot'
  | 'copiar_b2' | 'borrar_aai' | 'borrar_huerfanos' | 'borrar_audio'
  | 'lanzar_respaldo' | 'usar_directo' | 'revisar';

export const ACCIONES_AVISO: readonly AccionAviso[] = [
  'reintentar', 'reintentar_resumen', 'rescatar', 'apagar_bot', 'copiar_b2', 'borrar_aai',
  'borrar_huerfanos', 'borrar_audio', 'lanzar_respaldo', 'usar_directo', 'revisar',
];

export const esAccionAviso = (x: unknown): x is AccionAviso => typeof x === 'string' && (ACCIONES_AVISO as readonly string[]).includes(x);

export interface InfoAccion { etiqueta: string; queHace: string; confirmar?: string }

export const INFO_ACCION: Record<AccionAviso, InfoAccion> = {
  reintentar: {
    etiqueta: 'Reintentar',
    queHace: 'Deja la sesión lista para que el sistema vuelva a hacer el paso que falló (subir, transcribir o enviar el asistente de notas) en el próximo minuto. El aviso se cierra solo cuando ese paso sale bien.',
  },
  reintentar_resumen: {
    etiqueta: 'Reintentar resumen',
    queHace: 'Vuelve a pedir el resumen de la sesión a la IA en el próximo minuto (la transcripción ya está guardada). El aviso se cierra solo cuando el resumen queda listo.',
  },
  rescatar: {
    etiqueta: 'Cerrar con lo grabado',
    queHace: 'El asistente de notas ya no puede volver a esa reunión. Si alcanzó a subir audio, se transcribe y se resume eso; si no subió nada, la sesión queda cerrada como "no grabada". El aviso se cierra cuando la sesión avanza.',
  },
  apagar_bot: {
    etiqueta: 'Apagar el asistente ahora',
    queHace: 'Apaga en Fly.io la máquina del asistente de notas de esa sesión (deja de costar y ya no puede subir nada). El aviso se cierra cuando Fly confirma que la máquina se apagó.',
  },
  copiar_b2: {
    etiqueta: 'Rehacer copia en B2',
    queHace: 'Copia ahora a Backblaze B2 las transcripciones cifradas que no tienen su segunda copia. El aviso se cierra cuando todas quedan copiadas.',
  },
  borrar_aai: {
    etiqueta: 'Borrar en AssemblyAI ahora',
    queHace: 'Borra en AssemblyAI las transcripciones de sesiones que ya están guardadas cifradas en tu sistema (o canceladas). Nunca borra una que todavía no esté guardada. El aviso se cierra cuando no queda ninguna pendiente.',
  },
  borrar_huerfanos: {
    etiqueta: 'Borrar transcripciones sueltas en AssemblyAI',
    queHace: 'Borra en AssemblyAI las transcripciones de más de 2 horas que no corresponden a una sesión en curso, incluidas las que ninguna sesión reconoce. No se pueden recuperar después. El aviso se cierra cuando no queda ninguna.',
    confirmar: 'Se borrarán en AssemblyAI las transcripciones sueltas (no se pueden recuperar). ¿Seguir?',
  },
  borrar_audio: {
    etiqueta: 'Borrar el audio ahora',
    queHace: 'Borra de Cloudflare R2 el audio de sesiones ya transcritas (o canceladas) y los archivos de audio con más de 1 día. El aviso se cierra cuando ya no queda audio que debió borrarse.',
  },
  lanzar_respaldo: {
    etiqueta: 'Lanzar respaldo ahora',
    queHace: 'Enciende ahora en Fly.io la máquina del respaldo semanal de la base (respaldo-semanal). Tarda unos minutos; después toca "Volver a revisar". El aviso se cierra cuando el respaldo nuevo aparece en B2.',
  },
  usar_directo: {
    etiqueta: 'Usar modo "directo"',
    queHace: 'Cambia el ajuste transcriptor_resumen_modo a "directo" (lo decidido el 16 oct: sin Batch). El aviso se cierra al confirmar el cambio.',
  },
  revisar: {
    etiqueta: 'Volver a revisar',
    queHace: 'Vuelve a revisar ahora mismo el problema. Si ya está arreglado, el aviso se cierra; si no, sigue y te dice qué falta.',
  },
};

// ─── Clase de cada aviso (por su clave) ───────────────────────────────────────

export type ClaseAviso =
  | { k: 'paso'; paso: EstadoGrabacion; sinAudio?: boolean }   // falla de un paso de la grabación
  | { k: 'info'; paso: EstadoGrabacion }                         // informativo de una grabación
  | { k: 'bot_maquina' }
  | { k: 'respaldo_grabacion' }
  | { k: 'chequeo'; chequeo: string }                            // salud:<chequeo>[:…]
  | { k: 'salud_completo' }                                       // salud:cron / salud:registro
  | { k: 'reporte' }
  | { k: 'calendario' }
  | { k: 'resumen_modo' }
  | { k: 'robot_sesion' }                                        // robot:sesion (avisosRobot.ts)
  | { k: 'apagado' }
  | { k: 'otro' };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RE_ATASCADA = new RegExp(`^salud:atascadas:(${UUID})(?::([a-z_]+))?$`, 'i');
const PASO_POR_TIPO: Record<string, EstadoGrabacion> = { bot: 'bot_lanzando', subida: 'subida', transcripcion: 'transcribiendo', resumen: 'resumiendo' };

export function claseDe(a: Pick<AlertaFila, 'tipo' | 'clave' | 'grabacion_id'>): ClaseAviso {
  const c = a.clave ?? '';
  const at = RE_ATASCADA.exec(c);
  if (at) {
    const paso = (at[2] as EstadoGrabacion | undefined) ?? PASO_POR_TIPO[a.tipo] ?? 'transcribiendo';
    return { k: 'paso', paso };
  }
  // Robot de Meet (avisosRobot.ts): sesión de su cuenta, no quedó invitado, error que informó.
  if (c === CLAVE_ROBOT_SESION) return { k: 'robot_sesion' };
  if (new RegExp(`^${PREFIJO_ROBOT_INVITADO}${UUID}$`, 'i').test(c)) return { k: 'info', paso: 'bot_en_lobby' };
  const be = new RegExp(`^${PREFIJO_BOT_ERROR}${UUID}:(bot_lanzando|bot_en_lobby|grabando)$`, 'i').exec(c);
  if (be) return { k: 'paso', paso: be[1].toLowerCase() as EstadoGrabacion };
  if (c.startsWith('bot-maquina:')) return { k: 'bot_maquina' };
  if (c.startsWith('bot-vigilante:')) return { k: 'info', paso: 'transcribiendo' };
  if (c.startsWith('sin-voz:')) return { k: 'info', paso: 'transcrita' };
  if (new RegExp(`^respaldo:${UUID}$`, 'i').test(c)) return { k: 'respaldo_grabacion' };
  if (new RegExp(`^subida:${UUID}$`, 'i').test(c)) return { k: 'paso', paso: 'subida', sinAudio: true };
  const m = new RegExp(`^(bot|transcripcion|resumen):${UUID}$`, 'i').exec(c);
  if (m) return { k: 'paso', paso: PASO_POR_TIPO[m[1].toLowerCase()] };
  if (c === 'bot:calendario') return { k: 'calendario' };
  if (c === 'config:resumen-modo') return { k: 'resumen_modo' };
  if (c === 'config:apagado-con-pendientes') return { k: 'apagado' };
  if (c === 'salud:cron' || c === 'salud:registro') return { k: 'salud_completo' };
  if (c === 'salud:reporte') return { k: 'reporte' };
  const s = /^salud:([a-z0-9_]+)(?::.*)?$/.exec(c);
  if (s) return { k: 'chequeo', chequeo: s[1] };
  if (a.grabacion_id && PASO_POR_TIPO[a.tipo]) return { k: 'paso', paso: PASO_POR_TIPO[a.tipo] };
  return { k: 'otro' };
}

export const esDeGrabacion = (c: ClaseAviso) => c.k === 'paso' || c.k === 'info' || c.k === 'bot_maquina' || c.k === 'respaldo_grabacion';

// ─── ¿El problema ya se arregló? (cierre automático) ─────────────────────────

const RANGO: Record<EstadoGrabacion, number> = {
  creada: 0, sin_consentimiento: 0, bot_lanzando: 1, bot_en_lobby: 2, grabando: 3, pausada: 3, subiendo: 4,
  subida: 5, transcribiendo: 6, transcrita: 7, resumiendo: 8, lista: 9,
  sin_audio: 99, cancelada: 99, bot_no_admitido: 99, error: -1,
};
const TERMINALES_AVISO: readonly EstadoGrabacion[] = ['lista', 'sin_audio', 'cancelada', 'bot_no_admitido'];

/** Estado al que tiene que llegar la grabación para que el paso que falló cuente como logrado. */
export function umbralExito(paso: EstadoGrabacion): EstadoGrabacion {
  switch (paso) {
    case 'creada': case 'grabando': case 'pausada': case 'subiendo': return 'subida';
    case 'bot_lanzando': return 'bot_en_lobby';
    case 'bot_en_lobby': return 'grabando';
    case 'subida': return 'transcribiendo';
    case 'transcribiendo': return 'transcrita';
    case 'transcrita': case 'resumiendo': return 'lista';
    default: return 'lista';
  }
}

/**
 * true = el problema del aviso ya no existe y se puede cerrar (función pura).
 * `sesion`: null = la grabación ya no existe; undefined = no se pudo leer (no se cierra nada).
 * Solo avisos de una grabación: los de chequeos se cierran al re-ejecutar el chequeo.
 */
export function alertaSuperada(a: Pick<AlertaFila, 'tipo' | 'clave' | 'grabacion_id'>, sesion: SesionDeAlerta | null | undefined): boolean {
  const c = claseDe(a);
  if (!esDeGrabacion(c) || !a.grabacion_id || sesion === undefined) return false;
  if (sesion === null) return true;
  if (c.k === 'respaldo_grabacion') return sesion.b2_pendientes === 0;
  if (c.k === 'bot_maquina') return !['bot_lanzando', 'bot_en_lobby', 'grabando'].includes(sesion.estado) || !sesion.bot_machine_id;
  if (TERMINALES_AVISO.includes(sesion.estado)) return true;
  const efectivo = sesion.estado === 'error' ? sesion.estado_antes_error : sesion.estado;
  if (!efectivo) return false;
  return RANGO[efectivo] >= RANGO[umbralExito(c.paso)];
}

// ─── Acciones disponibles (función pura) ──────────────────────────────────────

const ACCION_POR_CHEQUEO: Record<string, AccionAviso> = {
  copias_b2: 'copiar_b2', aai_borrado: 'borrar_aai', aai_huerfanos: 'borrar_huerfanos',
  audio_borrado: 'borrar_audio', respaldo_supabase: 'lanzar_respaldo',
};

const esPasoResumen = (s: Pick<SesionDeAlerta, 'estado' | 'estado_antes_error'>) =>
  ['transcrita', 'resumiendo'].includes(s.estado) || (s.estado === 'error' && ['transcrita', 'resumiendo'].includes(s.estado_antes_error ?? ''));

/**
 * Acciones del aviso, la que repara primero y "Volver a revisar" al final (siempre está).
 * `sesion` undefined = no se conoce el estado (correo): se usa la acción guardada en el aviso.
 */
export function accionesDisponibles(
  a: Pick<AlertaFila, 'tipo' | 'clave' | 'grabacion_id' | 'accion'>,
  sesion: SesionDeAlerta | null | undefined,
  ahora: Date = new Date(),
): AccionAviso[] {
  const c = claseDe(a);
  const out: AccionAviso[] = [];
  switch (c.k) {
    case 'bot_maquina': out.push('apagar_bot'); break;
    case 'respaldo_grabacion': out.push('copiar_b2'); break;
    case 'info': break;
    case 'paso': {
      if (sesion === null) break;
      if (sesion === undefined) {
        if (a.accion === 'reintentar' || a.accion === 'reintentar_resumen') out.push(a.accion);
        break;
      }
      const accion: AccionAviso = esPasoResumen(sesion) ? 'reintentar_resumen' : 'reintentar';
      if (c.sinAudio && sesion.estado === 'error') { out.push('rescatar'); break; }
      const plan = planReintento(sesion, accion === 'reintentar_resumen' ? 'reintentar_resumen' : 'reintentar', false, ahora);
      if (plan.tipo === 'reintentar_error' || plan.tipo === 'soltar') out.push(accion);
      else if (plan.tipo === 'manual' && sesion.estado === 'error') out.push('rescatar');
      break;
    }
    case 'chequeo': { const x = ACCION_POR_CHEQUEO[c.chequeo]; if (x) out.push(x); break; }
    case 'resumen_modo': out.push('usar_directo'); break;
    default: break;
  }
  out.push('revisar');
  return out;
}

/** Etiqueta según el caso (p. ej. "rescatar" sin audio subido = cerrar como no grabada). */
export function etiquetaAccion(accion: AccionAviso, sesion?: SesionDeAlerta | null): string {
  if (accion === 'rescatar' && sesion) {
    return (sesion.segmentos_subidos ?? 0) > 0 ? 'Transcribir lo que alcanzó a grabarse' : 'Cerrar la sesión como no grabada';
  }
  return INFO_ACCION[accion].etiqueta;
}

const PROVEEDOR: Record<string, string> = { r2: 'Cloudflare R2 (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)', b2: 'Backblaze B2 (B2_KEY_ID / B2_APPLICATION_KEY)', assemblyai: 'AssemblyAI (ASSEMBLYAI_API_KEY)', anthropic: 'Anthropic (ANTHROPIC_API_KEY)' };

/**
 * Qué hacer cuando no hay arreglo automático (o qué esperar después de la acción). Texto exacto,
 * sin datos de la sesión. null = la acción principal basta.
 */
export function instruccionDe(a: Pick<AlertaFila, 'tipo' | 'clave' | 'grabacion_id' | 'accion'>, sesion: SesionDeAlerta | null | undefined, ahora: Date = new Date()): string | null {
  const c = claseDe(a);
  const despues = 'Después toca «Volver a revisar».';
  switch (c.k) {
    case 'info':
      if (a.clave.startsWith(PREFIJO_ROBOT_INVITADO)) return 'El robot pedirá unirse a la reunión: admítelo en Meet. El aviso se cierra solo cuando entra a grabar (o cuando la sesión termina).';
      return 'Es informativo: el aviso se cierra solo cuando la sesión termina de procesarse.';
    case 'robot_sesion': return `${PASOS_RELOGIN} Mientras tanto el robot entra como invitado y tú lo admites en Meet. ${despues}`;
    case 'paso': {
      if (!sesion) return null;
      const acc = accionesDisponibles(a, sesion, ahora);
      if (acc.length > 1) return null;
      const plan = planReintento(sesion, esPasoResumen(sesion) ? 'reintentar_resumen' : 'reintentar', false, ahora);
      return plan.tipo === 'manual' || plan.tipo === 'nada' ? `${plan.mensaje} ${despues}` : null;
    }
    case 'chequeo': {
      const ch = c.chequeo;
      if (a.clave.endsWith(':no_revisado')) return 'El chequeo no alcanzó a correr (el proveedor no respondió a tiempo). Toca «Volver a revisar» para correrlo ahora.';
      if (ch === 'config') return `Agrega en Vercel (Settings → Environment Variables, entorno Production) cada variable que aparece en el detalle y vuelve a desplegar (Deployments → Redeploy). ${despues}`;
      if (PROVEEDOR[ch]) return `Revisa en Vercel la llave de ${PROVEEDOR[ch]}: si venció o la cambiaste, pega la nueva y vuelve a desplegar. Si el proveedor está caído, espera unos minutos. ${despues}`;
      if (ch === 'gasto') return 'No tiene arreglo automático: el gasto es lo ya usado este mes. El aviso se cierra solo cuando el gasto o la proyección bajan del presupuesto (al empezar el mes siguiente o si se sube el presupuesto en Transcriptor). Puedes tocar «Volver a revisar» cuando quieras.';
      if (ch === 'permisos_microfono') return `La regla Permissions-Policy de vercel.json cambió: debe volver a decir microphone=(self) solo en /admin/grabar y microphone=() en el resto. Pídeselo a Claude y despliega. ${despues}`;
      if (ch === 'respaldo_supabase') return 'Toca «Lanzar respaldo ahora» (tarda unos minutos) y después «Volver a revisar».';
      if (ch === 'atascadas') return null;
      return null;
    }
    case 'calendario': return `Abre Configuración y vuelve a conectar Google Calendar si te lo pide. ${despues}`;
    case 'apagado': return `Enciende el transcriptor en la página Transcriptor para que termine esas grabaciones. ${despues}`;
    case 'salud_completo': return 'Toca «Volver a revisar» para correr ahora el chequeo diario completo.';
    case 'reporte': return 'Toca «Volver a revisar» para generar ahora el reporte del mes anterior.';
    default: return null;
  }
}

// ─── Ejecución ────────────────────────────────────────────────────────────────

export interface ResultadoBorrado { borrados: number; omitidos: number; fallidos: number }

export interface OpsAcciones {
  obtenerAlerta(id: string): Promise<AlertaFila | null>;
  /** Cierra la alerta abierta (resuelta_por = 'sistema'). true si la cerró. */
  cerrarAlerta(id: string): Promise<boolean>;
  /** Estado de la grabación para el aviso. null = no existe. */
  leerSesion(grabacionId: string): Promise<SesionDeAlerta | null>;
  reintento: OpsReintento;
  /** error → 'subida' si hay audio subido, si no → 'cancelada'. null si la grabación cambió. */
  rescatar(grabacionId: string): Promise<{ hacia: 'subida' | 'cancelada' } | null>;
  apagarBot(machineId: string): Promise<void>;
  /** Copia a B2 las transcripciones sin copia (de esa grabación, o todas con null). */
  copiarB2(grabacionId: string | null): Promise<{ copiadas: number; fallidas: number }>;
  borrarAai(): Promise<ResultadoBorrado>;
  borrarHuerfanos(): Promise<ResultadoBorrado>;
  borrarAudio(): Promise<ResultadoBorrado>;
  lanzarRespaldo(): Promise<{ ok: boolean; mensaje: string }>;
  usarDirecto(): Promise<void>;
  leerModoResumen(): Promise<string>;
  /** Re-ejecuta ese chequeo de salud (registra o cierra sus avisos como el diario). */
  revisarChequeo(chequeo: string): Promise<void>;
  /** Chequeo diario completo. registroOk = se pudo guardar el resultado. */
  revisarSaludCompleta(): Promise<{ registroOk: boolean }>;
  generarReporte(): Promise<void>;
  probarCalendario(): Promise<void>;
  apagadoConPendientes(): Promise<{ activo: boolean; pendientes: number }>;
  /** true = el robot no necesita su sesión (modo 'invitado') o la tiene vigente. Opcional (avisosRobot.ts). */
  robotSesionOk?(): Promise<boolean>;
}

export interface ResultadoAccion {
  ok: boolean;
  /** true = el aviso quedó cerrado (el problema está arreglado). */
  cerrada: boolean;
  mensaje: string;
  /** Para la bitácora (sin contenido clínico). */
  detalle?: Record<string, unknown>;
}

const errTxt = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, '[url]').slice(0, 200);

export async function ejecutarAccionAviso(id: string, accion: AccionAviso, ops: OpsAcciones, ahora: Date = new Date()): Promise<ResultadoAccion> {
  const a = await ops.obtenerAlerta(id);
  if (!a) return { ok: false, cerrada: false, mensaje: 'Ese aviso ya no existe.' };
  if (a.resuelta_at) return { ok: true, cerrada: true, mensaje: 'Este aviso ya estaba resuelto: el problema se arregló.' };
  const c = claseDe(a);
  const deGrabacion = esDeGrabacion(c) && !!a.grabacion_id;
  let sesion: SesionDeAlerta | null | undefined = deGrabacion ? await ops.leerSesion(a.grabacion_id!) : undefined;

  const cerrarSiArreglado = async (): Promise<boolean> => {
    if (!deGrabacion) return false;
    sesion = await ops.leerSesion(a.grabacion_id!);
    if (!alertaSuperada(a, sesion)) return false;
    await ops.cerrarAlerta(a.id);
    return true;
  };
  /** Re-lee el aviso: ¿lo cerró el chequeo? */
  const cerradaAhora = async () => !!(await ops.obtenerAlerta(a.id))?.resuelta_at;

  if (deGrabacion && alertaSuperada(a, sesion)) {
    await ops.cerrarAlerta(a.id);
    return { ok: true, cerrada: true, mensaje: 'Ya estaba arreglado: el aviso se cerró.' };
  }
  const disponibles = accionesDisponibles(a, sesion, ahora);
  if (!disponibles.includes(accion)) {
    return { ok: false, cerrada: false, mensaje: 'Esa acción ya no corresponde a este aviso. Recarga la página para ver las que sirven ahora.' };
  }

  switch (accion) {
    case 'reintentar':
    case 'reintentar_resumen': {
      const r = await ejecutarReintento(a.grabacion_id!, accion, ops.reintento);
      const detalle = { desde: r.desde ?? null, hacia: r.hacia ?? null };
      if (!r.ok) return { ok: false, cerrada: false, mensaje: r.mensaje, detalle };
      if (await cerrarSiArreglado()) return { ok: true, cerrada: true, mensaje: 'Listo: ese paso ya está hecho y el aviso se cerró.', detalle };
      return { ok: true, cerrada: false, mensaje: `${r.mensaje} El aviso se cierra solo cuando ese paso salga bien.`, detalle };
    }
    case 'rescatar': {
      const r = await ops.rescatar(a.grabacion_id!);
      if (!r) return { ok: false, cerrada: false, mensaje: 'La sesión cambió mientras tanto. Recarga la página.' };
      const cerrada = await cerrarSiArreglado();
      return {
        ok: true, cerrada, detalle: { hacia: r.hacia },
        mensaje: r.hacia === 'subida'
          ? 'Listo: se transcribe lo que alcanzó a grabarse (empieza en el próximo minuto).'
          : 'Listo: la sesión quedó cerrada como no grabada (no había audio).',
      };
    }
    case 'apagar_bot': {
      const machineId = sesion?.bot_machine_id;
      if (!machineId) {
        const cerrada = await cerrarSiArreglado();
        return { ok: cerrada, cerrada, mensaje: cerrada ? 'La máquina ya no existe: el aviso se cerró.' : 'No quedó registrada la máquina de esa sesión.' };
      }
      try { await ops.apagarBot(machineId); }
      catch (e) { return { ok: false, cerrada: false, mensaje: `Fly.io no pudo apagar la máquina: ${errTxt(e)}. Revisa FLY_API_TOKEN en Vercel y vuelve a intentar.` }; }
      await ops.cerrarAlerta(a.id); // Fly confirmó: la máquina ya no existe (el problema era ese)
      return { ok: true, cerrada: true, mensaje: 'Listo: la máquina del asistente se apagó.' };
    }
    case 'copiar_b2': {
      const r = await ops.copiarB2(deGrabacion ? a.grabacion_id! : null);
      let cerrada: boolean;
      if (deGrabacion) cerrada = await cerrarSiArreglado();
      else { await ops.revisarChequeo('copias_b2'); cerrada = await cerradaAhora(); }
      const detalle = { copiadas: r.copiadas, fallidas: r.fallidas };
      if (cerrada) return { ok: true, cerrada, detalle, mensaje: `Listo: ${r.copiadas === 1 ? '1 copia hecha' : `${r.copiadas} copias hechas`} en B2. El aviso se cerró.` };
      return { ok: false, cerrada, detalle, mensaje: r.fallidas ? `B2 rechazó ${r.fallidas} copia(s). Revisa B2_KEY_ID / B2_APPLICATION_KEY en Vercel y vuelve a intentar.` : 'Quedan copias pendientes. Vuelve a intentar en un minuto.' };
    }
    case 'borrar_aai':
    case 'borrar_huerfanos':
    case 'borrar_audio': {
      let r: ResultadoBorrado;
      try { r = accion === 'borrar_aai' ? await ops.borrarAai() : accion === 'borrar_huerfanos' ? await ops.borrarHuerfanos() : await ops.borrarAudio(); }
      catch (e) { return { ok: false, cerrada: false, mensaje: `No se pudo completar: ${errTxt(e)}. Vuelve a intentar en unos minutos.` }; }
      await ops.revisarChequeo(accion === 'borrar_aai' ? 'aai_borrado' : accion === 'borrar_huerfanos' ? 'aai_huerfanos' : 'audio_borrado');
      const cerrada = await cerradaAhora();
      const detalle = { ...r };
      const base = `Se borraron ${r.borrados}.`;
      if (cerrada) return { ok: true, cerrada, detalle, mensaje: `Listo: ${base} El aviso se cerró.` };
      const partes = [base];
      if (r.omitidos) partes.push(`${r.omitidos} no se tocaron porque su sesión todavía no tiene la transcripción guardada (usa Reintentar en el aviso de esa sesión).`);
      if (r.fallidos) partes.push(`${r.fallidos} fallaron: vuelve a intentar en unos minutos.`);
      return { ok: false, cerrada, detalle, mensaje: partes.join(' ') };
    }
    case 'lanzar_respaldo': {
      const r = await ops.lanzarRespaldo();
      return { ok: r.ok, cerrada: false, mensaje: r.mensaje };
    }
    case 'usar_directo': {
      await ops.usarDirecto();
      const modo = await ops.leerModoResumen();
      if (modo !== 'directo') return { ok: false, cerrada: false, mensaje: 'No se pudo guardar el ajuste. Vuelve a intentar.' };
      await ops.cerrarAlerta(a.id);
      return { ok: true, cerrada: true, mensaje: 'Listo: el resumen usa el modo "directo". El aviso se cerró.' };
    }
    case 'revisar':
      return revisar(a, c, ops, cerrarSiArreglado, cerradaAhora, sesion);
  }
}

async function revisar(
  a: AlertaFila, c: ClaseAviso, ops: OpsAcciones,
  cerrarSiArreglado: () => Promise<boolean>, cerradaAhora: () => Promise<boolean>, sesion: SesionDeAlerta | null | undefined,
): Promise<ResultadoAccion> {
  const sigue = (que: string): ResultadoAccion => ({ ok: false, cerrada: false, mensaje: `Sigue pendiente: ${que}` });
  const listo = async (): Promise<ResultadoAccion> => { await ops.cerrarAlerta(a.id); return { ok: true, cerrada: true, mensaje: 'Revisado: ya está arreglado y el aviso se cerró.' }; };
  try {
    switch (c.k) {
      case 'paso': case 'info': case 'bot_maquina': case 'respaldo_grabacion': {
        if (!a.grabacion_id) return sigue('este aviso no tiene sesión asociada.');
        if (await cerrarSiArreglado()) return { ok: true, cerrada: true, mensaje: 'Revisado: ya está arreglado y el aviso se cerró.' };
        return sigue('la sesión todavía no termina ese paso. Usa la otra acción del aviso o espera unos minutos.');
      }
      case 'chequeo':
        await ops.revisarChequeo(c.chequeo);
        return (await cerradaAhora())
          ? { ok: true, cerrada: true, mensaje: 'Revisado: el chequeo salió bien y el aviso se cerró.' }
          : sigue('el chequeo vuelve a fallar. Mira el detalle del aviso (se actualizó) y lo que dice que hay que hacer.');
      case 'salud_completo': {
        const r = await ops.revisarSaludCompleta();
        if (a.clave === 'salud:registro' && !r.registroOk) return sigue('no se pudo guardar el resultado del chequeo en la base.');
        return listo();
      }
      case 'reporte':
        await ops.generarReporte();
        return listo();
      case 'calendario':
        try { await ops.probarCalendario(); } catch (e) { return sigue(`Google Calendar respondió: ${errTxt(e)}.`); }
        return listo();
      case 'resumen_modo':
        return (await ops.leerModoResumen()) === 'directo' ? listo() : sigue('el ajuste todavía no dice "directo". Toca «Usar modo "directo"».');
      case 'robot_sesion': {
        if (!ops.robotSesionOk) return sigue('no se puede revisar la sesión del robot desde aquí.');
        return (await ops.robotSesionOk()) ? listo() : sigue(`la cuenta del robot todavía no tiene una sesión vigente. ${PASOS_RELOGIN}`);
      }
      case 'apagado': {
        const r = await ops.apagadoConPendientes();
        if (r.activo || r.pendientes === 0) return listo();
        return sigue(`el transcriptor sigue apagado y hay ${r.pendientes} grabación(es) a mitad de proceso.`);
      }
      default:
        void sesion;
        return sigue('no hay un chequeo automático para este aviso.');
    }
  } catch (e) {
    return { ok: false, cerrada: false, mensaje: `No se pudo revisar: ${errTxt(e)}. Vuelve a intentar en unos minutos.` };
  }
}

// ─── Implementación real (Supabase, R2/B2, AssemblyAI, Fly) ──────────────────

export const FLY_APP_RESPALDO_DEFECTO = 'vo-respaldo-supabase';
export const MAQUINA_RESPALDO = 'respaldo-semanal';

/** Lanza la máquina programada del respaldo (Fly Machines API: list + start). Con `fetch` inyectable. */
export async function lanzarMaquinaRespaldo(
  env: { token?: string; app?: string }, f: typeof fetch = fetch,
): Promise<{ ok: boolean; mensaje: string }> {
  const app = env.app?.trim() || FLY_APP_RESPALDO_DEFECTO;
  const manual = `En el Mac: fly machine list -a ${app} y luego fly machine start <id de ${MAQUINA_RESPALDO}> -a ${app}. Cuando termine (unos minutos), toca «Volver a revisar».`;
  if (!/^[a-z0-9-]{2,63}$/.test(app)) return { ok: false, mensaje: 'FLY_APP_RESPALDO no es un nombre de app válido.' };
  if (!env.token) {
    return { ok: false, mensaje: `Para lanzarlo desde el panel falta FLY_API_TOKEN_RESPALDO en Vercel (token de la app ${app}: fly tokens create deploy -a ${app}). Mientras tanto: ${manual}` };
  }
  const H = { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' };
  const base = `https://api.machines.dev/v1/apps/${app}/machines`;
  try {
    const r = await f(base, { headers: H, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) { await r.body?.cancel().catch(() => {}); return { ok: false, mensaje: `Fly.io respondió ${r.status} al listar las máquinas del respaldo. Revisa FLY_API_TOKEN_RESPALDO. ${manual}` }; }
    const lista = (await r.json()) as { id?: string; name?: string; state?: string; config?: { schedule?: string } }[];
    const m = (Array.isArray(lista) ? lista : []).find((x) => x?.name === MAQUINA_RESPALDO) ?? (Array.isArray(lista) ? lista : []).find((x) => !!x?.config?.schedule);
    if (!m?.id || !/^[a-z0-9]{6,40}$/i.test(m.id)) return { ok: false, mensaje: `No se encontró la máquina ${MAQUINA_RESPALDO} en Fly. Hay que crearla (bot/README.md § Respaldo semanal, paso d).` };
    if (m.state === 'started' || m.state === 'starting') return { ok: true, mensaje: 'El respaldo ya está corriendo. En unos minutos toca «Volver a revisar».' };
    const s = await f(`${base}/${m.id}/start`, { method: 'POST', headers: H, signal: AbortSignal.timeout(15_000) });
    await s.body?.cancel().catch(() => {});
    if (!s.ok) return { ok: false, mensaje: `Fly.io no pudo encender la máquina (${s.status}). ${manual}` };
    return { ok: true, mensaje: 'Listo: el respaldo empezó. Tarda unos minutos; después toca «Volver a revisar» y el aviso se cierra si el respaldo quedó en B2.' };
  } catch (e) {
    return { ok: false, mensaje: `No se pudo contactar a Fly.io (${errTxt(e)}). ${manual}` };
  }
}

const POST_TRANSCRIPCION: readonly EstadoGrabacion[] = ['transcrita', 'resumiendo', 'lista'];
const SIN_PROCESO: readonly EstadoGrabacion[] = ['cancelada', 'sin_audio'];

export async function opsAccionesReales(): Promise<OpsAcciones> {
  const { supabase: db } = await import('../supabase');
  const alertas = await import('./alertas');
  const { limpiezaReintento } = await import('./estados');
  const { auditar } = await import('./auditoria');
  const repo = alertas.repoAlertasSupabase(db);
  const { secreto: secretoRt } = await import('../secretos');
  const ahoraIso = () => new Date().toISOString();

  return {
    obtenerAlerta: (id) => repo.obtener(id),
    cerrarAlerta: async (id) => (await repo.resolver({ id }, ahoraIso())) > 0,
    leerSesion: (gid) => alertas.leerSesionDeAlerta(db, gid),
    reintento: await opsReintentoSupabase(),
    async rescatar(gid) {
      const { data: g } = await db.from('grabaciones').select('id, estado, bot_machine_id').eq('id', gid).maybeSingle();
      const fila = g as { estado?: string; bot_machine_id?: string | null } | null;
      if (fila?.estado !== 'error') return null;
      if (fila.bot_machine_id) {
        try { const { crearBot } = await import('./bot'); await crearBot({ db }).matarBot(fila.bot_machine_id); } catch { /* ya no existe o Fly no responde: el token se revoca igual abajo */ }
      }
      const { count } = await db.from('grabacion_segmentos').select('id', { count: 'exact', head: true }).eq('grabacion_id', gid).not('subido_at', 'is', null);
      const hacia = (count ?? 0) > 0 ? 'subida' as const : 'cancelada' as const;
      const ahora = ahoraIso();
      if (hacia === 'subida') await db.from('grabacion_segmentos').delete().eq('grabacion_id', gid).is('subido_at', null);
      const { data, error } = await db.from('grabaciones').update({
        ...limpiezaReintento(hacia), estado: hacia, bot_token_vence_at: ahora,
        nota_sistema: hacia === 'subida'
          ? 'El asistente de notas se cayó antes de terminar. Se transcribe lo que alcanzó a subir.'
          : 'Sesión cerrada como no grabada: no llegó audio.',
      }).eq('id', gid).eq('estado', 'error').select('id').maybeSingle();
      if (error) throw new Error(`rescatar: ${error.message}`);
      return data ? { hacia } : null;
    },
    async apagarBot(machineId) {
      const { crearBot } = await import('./bot');
      await crearBot({ db }).matarBot(machineId);
    },
    async copiarB2(gid) {
      const { almacenamiento } = await import('./almacenamiento');
      let q = db.from('transcripciones').select('id, grabacion_id, r2_key').is('b2_key', null).is('deleted_at', null);
      if (gid) q = q.eq('grabacion_id', gid);
      const { data, error } = await q.limit(100);
      if (error) throw new Error(`transcripciones: ${error.message}`);
      let copiadas = 0, fallidas = 0;
      for (const tr of (data ?? []) as { id: string; grabacion_id: string; r2_key: string }[]) {
        try {
          const { b2Key } = await almacenamiento.copiarAB2(tr.r2_key);
          const { error: e2 } = await db.from('transcripciones').update({ b2_key: b2Key, b2_copiada_at: ahoraIso() }).eq('id', tr.id).is('b2_key', null);
          if (e2) throw new Error(e2.message);
          copiadas++;
          await auditar('vale', 'copia_b2', { grabacionId: tr.grabacion_id, detalle: { origen: 'aviso' }, cliente: db });
        } catch { fallidas++; }
      }
      // El paso `respaldos` del orquestador también cierra estos avisos cuando copia.
      return { copiadas, fallidas };
    },
    async borrarAai() {
      const { assemblyai } = await import('./dependencias-p4');
      const { borrarTranscriptTrasGuardar } = await import('./assemblyai');
      type Fila = { id: string; grabacion_id: string; aai_transcript_id: string; aai_borrado_at: string | null; grabaciones: { estado: EstadoGrabacion } | { estado: EstadoGrabacion }[] | null };
      const { data, error } = await db.from('grabacion_segmentos')
        .select('id, grabacion_id, aai_transcript_id, aai_borrado_at, grabaciones!inner(estado)')
        .not('aai_transcript_id', 'is', null).is('aai_borrado_at', null).in('aai_estado', ['completed', 'error']).limit(200);
      if (error) throw new Error(`segmentos: ${error.message}`);
      const r: ResultadoBorrado = { borrados: 0, omitidos: 0, fallidos: 0 };
      for (const s of (data ?? []) as Fila[]) {
        const estado = (Array.isArray(s.grabaciones) ? s.grabaciones[0] : s.grabaciones)?.estado;
        try {
          if (estado && SIN_PROCESO.includes(estado)) {
            // Sesión cancelada / sin audio: nunca se guardará nada, el transcript se borra.
            await assemblyai.borrar(s.aai_transcript_id);
            await db.from('grabacion_segmentos').update({ aai_borrado_at: ahoraIso() }).eq('id', s.id).is('aai_borrado_at', null);
            await auditar('vale', 'borrar_aai', { grabacionId: s.grabacion_id, detalle: { origen: 'aviso' }, cliente: db });
            r.borrados++;
          } else if (await borrarTranscriptTrasGuardar(s, { aai: assemblyai, db })) r.borrados++;
          else r.omitidos++; // sin transcripción guardada: borrarla perdería la sesión
        } catch { r.fallidos++; }
      }
      return r;
    },
    async borrarHuerfanos() {
      const salud = await import('./salud');
      const r = await salud.borrarHuerfanosAhora(await salud.fuentesReales(), new Date(), { incluirDesconocidos: true });
      if (r.borrados) await auditar('vale', 'borrar_aai', { detalle: { origen: 'aviso', huerfanos: r.borrados }, cliente: db });
      return r;
    },
    async borrarAudio() {
      const { almacenamiento } = await import('./almacenamiento');
      const salud = await import('./salud');
      const r: ResultadoBorrado = { borrados: 0, omitidos: 0, fallidos: 0 };
      type Fila = { id: string; grabacion_id: string; r2_key: string; grabaciones: { estado: EstadoGrabacion } | { estado: EstadoGrabacion }[] | null };
      const { data, error } = await db.from('grabacion_segmentos').select('id, grabacion_id, r2_key, grabaciones!inner(estado)')
        .is('audio_borrado_at', null).limit(500);
      if (error) throw new Error(`segmentos: ${error.message}`);
      const filas = (data ?? []) as Fila[];
      const gids = [...new Set(filas.map((s) => s.grabacion_id))];
      const guardadas = new Set<string>();
      if (gids.length) {
        const { data: ts } = await db.from('transcripciones').select('grabacion_id, sha256_cifrado').in('grabacion_id', gids).is('deleted_at', null);
        for (const t of (ts ?? []) as { grabacion_id: string; sha256_cifrado: string | null }[]) if (t.sha256_cifrado) guardadas.add(t.grabacion_id);
      }
      const porGrabacion = new Map<string, number>();
      for (const s of filas) {
        const estado = (Array.isArray(s.grabaciones) ? s.grabaciones[0] : s.grabaciones)?.estado;
        const puede = !!estado && (SIN_PROCESO.includes(estado) || (POST_TRANSCRIPCION.includes(estado) && guardadas.has(s.grabacion_id)));
        if (!puede) continue; // en curso: el orquestador lo borra después de guardar
        try {
          await almacenamiento.borrarAudio(s.r2_key);
          await db.from('grabacion_segmentos').update({ audio_borrado_at: ahoraIso() }).eq('id', s.id);
          r.borrados++; porGrabacion.set(s.grabacion_id, (porGrabacion.get(s.grabacion_id) ?? 0) + 1);
        } catch { r.fallidos++; }
      }
      // Archivos con más de 1 día (la regla de ciclo de vida del bucket debió borrarlos).
      try {
        const objetos = await almacenamiento.listar('audio', 'a/', 1000);
        const limite = Date.now() - salud.AUDIO_R2_MAX_MS;
        for (const o of objetos) {
          if (!o.modificado || o.modificado.getTime() > limite) continue;
          try { await almacenamiento.borrarAudio(o.key); r.borrados++; } catch { r.fallidos++; }
        }
      } catch { r.fallidos++; }
      for (const [gid, n] of porGrabacion) await auditar('vale', 'borrar_audio', { grabacionId: gid, detalle: { origen: 'aviso', segmentos: n }, cliente: db });
      return r;
    },
    lanzarRespaldo: () => lanzarMaquinaRespaldo({
      // Llave SOLO en runtime (secretos.ts): nunca import.meta.env (A2/M1).
      token: secretoRt('FLY_API_TOKEN_RESPALDO')?.trim() || undefined,
      app: typeof process !== 'undefined' ? process.env?.FLY_APP_RESPALDO : undefined,
    }),
    async usarDirecto() {
      const { error } = await db.from('settings').upsert({ key: 'transcriptor_resumen_modo', value: 'directo' }, { onConflict: 'key' });
      if (error) throw new Error(`settings: ${error.message}`);
      await auditar('vale', 'cambiar_ajuste', { detalle: { clave: 'transcriptor_resumen_modo', valor: 'directo', origen: 'aviso' }, cliente: db });
    },
    async leerModoResumen() {
      const { data } = await db.from('settings').select('value').eq('key', 'transcriptor_resumen_modo').maybeSingle();
      return String((data as { value?: string } | null)?.value ?? 'directo').trim() || 'directo';
    },
    async revisarChequeo(chequeo) {
      const salud = await import('./salud');
      await salud.ejecutarSaludReal(new Date(), { solo: [chequeo as never] });
    },
    async revisarSaludCompleta() {
      const salud = await import('./salud');
      const r = await salud.ejecutarSaludReal(new Date());
      return { registroOk: r.registroOk };
    },
    async generarReporte() {
      const { reporteDelMesAnteriorSiFalta } = await import('./reporte');
      await reporteDelMesAnteriorSiFalta(new Date());
    },
    async probarCalendario() {
      const { crearBot } = await import('./bot');
      const ahora = Date.now();
      await crearBot({ db }).sesionesOnlineProximas(new Date(ahora), new Date(ahora + 60 * 60_000));
    },
    async apagadoConPendientes() {
      const { data } = await db.from('settings').select('value').eq('key', 'transcriptor_activo').maybeSingle();
      const activo = String((data as { value?: string } | null)?.value ?? '').trim().toLowerCase() === 'true';
      const { count } = await db.from('grabaciones').select('id', { count: 'exact', head: true })
        .in('estado', ['subida', 'transcribiendo', 'transcrita', 'resumiendo']);
      return { activo, pendientes: count ?? 0 };
    },
    async robotSesionOk() {
      const { leerModoBot, cuentaRobotVigente } = await import('./botCuenta');
      return (await leerModoBot(db)) === 'invitado' || !!(await cuentaRobotVigente(db));
    },
  };
}

/**
 * Para el chequeo diario: revisa los avisos sueltos que nadie más cierra (calendario, ajustes del
 * resumen, transcriptor apagado con pendientes, sesión del robot). Nunca lanza.
 */
export async function revisarAvisosSueltos(ops?: OpsAcciones, listar?: () => Promise<AlertaFila[]>): Promise<number> {
  try {
    const o = ops ?? await opsAccionesReales();
    const filas = listar ? await listar() : await (await import('./alertas')).listarAlertasAbiertas(200);
    let n = 0;
    for (const f of filas) {
      const k = claseDe(f).k;
      if (k !== 'calendario' && k !== 'resumen_modo' && k !== 'apagado' && k !== 'robot_sesion') continue;
      if ((await ejecutarAccionAviso(f.id, 'revisar', o)).cerrada) n++;
    }
    return n;
  } catch (e) {
    console.warn('[transcriptor/acciones] revisarAvisosSueltos:', errTxt(e));
    return 0;
  }
}
