// Transcriptor IA — orquestador (paquete P6). Lo llama /api/cron/transcriptor cada minuto (pg_cron).
// Diseño: 50-arquitectura §3.7, §4 (estados y errores), §5; decisiones de 01-decisiones-16oct.md
// (1: resumen por Messages API directa, sin Batch; 8: cada error definitivo → aviso en el panel).
//
// Pasos (cada uno acotado por tiempo y con toma atómica por fila — estados.tomar —, así dos
// ejecuciones solapadas nunca hacen dos veces lo mismo):
//   1. vigilar        bots vivos después de HORA_FIN + 40 min → se apaga la máquina y se cierra la grabación.
//   2. despacharBots  sesiones online que empiezan en [ahora−5, ahora+4] min (si transcriptor_bot_activo):
//                     INSERT en bot_lanzando (google_event_id único: solo quien inserta lanza) → lanzarBot.
//                     despacharPorEnlace (18 oct): el mismo despacho para UNA sesión cuando alguien abre su
//                     enlace propio /sesion/<código>, en [inicio − 30 min, fin) (enlaceSesionRuta.ts).
//   3. resumir        transcrita → resumiendo → lista (resumen.resumirSesion, modo 'directo', guarda prompt_version).
//   4. reintentarEnvios  segmentos subidos sin transcript en AssemblyAI → enviar (backoff 1/5/15/60 min, máx. 6).
//   5. procesarTranscripciones  sondeo sin webhook (> 30 min), errores de AssemblyAI (decisionTrasErrorAAI),
//                     todos completed → unir (hablantes) → cifrar y guardar → borrar en AssemblyAI → borrar audio.
//   6. limpiar        'creada' huérfanas (sin audio, > 72 h) → cancelada; tomas vencidas → liberadas.
// Cada error definitivo o reintento agotado → registrarAlerta (alertas.ts, P8) + estado 'error'.
// Nunca contenido clínico en alertas, errores ni bitácora: solo fecha, hora y tipo de sesión.
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AJUSTES, MODELO_RESUMEN, MODELO_U35_PRO, TIEMPOS,
  type AccionAuditoria, type AssemblyAI, type Bot, type DecisionModelo, type EstadoGrabacion, type Grabacion,
  type Pipeline, type PuedeGrabar, type ResultadoTranscripcion, type ResumenIA, type Segmento, type SesionOnline, type TipoSesion,
} from './tipos';
import { leaseVencido, marcarError, reintentar, soltar, tomar, transicionar } from './estados';
import {
  cerrarConLoGrabado, debeRelanzarBot, eventIdLiberado, GRACIA_REVISAR_MAQUINA_MS, lanzamientosDe, MAX_LANZAMIENTOS_BOT,
  NOTA_NADIE_LLEGO, NOTA_SIN_CONSENTIMIENTO_BOT, prepararRelanzamiento, previaLiberable, RESTANTE_MIN_ERROR_MS, type PreviaEvento,
} from './botReconexion';
import { extenderUsoSesion, liberarSesion } from './botCuenta';
import { elegirModelo } from './reglas';
import { repararMojibake } from './texto';
import { borrarTranscriptTrasGuardar, decisionTrasErrorAAI, ErrorAssemblyAI, sanearMensaje, textoErrorDefinitivoAAI } from './assemblyai';
import { notaRobotSinPermiso } from './consentimiento';
import { armarTranscripcionClara, esTramoHueco } from './hablantes';
import {
  cargarInstrucciones, contextoSesionAnterior, nombreDePila, plantillaDesdeTipo, resumirSesion,
  type Participante, type PeticionResumenCompleta, type ResultadoResumen,
} from './resumen';
import { clasificarError, type ClienteMensajes, type OpcionesReintento } from './claude';
import { auditar } from './auditoria';
import { registrarAlerta as registrarAlertaP8, resolverAlertasDe as resolverAlertasDeP8, type NuevaAlerta, type AlertaTipo } from './alertas';
import type { AlmacenamientoTranscriptor, ResultadoGuardado } from './almacenamiento';
import { columnasContenidoCifrado, leerContenidoResumen } from './resumenCifrado';
import { ACCION_EVOLUCION_AUTO, autollenarEvolucion } from './evolucionAuto';
import type { CifradoVOT1 } from './cifrado';

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Tiempo de trabajo de los pasos cortos por ejecución (vigilar, bots, envíos, guardar, limpiar). */
export const PRESUPUESTO_MS = 50_000;
/**
 * El resumen tiene presupuesto propio (82-revision-codigo A1): una sesión de pareja de 60 min puede
 * tardar más de 45 s en Sonnet. Requiere maxDuration = 300 en astro.config.mjs (Fluid compute).
 * LIMITE_RESUMEN_MS = tope de UNA llamada; PRESUPUESTO_RESUMEN_MS = desde el inicio de la corrida.
 */
export const LIMITE_RESUMEN_MS = 240_000;
export const PRESUPUESTO_RESUMEN_MS = 285_000;
/** Un resumen no se empieza si quedan menos de esto (Sonnet tarda ~20–90 s). */
export const MIN_RESUMEN_MS = 30_000;
/** Mínimo para empezar a guardar una transcripción (descargar, unir, cifrar, borrar). */
export const MIN_GUARDAR_MS = 12_000;
/**
 * Ventana del despacho de bots (50-arquitectura §1.3): sesiones que empiezan en [ahora−20, ahora+4] min.
 * r2 (punto 5): antes era −5 min; si el cron o Calendar fallaban esos minutos la sesión quedaba sin robot.
 * Con 20 min se cubre una caída corta; no duplica porque solo se despacha si el evento no tiene grabación.
 */
export const VENTANA_BOT_ANTES_MS = 20 * 60_000;
export const VENTANA_BOT_DESPUES_MS = 4 * 60_000;
/** r2 (punto 7): eventos empezados hasta hace 3 h se leen igual, solo para seguir su hora si Vale los mueve. */
export const VENTANA_SINCRONIZAR_MS = 3 * 60 * 60_000;
/**
 * Enlace propio de la sesión (/sesion/<código>, pedido de Vale 18 oct): abrirlo despacha el robot desde
 * 30 min antes del inicio hasta el término. El robot espera hasta 30 min a que llegue alguien
 * (bot/src/vigia.ts); si sale por "nadie llegó", un clic posterior lo vuelve a mandar.
 */
export const VENTANA_ENLACE_ANTES_MS = 30 * 60_000;

/** Resultado del despacho de una sesión (sin datos de pacientes: va a la bitácora del enlace). */
export type ResultadoDespacho = 'lanzado' | 'activo' | 'existe' | 'fuera' | 'sin_consentimiento' | 'fallo';

/** ¿Abrir el enlace ahora despacha el robot? [inicio − 30 min, fin). */
export function enVentanaEnlace(inicio: string, fin: string, ahora: Date): boolean {
  const i = Date.parse(inicio), f = Date.parse(fin), t = ahora.getTime();
  if (Number.isNaN(i) || Number.isNaN(f)) return false;
  return t >= i - VENTANA_ENLACE_ANTES_MS && t < f;
}

/**
 * Intento anterior del MISMO evento que se puede repetir al abrir el enlace (nunca uno con audio, uno
 * activo, ni una decisión de Vale o del paciente: no admitido, retirado, cancelado):
 *  - 'liberar'            : el robot salió porque nadie llegó (no grabó nada).
 *  - 'reintentar'         : falló antes de entrar a la reunión (igual que "Reintentar" del panel).
 *  - 'sin_consentimiento' : no se envió por falta de consentimiento (se reintenta solo si ahora lo hay).
 */
export function previaReintentablePorEnlace(p: Pick<Grabacion, 'estado' | 'estado_antes_error'> & Partial<Pick<Grabacion, 'nota_sistema'>>): 'liberar' | 'reintentar' | 'sin_consentimiento' | null {
  if (p.estado === 'sin_audio' && p.nota_sistema === NOTA_NADIE_LLEGO) return 'liberar';
  if (p.estado === 'error' && p.estado_antes_error === 'bot_lanzando') return 'reintentar';
  if (p.estado === 'sin_consentimiento') return 'sin_consentimiento';
  return null;
}
/** Vigencia del token tras el fin (igual que VIGENCIA_TOKEN_TRAS_FIN_MS de bot.ts; no se importa para no cargarlo). */
const VIGENCIA_TOKEN_BOT_MS = 2 * 60 * 60_000;
const ESTADOS_BOT_ACTIVO: readonly EstadoGrabacion[] = ['bot_lanzando', 'bot_en_lobby', 'grabando'];
/** Vigilante: máquina del bot viva después de HORA_FIN + 40 min (el bot se corta solo a +30). */
export const VIGILANTE_TRAS_FIN_MS = 40 * 60_000;
/** Sondeo cuando el webhook de AssemblyAI no llegó. */
export const SONDEO_SIN_WEBHOOK_MS = 30 * 60_000;
/** 'creada' sin audio por más de esto → cancelada (el iPhone pudo grabar sin red: margen amplio). */
export const HUERFANA_MS = 72 * 60 * 60_000;
/** Backoff (min) por intento fallido: 1, 5, 15, 60, 60… (regla 3 de §4). */
export const ESPERAS_MIN = [1, 5, 15, 60] as const;
export const MAX_ENVIOS = 6;
export const MAX_GUARDADO = 5;
export const MAX_RESUMEN = 4;
export const MAX_LANZAR_BOT = 3;
const LOTE = 20;

/** Ajuste de P5 (bot.ts) con los nombres de Vale en Meet; se repite aquí para no cargar bot.ts. */
const AJUSTE_NOMBRES_VALE = 'transcriptor_bot_nombres_vale';
const NOMBRES_VALE_DEFECTO = 'Valentina Orellana|Vínculos que sostienen';
const NOMBRE_VALE_EN_TRANSCRIPCION = 'Ps. Valentina';

/** Acciones de bitácora del orquestador que no están en AccionAuditoria (tipos.ts): texto libre ≤ 80. */
const ACC = {
  enviarAAI: 'enviar_assemblyai' as AccionAuditoria,
  resumen: 'resumen_generado' as AccionAuditoria,
  cancelarHuerfana: 'cancelar_huerfana' as AccionAuditoria,
  eventoMovido: 'bot_evento_movido' as AccionAuditoria,
  horaMovida: 'bot_hora_movida' as AccionAuditoria,
};

const ACTIVOS_AAI = ['enviado', 'queued', 'processing'] as const;

// ─── Tipos ────────────────────────────────────────────────────────────────────

/** Columnas que agrega 0016_transcriptor_ajustes.sql. */
export type GrabacionP6 = Grabacion & { proximo_intento_at?: string | null };
export type SegmentoP6 = Segmento & { aai_errores?: number | null };

export interface AlertasDeps {
  registrarAlerta(a: NuevaAlerta): Promise<void>;
  resolverAlertasDe(grabacionId: string, tipo?: AlertaTipo): Promise<void>;
}

export interface DepsPipeline {
  db: SupabaseClient;
  almacenamiento: Pick<AlmacenamientoTranscriptor, 'urlLectura' | 'guardarTranscripcion' | 'leerTranscripcion' | 'borrarAudio' | 'copiarAB2'>;
  aai: AssemblyAI;
  /** estadoMaquina (bot.ts, r2): si está, el vigilante detecta robots caídos sin `fin`. */
  bot: Bot & { estadoMaquina?: (machineId: string) => Promise<'viva' | 'muerta' | null> };
  puedeGrabar: PuedeGrabar;
  /** Cliente de mensajes de Anthropic (pruebas). Sin esto, resumirSesion usa el SDK real. */
  claude?: ClienteMensajes;
  /** Reemplazo completo del resumen (pruebas). */
  resumir?: (p: PeticionResumenCompleta, op: Partial<OpcionesReintento> & { cliente?: ClienteMensajes }) => Promise<ResultadoResumen>;
  alertas?: AlertasDeps;
  /** Reloj para el presupuesto de tiempo (ms). */
  reloj?: () => number;
  presupuestoMs?: number;
  presupuestoResumenMs?: number;
  /** Cifrado del contenido de resumenes_ia (H7). Sin esto, el de las variables de entorno. */
  cifrado?: Pick<CifradoVOT1, 'cifrar' | 'descifrar'>;
}

export interface Ajustes {
  activo: boolean;
  botActivo: boolean;
  resumenModo: string;
  nombresVale: string[];
}

export interface ResultadoCorrida {
  ok: boolean;
  apagado: boolean;
  pasos: Record<string, number>;
  errores: string[];
  ms: number;
}

export interface PipelineP6 extends Pipeline {
  /** Enlace propio de la sesión (/sesion/<código>): despacho inmediato de esa sesión. */
  despacharPorEnlace(ref: { bookingId: string; googleEventId?: string | null }, ahora?: Date): Promise<ResultadoDespacho | 'apagado' | 'sin_sesion'>;
  resumir(ahora: Date): Promise<number>;
  limpiar(ahora: Date): Promise<number>;
  correr(ahora?: Date): Promise<ResultadoCorrida>;
}

// ─── Utilidades puras ─────────────────────────────────────────────────────────

const TZ = 'America/Santiago';

/** YYYY-MM-DD en Chile. */
export function fechaChile(iso: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function horaChile(iso: string): string {
  return new Intl.DateTimeFormat('es-CL', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

/**
 * "sesión presencial del 16/10 a las 15:00" — sin nombres, contenido NI tipo de terapia: el título
 * viaja también en el asunto del correo de respaldo (81-revision-etica-clinica H17).
 */
export function etiquetaSesion(g: Pick<Grabacion, 'origen' | 'session_date' | 'inicio_at' | 'hora_fin_prevista'> & Partial<Pick<Grabacion, 'tipo'>>): string {
  const [, m, d] = String(g.session_date ?? '').split('-');
  const fecha = d && m ? `${d}/${m}` : String(g.session_date ?? '');
  const hora = g.inicio_at ? horaChile(g.inicio_at) : null;
  return `sesión ${g.origen} del ${fecha}${hora ? ` a las ${hora}` : ''}`;
}

/** Espera antes del intento n+1 tras n fallos (n ≥ 1). */
export function esperaTrasFallos(n: number): number {
  const i = Math.min(Math.max(n, 1), ESPERAS_MIN.length) - 1;
  return ESPERAS_MIN[i] * 60_000;
}

/** ¿Le toca a la grabación? Sin toma vigente y con su próximo intento vencido. */
export function disponible(g: GrabacionP6, ahora: Date): boolean {
  if (!leaseVencido(g.tomada_en, ahora)) return false;
  return !g.proximo_intento_at || Date.parse(g.proximo_intento_at) <= ahora.getTime();
}

/** Decisión de modelo por la regla fija (reglas.ts), según la grabación. */
export function decisionBase(g: Pick<Grabacion, 'tipo' | 'origen' | 'lugar_con_ruido'>): DecisionModelo {
  return elegirModelo({ tipo: g.tipo, origen: g.origen, lugarConRuido: g.lugar_con_ruido });
}

/** Mapa por defecto para online: los nombres de Vale en Meet → "Ps. Valentina" (Vale lo puede editar). */
export function mapaPorDefecto(g: Pick<Grabacion, 'origen' | 'mapa_hablantes'>, nombresVale: string[]): Record<string, string> | null {
  if (g.mapa_hablantes && Object.keys(g.mapa_hablantes).length) return g.mapa_hablantes;
  if (g.origen !== 'online' || !nombresVale.length) return g.mapa_hablantes ?? null;
  return Object.fromEntries(nombresVale.map((n) => [n, NOMBRE_VALE_EN_TRANSCRIPCION]));
}

const msg = (e: unknown): string => sanearMensaje(e instanceof Error ? e.message : e);
const hex = (b: Uint8Array) => `\\x${Buffer.from(b).toString('hex')}`;

// ─── Implementación ───────────────────────────────────────────────────────────

export function crearPipeline(deps: DepsPipeline): PipelineP6 {
  const db = deps.db;
  const reloj = deps.reloj ?? (() => Date.now());
  const alertas: AlertasDeps = deps.alertas ?? { registrarAlerta: registrarAlertaP8, resolverAlertasDe: resolverAlertasDeP8 };
  let limite = reloj() + (deps.presupuestoMs ?? PRESUPUESTO_MS);
  let limiteResumen = reloj() + (deps.presupuestoResumenMs ?? PRESUPUESTO_RESUMEN_MS);
  const queda = () => limite - reloj();
  const quedaResumen = () => limiteResumen - reloj();
  const cif = deps.cifrado;
  let ajustesCache: Ajustes | null = null;

  async function alerta(a: NuevaAlerta): Promise<void> {
    try { await alertas.registrarAlerta(a); } catch (e) { console.warn('[transcriptor/pipeline] no se pudo registrar la alerta:', a.tipo, msg(e)); }
  }

  async function ajustes(): Promise<Ajustes> {
    if (ajustesCache) return ajustesCache;
    const { data, error } = await db.from('settings').select('key, value')
      .in('key', [AJUSTES.activo, AJUSTES.botActivo, AJUSTES.resumenModo, AJUSTE_NOMBRES_VALE]);
    if (error) throw new Error(`settings: ${error.message}`);
    const v = new Map((data ?? []).map((r: { key: string; value: string }) => [r.key, String(r.value ?? '').trim()]));
    ajustesCache = {
      activo: v.get(AJUSTES.activo)?.toLowerCase() === 'true',
      botActivo: v.get(AJUSTES.botActivo)?.toLowerCase() === 'true',
      resumenModo: v.get(AJUSTES.resumenModo) || 'directo',
      nombresVale: (repararMojibake(v.get(AJUSTE_NOMBRES_VALE)) || NOMBRES_VALE_DEFECTO).split('|').map((x) => x.trim()).filter(Boolean),
    };
    return ajustesCache;
  }

  async function grabacionesEn(estados: EstadoGrabacion[], ahora: Date, extra?: (q: any) => any): Promise<GrabacionP6[]> {
    let q = db.from('grabaciones').select('*').in('estado', estados);
    if (extra) q = extra(q);
    const { data, error } = await q.order('updated_at', { ascending: true }).limit(LOTE * 3);
    if (error) throw new Error(`grabaciones: ${error.message}`);
    return ((data ?? []) as GrabacionP6[]).filter((g) => disponible(g, ahora)).slice(0, LOTE);
  }

  async function segmentosDe(grabacionId: string): Promise<SegmentoP6[]> {
    const { data, error } = await db.from('grabacion_segmentos').select('*')
      .eq('grabacion_id', grabacionId).not('subido_at', 'is', null).order('seq', { ascending: true });
    if (error) throw new Error(`segmentos: ${error.message}`);
    return (data ?? []) as SegmentoP6[];
  }

  async function actualizarGrabacion(id: string, cambios: Record<string, unknown>): Promise<void> {
    const { error } = await db.from('grabaciones').update(cambios).eq('id', id);
    if (error) throw new Error(`grabaciones update: ${error.message}`);
  }

  async function actualizarSegmento(id: string, cambios: Record<string, unknown>): Promise<void> {
    const { error } = await db.from('grabacion_segmentos').update(cambios).eq('id', id);
    if (error) throw new Error(`segmentos update: ${error.message}`);
  }

  /** Toma la fila, corre fn y suelta la toma pase lo que pase. false si otro proceso la tenía. */
  async function conToma(g: GrabacionP6, ahora: Date, fn: (g: GrabacionP6) => Promise<void>): Promise<boolean> {
    const tomada = (await tomar(g.id, ahora, db)) as GrabacionP6 | null;
    if (!tomada) return false;
    try {
      await fn(tomada);
    } finally {
      try { await soltar(g.id, db); } catch (e) { console.warn('[transcriptor/pipeline] soltar:', msg(e)); }
    }
    return true;
  }

  /**
   * Fallo de un paso. Si es recuperable y quedan intentos → programa el siguiente con backoff.
   * Si no → 'error' (Reintentar vuelve al estado actual) + alerta en el panel.
   */
  async function fallo(g: GrabacionP6, ahora: Date, de: EstadoGrabacion, e: unknown, op: {
    max: number; recuperable?: boolean; definitivo?: boolean; tipo: AlertaTipo; titulo: string; detalle: string;
    accion?: NuevaAlerta['accion'];
  }): Promise<'reintento' | 'error'> {
    const texto = msg(e) || 'Error sin detalle';
    let n = (g.intentos ?? 0) + 1;
    // Un error "no recuperable" (p. ej. 4xx) se reintenta una sola vez más (regla 3 de §4).
    if (op.recuperable === false) n = Math.max(n, op.max - 1);
    if (!op.definitivo && n < op.max) {
      await actualizarGrabacion(g.id, {
        intentos: n, ultimo_error: texto.slice(0, 2000),
        proximo_intento_at: new Date(ahora.getTime() + esperaTrasFallos(n)).toISOString(),
      });
      return 'reintento';
    }
    await marcarError(g.id, de, texto, db);
    await actualizarGrabacion(g.id, { intentos: n, proximo_intento_at: null });
    await alerta({
      tipo: op.tipo, grabacionId: g.id, clave: `${op.tipo}:${g.id}`, accion: op.accion ?? 'reintentar',
      titulo: `${op.titulo} ${etiquetaSesion(g)}`, detalle: op.detalle,
    });
    return 'error';
  }

  // ── 1. Vigilante de bots ─────────────────────────────────────────────────────

  async function vigilar(ahora: Date): Promise<number> {
    const corte = new Date(ahora.getTime() - VIGILANTE_TRAS_FIN_MS).toISOString();
    const lista = await grabacionesEn(['bot_lanzando', 'bot_en_lobby', 'grabando'], ahora,
      (q) => q.eq('origen', 'online').lt('hora_fin_prevista', corte));
    let n = 0;
    for (const g0 of lista) {
      if (queda() < 3_000) break;
      await conToma(g0, ahora, async (g) => {
        if (g.bot_machine_id) {
          try {
            await deps.bot.matarBot(g.bot_machine_id);
          } catch (e) {
            await alerta({
              tipo: 'bot', grabacionId: g.id, clave: `bot-maquina:${g.id}`, accion: 'revisar',
              titulo: `No se pudo apagar la máquina del asistente de notas: ${etiquetaSesion(g)}`,
              detalle: `Se reintenta cada minuto. Detalle técnico: ${msg(e)}`,
            });
            return; // se reintenta en el minuto siguiente (la máquina podría seguir subiendo audio)
          }
        }
        const finAt = ahora.toISOString();
        const revocar = { bot_token_vence_at: finAt };
        if (g.estado === 'grabando') {
          const inicio = g.inicio_at ? Date.parse(g.inicio_at) : ahora.getTime();
          const movida = await transicionar(g.id, ['grabando'], 'subiendo', {
            ...revocar, fin_at: finAt, duracion_seg: Math.max(0, Math.round((ahora.getTime() - inicio) / 1000)),
            nota_sistema: 'Grabación cerrada automáticamente: el asistente de notas no terminó solo. Se transcribe lo que alcanzó a subir.',
          } as Partial<Grabacion>, db);
          if (movida) {
            await db.from('grabacion_segmentos').delete().eq('grabacion_id', g.id).is('subido_at', null);
            const subidos = await segmentosDe(g.id);
            await transicionar(g.id, ['subiendo'], subidos.length ? 'subida' : 'sin_audio', {}, db);
            await alerta({
              tipo: 'bot', grabacionId: g.id, clave: `bot-vigilante:${g.id}`, accion: 'ninguna',
              titulo: `El asistente de notas no salió solo de la ${etiquetaSesion(g)}`,
              detalle: subidos.length
                ? 'Se apagó automáticamente 40 minutos después del término previsto. Lo grabado se está transcribiendo.'
                : 'Se apagó automáticamente 40 minutos después del término previsto. No alcanzó a subir audio.',
            });
          }
        } else if (g.estado === 'bot_en_lobby') {
          await transicionar(g.id, ['bot_en_lobby'], 'bot_no_admitido', { ...revocar, fin_at: finAt } as Partial<Grabacion>, db);
        } else {
          await actualizarGrabacion(g.id, revocar);
          await marcarError(g.id, 'bot_lanzando', 'El asistente de notas nunca llegó a la sala de espera de Meet', db);
          await alerta({
            tipo: 'bot', grabacionId: g.id, clave: `bot:${g.id}`, accion: 'revisar',
            titulo: `El asistente de notas no llegó a la ${etiquetaSesion(g)}`,
            detalle: 'La máquina se creó pero nunca avisó que estaba en la sala de espera. Esa sesión no quedó grabada.',
          });
        }
        n++;
      });
    }
    return n + (await revisarMaquinas(ahora, corte));
  }

  /**
   * r2 (punto 1b): robots que se cayeron SIN mandar `fin` (la máquina perdió la red, el proceso murió).
   * Solo dentro de la ventana de la sesión (lo de después lo cierra el vigilante). Si Fly no responde,
   * no se toca nada. En plena grabación → robot de reemplazo (o se cierra con lo grabado); antes de
   * grabar → error + relanzamiento automático (igual que "Reintentar") mientras haya tiempo.
   */
  async function revisarMaquinas(ahora: Date, corte: string): Promise<number> {
    const estadoMaquina = deps.bot.estadoMaquina;
    if (!estadoMaquina) return 0;
    const lista = await grabacionesEn([...ESTADOS_BOT_ACTIVO], ahora,
      (q) => q.eq('origen', 'online').not('bot_machine_id', 'is', null).gte('hora_fin_prevista', corte));
    let n = 0;
    for (const g0 of lista) {
      if (queda() < 5_000) break;
      if (!g0.bot_machine_id || ahora.getTime() - Date.parse(g0.updated_at) < GRACIA_REVISAR_MAQUINA_MS) continue;
      if ((await estadoMaquina(g0.bot_machine_id)) !== 'muerta') continue;
      await conToma(g0, ahora, async (g) => {
        if (g.bot_machine_id !== g0.bot_machine_id || !ESTADOS_BOT_ACTIVO.includes(g.estado)) return; // cambió mientras tanto
        await liberarSesion(db, g.id).catch(() => {});
        await auditar('cron', 'bot_salio', { grabacionId: g.id, patientId: g.patient_id, resultado: 'error', detalle: { motivo: 'caida', estado: g.estado }, cliente: db });
        const lanzados = await lanzamientosDe(db, g.id);
        const relanzar = debeRelanzarBot({ motivo: 'caida', horaFinPrevista: g.hora_fin_prevista, ahora, lanzamientos: lanzados });
        if (g.estado === 'grabando') {
          if (relanzar && await prepararRelanzamiento(db, g, { ahora })) { n++; return; }
          const r = await cerrarConLoGrabado(db, g, { ahora, notaFin: 'Grabación incompleta: el asistente de notas se cayó y no pudo volver a entrar. Se transcribe lo que alcanzó a subir.' });
          if (r) {
            n++;
            await alerta({
              tipo: 'bot', grabacionId: g.id, clave: `bot-caido:${g.id}`, accion: 'ninguna',
              titulo: `El asistente de notas se cayó durante la ${etiquetaSesion(g)}`,
              detalle: r.conAudio ? 'No se pudo volver a conectar. Lo grabado hasta ese momento se está transcribiendo.' : 'No se pudo volver a conectar y no alcanzó a subir audio.',
            });
          }
          return;
        }
        await actualizarGrabacion(g.id, { bot_token_vence_at: ahora.toISOString() });
        const e = await marcarError(g.id, g.estado, 'El asistente de notas se cayó antes de empezar a grabar', db);
        if (!e) return;
        n++;
        if (relanzar && lanzados < 2 && await reintentar(g.id, db)) return; // un solo reintento automático antes de grabar // el despacho lanza otro robot en esta misma corrida o la siguiente
        await alerta({
          tipo: 'bot', grabacionId: g.id, clave: `bot:${g.id}`, accion: 'reintentar',
          titulo: `El asistente de notas se cayó antes de entrar a la ${etiquetaSesion(g)}`,
          detalle: 'La máquina del asistente se detuvo sin avisar. Puedes reintentar mientras la sesión no haya terminado.',
        });
      });
    }
    return n;
  }

  // ── 2. Despacho de bots ──────────────────────────────────────────────────────

  async function lanzar(g: GrabacionP6, ahora: Date): Promise<boolean> {
    try {
      await deps.bot.lanzarBot(g);
      await actualizarGrabacion(g.id, { intentos: 0, proximo_intento_at: null, ultimo_error: null });
      return true;
    } catch (e) {
      const r = await fallo(g, ahora, 'bot_lanzando', e, {
        max: MAX_LANZAR_BOT, tipo: 'bot', titulo: 'No se pudo enviar el asistente de notas a la',
        detalle: `Se intentó ${MAX_LANZAR_BOT} veces. Puedes reintentar o grabar esa sesión de otra forma.`,
      });
      if (r === 'reintento') await actualizarGrabacion(g.id, { proximo_intento_at: new Date(ahora.getTime() + 60_000).toISOString() });
      return false;
    }
  }

  /**
   * Despacho de UNA sesión (el cuerpo del bucle de despacharBots; el enlace propio /sesion/<código>
   * usa exactamente este mismo camino: índice único google_event_id, consentimiento, toma, lanzarBot).
   * `porEnlace` (pedido de Vale, 18 oct): alguien abrió el enlace de la sesión; además de lo normal se
   * vuelve a mandar el robot si el intento anterior de ESTE evento no grabó nada y no fue decisión de
   * nadie (ver previaReintentablePorEnlace): "nadie llegó", falló al entrar, o faltaba el consentimiento
   * y ahora está. Nunca si hay un robot activo o si ya hay audio.
   */
  async function despacharUna(s: SesionOnline, ahora: Date, enVentana: boolean, porEnlace = false): Promise<ResultadoDespacho> {
    const { data: previa, error: e0 } = await db.from('grabaciones')
      .select('id, patient_id, estado, estado_antes_error, hora_fin_prevista, fin_at, updated_at, bot_token_vence_at, nota_sistema')
      .eq('google_event_id', s.googleEventId).eq('origen', 'online').maybeSingle();
    if (e0) throw new Error(`grabaciones: ${e0.message}`);
    let v: Awaited<ReturnType<PuedeGrabar>> | null = null;
    if (previa) {
      const p = previa as PreviaEvento & Pick<Grabacion, 'hora_fin_prevista' | 'bot_token_vence_at' | 'patient_id'>;
      // r2 (punto 7): Vale movió o alargó el evento con el robot ya lanzado → se sigue la hora nueva.
      if (ESTADOS_BOT_ACTIVO.includes(p.estado)) { await seguirHora(p, s, ahora); return 'activo'; }
      if (!enVentana) return 'existe';
      const porEnlaceTipo = porEnlace ? previaReintentablePorEnlace(p) : null;
      // Falló antes de entrar (Fly, Meet): lo mismo que "Reintentar" del panel, y se lanza ya.
      if (porEnlaceTipo === 'reintentar') {
        const r = await reintentar(p.id, db);
        if (!r || r.estado !== 'bot_lanzando' || r.bot_machine_id) return 'existe';
        await auditar('sistema', 'bot_lanzar', { grabacionId: p.id, patientId: p.patient_id, detalle: { via: 'enlace_sesion', reintento: true }, cliente: db });
        return (await lanzarPendiente(r as GrabacionP6, ahora)) ? 'lanzado' : 'fallo';
      }
      if (porEnlaceTipo === 'sin_consentimiento') {
        // Solo se libera si AHORA sí hay consentimiento (si no, cada clic crearía otra fila igual).
        v = await deps.puedeGrabar(s.patientId, s.tipo);
        if (!v.puede) return 'sin_consentimiento';
      }
      // Evento movido a otra hora después de que el robot fue (y volvió sin audio) → se libera el
      // google_event_id de la fila vieja para despachar a la hora nueva (índice único grabaciones_evento_unq).
      if (!porEnlaceTipo && !previaLiberable(p, s.inicio, s.fin)) return 'existe';
      const { data: liberada } = await db.from('grabaciones').update({ google_event_id: eventIdLiberado(s.googleEventId, p.id) })
        .eq('id', p.id).eq('google_event_id', s.googleEventId).select('id').maybeSingle();
      if (!liberada) return 'existe';
      await auditar('cron', ACC.eventoMovido, { grabacionId: p.id, patientId: p.patient_id, detalle: { estado: p.estado, ...(porEnlaceTipo ? { via: 'enlace_sesion' } : {}) }, cliente: db });
    }
    if (!enVentana) return 'fuera';
    v ??= await deps.puedeGrabar(s.patientId, s.tipo);
    // H2: si la ficha es de pareja (deducido en el servidor), la grabación es de pareja aunque el
    // evento no diga el tipo: exige ambas firmas (ya lo hizo puedeGrabar) y deja MAX_HUMANOS = 3.
    const tipo = (v as { tipoEfectivo?: typeof s.tipo }).tipoEfectivo ?? s.tipo;
    const d = elegirModelo({ tipo, origen: 'online', lugarConRuido: false });
    const fila = {
      patient_id: s.patientId, booking_id: s.bookingId, google_event_id: s.googleEventId,
      consent_ids: v.consentIds, origen: 'online', tipo, modelo: d.modelo, diarizacion: d.diarizacion,
      session_date: fechaChile(s.inicio), hora_fin_prevista: s.fin, meet_url: s.meetUrl, creada_por: 'cron',
      estado: v.puede ? 'bot_lanzando' : 'sin_consentimiento',
      nota_sistema: v.puede ? null : notaRobotSinPermiso(v.motivo),
      tomada_en: v.puede ? ahora.toISOString() : null,
    };
    const { data: g, error } = await db.from('grabaciones').insert(fila).select('*').maybeSingle();
    if (error) {
      if (error.code === '23505') return 'activo'; // otro proceso la insertó: solo ese lanza
      throw new Error(`grabaciones insert: ${error.message}`);
    }
    if (!g) return 'existe';
    if (!v.puede) {
      await auditar('cron', 'consentimiento_faltante', { grabacionId: g.id, patientId: s.patientId, resultado: 'denegado', detalle: { fase: 'bot', motivo: v.motivo, ...(porEnlace ? { via: 'enlace_sesion' } : {}) }, cliente: db });
      return 'sin_consentimiento';
    }
    try {
      return (await lanzar(g as GrabacionP6, ahora)) ? 'lanzado' : 'fallo';
    } finally {
      await soltar(g.id, db);
    }
  }

  /** Lanzamiento de una fila en bot_lanzando sin máquina (con toma y consentimiento revisado). */
  async function lanzarPendiente(g0: GrabacionP6, ahora: Date): Promise<boolean> {
    if (!g0.hora_fin_prevista || Date.parse(g0.hora_fin_prevista) <= ahora.getTime()) return false; // lo cierra el vigilante
    let lanzado = false;
    await conToma(g0, ahora, async (g) => {
      if (g.estado !== 'bot_lanzando' || g.bot_machine_id) return; // cambió mientras tanto
      // Auditoría de seguridad (17 oct): el consentimiento se vuelve a revisar antes de cada relanzamiento
      // (pudo retirarse después de crear la fila). Falla cerrado: si no se puede leer, no se lanza.
      if (!(await consentimientoVigente(g, 'bot_relanzar'))) {
        await transicionar(g.id, ['bot_lanzando'], 'cancelada', {
          bot_token_vence_at: ahora.toISOString(),
          nota_sistema: 'No se envió el asistente de notas: falta el consentimiento de grabación (se retiró o cambió).',
        } as Partial<Grabacion>, db);
        return;
      }
      lanzado = await lanzar(g, ahora);
    });
    return lanzado;
  }

  async function despacharBots(ahora: Date): Promise<number> {
    const aj = await ajustes();
    if (!aj.activo || !aj.botActivo) return 0;
    let sesiones: SesionOnline[];
    try {
      sesiones = await deps.bot.sesionesOnlineProximas(new Date(ahora.getTime() - VENTANA_SINCRONIZAR_MS), new Date(ahora.getTime() + VENTANA_BOT_DESPUES_MS));
    } catch (e) {
      await alerta({
        tipo: 'bot', clave: 'bot:calendario', accion: 'revisar',
        titulo: 'No se pudo revisar Google Calendar para enviar el asistente de notas',
        detalle: `Mientras no se resuelva, las sesiones online no se graban solas. Detalle técnico: ${msg(e)}`,
      });
      throw e;
    }
    let n = 0;
    const desdeDespacho = ahora.getTime() - VENTANA_BOT_ANTES_MS;
    for (const s of sesiones) {
      if (queda() < 5_000) break;
      const enVentana = Date.parse(s.inicio) >= desdeDespacho && Date.parse(s.fin) > ahora.getTime();
      if ((await despacharUna(s, ahora, enVentana)) === 'lanzado') n++;
    }
    // Reintentos de lanzamiento (Fly falló en un minuto anterior, o Vale tocó Reintentar: M3).
    // Sin `intentos > 0`: tras Reintentar los intentos vuelven a 0. Un lanzamiento en curso no se
    // repite porque está tomado (tomada_en) y uno exitoso ya tiene bot_machine_id.
    // r2: también los robots de REEMPLAZO ('grabando' sin máquina: el anterior se cayó o quedó solo).
    const pendientes = await grabacionesEn(['bot_lanzando', 'grabando'], ahora, (q) => q.eq('origen', 'online').is('bot_machine_id', null));
    for (const g0 of pendientes) {
      if (queda() < 5_000) break;
      if (g0.estado === 'grabando') {
        await conToma(g0, ahora, async (g) => { if (await relanzarEnCurso(g, ahora)) n++; });
        continue;
      }
      if (await lanzarPendiente(g0, ahora)) n++;
    }
    return n;
  }

  /**
   * Enlace propio de la sesión (/sesion/<código>, pedido de Vale 18 oct): alguien lo abrió. Si la sesión
   * es online, tiene Meet y está en [inicio − 30 min, fin), se despacha el robot YA por el mismo camino
   * del cron. Busca la sesión en Calendar igual que el cron (misma hora real, mismo Meet, mismo cruce con
   * la reserva y la ficha). Nunca lanza por la reserva sola: sin evento en Calendar no hay robot.
   */
  async function despacharPorEnlace(ref: { bookingId: string; googleEventId?: string | null }, ahora: Date = new Date()): Promise<ResultadoDespacho | 'apagado' | 'sin_sesion'> {
    ajustesCache = null;
    const aj = await ajustes();
    if (!aj.activo || !aj.botActivo) return 'apagado';
    const sesiones = await deps.bot.sesionesOnlineProximas(new Date(ahora.getTime() - VENTANA_SINCRONIZAR_MS), new Date(ahora.getTime() + VENTANA_ENLACE_ANTES_MS));
    const s = sesiones.find((x) => x.bookingId === ref.bookingId)
      ?? (ref.googleEventId ? sesiones.find((x) => x.googleEventId === ref.googleEventId && (!x.bookingId || x.bookingId === ref.bookingId)) : undefined);
    if (!s) return 'sin_sesion';
    return despacharUna(s, ahora, enVentanaEnlace(s.inicio, s.fin, ahora), true);
  }

  /**
   * r2 (punto 1b): robot de reemplazo para una grabación en curso cuyo robot se cayó. Mismos resguardos
   * que el relanzamiento normal (consentimiento vigente, toma, sin máquina); si ya no hay tiempo, se
   * agotaron los lanzamientos o Fly falla 3 veces, se cierra con lo grabado (se transcribe ya).
   */
  async function relanzarEnCurso(g: GrabacionP6, ahora: Date): Promise<boolean> {
    if (g.estado !== 'grabando' || g.bot_machine_id) return false;
    const fin = g.hora_fin_prevista ? Date.parse(g.hora_fin_prevista) : NaN;
    const conTiempo = !Number.isNaN(fin) && fin - ahora.getTime() > RESTANTE_MIN_ERROR_MS;
    if (!conTiempo || (await lanzamientosDe(db, g.id)) >= MAX_LANZAMIENTOS_BOT) {
      await cerrarConLoGrabado(db, g, { ahora, notaFin: 'Grabación incompleta: el asistente de notas se desconectó y no alcanzó a volver a entrar. Se transcribe lo que alcanzó a subir.' });
      return false;
    }
    if (!(await consentimientoVigente(g, 'bot_relanzar'))) {
      await cerrarConLoGrabado(db, g, { ahora, notaFin: NOTA_SIN_CONSENTIMIENTO_BOT });
      return false;
    }
    try {
      await deps.bot.lanzarBot(g);
      await actualizarGrabacion(g.id, { intentos: 0, proximo_intento_at: null, ultimo_error: null });
      return true;
    } catch (e) {
      const intentos = (g.intentos ?? 0) + 1;
      if (intentos < MAX_LANZAR_BOT) {
        await actualizarGrabacion(g.id, { intentos, ultimo_error: msg(e).slice(0, 2000), proximo_intento_at: new Date(ahora.getTime() + 60_000).toISOString() });
        return false;
      }
      const r = await cerrarConLoGrabado(db, g, { ahora, notaFin: 'Grabación incompleta: el asistente de notas se desconectó y no se pudo volver a enviar. Se transcribe lo que alcanzó a subir.' });
      if (r) {
        await alerta({
          tipo: 'bot', grabacionId: g.id, clave: `bot-caido:${g.id}`, accion: 'ninguna',
          titulo: `El asistente de notas no pudo volver a entrar a la ${etiquetaSesion(g)}`,
          detalle: `Se intentó ${MAX_LANZAR_BOT} veces. ${r.conAudio ? 'Lo grabado hasta la desconexión se está transcribiendo.' : 'No alcanzó a subir audio.'}`,
        });
      }
      return false;
    }
  }

  /**
   * r2 (punto 7): el evento cambió de término con el robot ya lanzado. Se guarda la hora nueva (el
   * vigilante y el relanzamiento la usan; el robot la recibe en la respuesta de `activo` y de cada
   * segmento), se alarga el token si sigue vigente y el candado de la sesión de Google del robot.
   */
  async function seguirHora(p: Pick<Grabacion, 'id' | 'patient_id' | 'hora_fin_prevista' | 'bot_token_vence_at'>, s: SesionOnline, ahora: Date): Promise<void> {
    const nueva = Date.parse(s.fin);
    if (Number.isNaN(nueva) || (p.hora_fin_prevista && Date.parse(p.hora_fin_prevista) === nueva)) return;
    const cambios: Record<string, unknown> = { hora_fin_prevista: new Date(nueva).toISOString() };
    const vigente = !!p.bot_token_vence_at && Date.parse(p.bot_token_vence_at) > ahora.getTime();
    if (vigente) cambios.bot_token_vence_at = new Date(nueva + VIGENCIA_TOKEN_BOT_MS).toISOString();
    const { data } = await db.from('grabaciones').update(cambios).eq('id', p.id).in('estado', [...ESTADOS_BOT_ACTIVO]).select('id').maybeSingle();
    if (!data) return;
    await extenderUsoSesion(db, p.id, ahora, new Date(nueva).toISOString()).catch(() => {});
    await auditar('cron', ACC.horaMovida, { grabacionId: p.id, patientId: p.patient_id, detalle: { antes: p.hora_fin_prevista, ahora: cambios.hora_fin_prevista }, cliente: db });
  }

  /**
   * ¿Sigue vigente el consentimiento con grabación autorizada de esta grabación? (auditoría de seguridad
   * 17 oct). Presencial ya lo revisa en subida-url y grabacion-finalizar; el robot solo lo revisaba al crear
   * la fila. Si no hay consentimiento queda en la bitácora (sin contenido). Error de lectura = false.
   */
  async function consentimientoVigente(g: GrabacionP6, fase: string): Promise<boolean> {
    let v: Awaited<ReturnType<PuedeGrabar>>;
    try { v = await deps.puedeGrabar(g.patient_id, (g.tipo ?? 'sin_tipo') as TipoSesion); }
    catch { return false; }
    if (v.puede) return true;
    await auditar('cron', 'consentimiento_faltante', { grabacionId: g.id, patientId: g.patient_id, resultado: 'denegado', detalle: { fase, motivo: v.motivo }, cliente: db });
    return false;
  }

  // ── 3/4. Envío a AssemblyAI ──────────────────────────────────────────────────

  /**
   * Envía los segmentos subidos que aún no tienen transcript. Devuelve 'listo' si todos quedaron
   * enviados, 'esperar' si hubo un fallo con reintento programado y 'error' si se agotó.
   */
  async function enviarSegmentos(g: GrabacionP6, ahora: Date): Promise<'listo' | 'esperar' | 'error'> {
    const segs = await segmentosDe(g.id);
    if (!segs.length) return 'listo';
    const base = decisionBase(g);
    for (const s of segs) {
      if (s.aai_transcript_id) continue;
      const errores = s.aai_errores ?? 0;
      const decision = errores > 0 ? decisionTrasErrorAAI(base, errores) : base;
      if (!decision) {
        await errorDefinitivoAAI(g, ahora, segs);
        return 'error';
      }
      try {
        const audioUrl = await deps.almacenamiento.urlLectura(s.r2_key, TIEMPOS.urlLecturaAssemblyAISeg);
        const { id } = await deps.aai.enviar({ audioUrl, decision });
        // M4: solo si el segmento sigue sin transcript; si otro proceso guardó el suyo, el nuevo se borra.
        const { data: guardado, error: eu } = await db.from('grabacion_segmentos')
          .update({ aai_transcript_id: id, aai_estado: 'enviado', aai_enviado_at: ahora.toISOString(), aai_error: null, aai_completado_at: null })
          .eq('id', s.id).is('aai_transcript_id', null).select('id').maybeSingle();
        if (eu || !guardado) {
          await deps.aai.borrar(id).catch((e2) => console.warn('[transcriptor/pipeline] no se pudo borrar un transcript duplicado:', msg(e2)));
          if (eu) throw new Error(`segmentos update: ${eu.message}`);
          continue;
        }
        if (decision.modelo !== g.modelo) {
          await actualizarGrabacion(g.id, { modelo: decision.modelo });
          g.modelo = decision.modelo;
        }
        await auditar('cron', ACC.enviarAAI, { grabacionId: g.id, patientId: g.patient_id, detalle: { seq: s.seq, modelo: decision.modelo, reintento: errores }, cliente: db });
      } catch (e) {
        const recuperable = e instanceof ErrorAssemblyAI ? e.recuperable : true;
        const r = await fallo(g, ahora, g.estado, e, {
          max: MAX_ENVIOS, recuperable, tipo: 'transcripcion', titulo: 'No se pudo enviar a transcribir el audio de la',
          detalle: 'El audio sigue guardado (se borra solo a las 24 h). Toca Reintentar; si vuelve a fallar, revisa la configuración de AssemblyAI.',
        });
        return r === 'reintento' ? 'esperar' : 'error';
      }
    }
    return 'listo';
  }

  async function errorDefinitivoAAI(g: GrabacionP6, ahora: Date, segs: SegmentoP6[]): Promise<void> {
    // "Reintentar" desde el panel vuelve a empezar el ciclo (mismo modelo → Pro): se reinicia el conteo.
    for (const s of segs) if ((s.aai_errores ?? 0) > 0) await actualizarSegmento(s.id, { aai_errores: 0 });
    const t = textoErrorDefinitivoAAI(decisionBase(g)); // pareja/ruido: 2 intentos (ya parten en U3.5 Pro), resto 3
    await fallo(g, ahora, g.estado, new Error(t.mensaje), {
      max: 1, definitivo: true, tipo: 'transcripcion', titulo: 'No se pudo transcribir la', detalle: t.detalle,
    });
  }

  async function reintentarEnvios(ahora: Date): Promise<number> {
    // Grabaciones en 'subida' + 'transcribiendo' que tengan segmentos sin transcript (reenvíos tras error).
    const { data: sueltos, error } = await db.from('grabacion_segmentos').select('grabacion_id')
      .is('aai_transcript_id', null).not('subido_at', 'is', null).limit(200);
    if (error) throw new Error(`segmentos: ${error.message}`);
    const conPendientes = new Set((sueltos ?? []).map((s: { grabacion_id: string }) => s.grabacion_id));
    const lista = (await grabacionesEn(['subida', 'transcribiendo'], ahora))
      .filter((g) => g.estado === 'subida' || conPendientes.has(g.id));
    let n = 0;
    for (const g0 of lista) {
      if (queda() < 4_000) break;
      await conToma(g0, ahora, async (g) => {
        if (g.estado !== 'subida' && g.estado !== 'transcribiendo') return;
        // Auditoría de seguridad (17 oct): nada se manda a transcribir sin consentimiento vigente (el retiro
        // corta lo que sigue, también en el robot). El audio no se envía; se borra con el ciclo de vida.
        if (!(await consentimientoVigente(g, 'enviar_aai'))) {
          await marcarError(g.id, g.estado, 'No se envió a transcribir: falta el consentimiento de grabación (se retiró o cambió).', db);
          return;
        }
        const r = await enviarSegmentos(g, ahora);
        if (r !== 'listo') return;
        if (g.estado === 'subida') {
          const segs = await segmentosDe(g.id);
          if (!segs.length) {
            // 'subida' sin ningún segmento con audio: no hay nada que transcribir.
            await marcarError(g.id, 'subida', 'La grabación quedó sin segmentos de audio', db);
            await alerta({ tipo: 'subida', grabacionId: g.id, clave: `subida:${g.id}`, accion: 'revisar', titulo: `No llegó audio de la ${etiquetaSesion(g)}`, detalle: 'Revisa en el teléfono si quedó algo "Pendiente de subir".' });
            return;
          }
          await transicionar(g.id, ['subida'], 'transcribiendo', { intentos: 0, ultimo_error: null, proximo_intento_at: null } as Partial<Grabacion>, db);
        } else {
          await actualizarGrabacion(g.id, { intentos: 0, proximo_intento_at: null });
        }
        n++;
      });
    }
    return n;
  }

  // ── 5. Transcripciones listas → cifrar, guardar, borrar ──────────────────────

  async function sondear(s: SegmentoP6, ahora: Date): Promise<void> {
    const r = await deps.aai.obtener(s.aai_transcript_id!);
    if (r.status === 'completed') {
      await db.from('grabacion_segmentos').update({ aai_estado: 'completed', aai_completado_at: ahora.toISOString(), aai_audio_seg: r.audio_duration ?? null, aai_error: null })
        .eq('id', s.id).in('aai_estado', [...ACTIVOS_AAI]);
      s.aai_estado = 'completed';
    } else if (r.status === 'error') {
      await db.from('grabacion_segmentos').update({ aai_estado: 'error', aai_error: sanearMensaje(r.error || 'error sin detalle') })
        .eq('id', s.id).in('aai_estado', [...ACTIVOS_AAI]);
      s.aai_estado = 'error';
    } else if (s.aai_estado !== r.status) {
      await db.from('grabacion_segmentos').update({ aai_estado: r.status }).eq('id', s.id).in('aai_estado', [...ACTIVOS_AAI]);
      s.aai_estado = r.status;
    }
  }

  async function guardar(g: GrabacionP6, segs: SegmentoP6[], ahora: Date): Promise<void> {
    const { data: previa, error: e0 } = await db.from('transcripciones').select('id, palabras')
      .eq('grabacion_id', g.id).is('deleted_at', null).maybeSingle();
    if (e0) throw new Error(`transcripciones: ${e0.message}`);
    let palabras = (previa as { palabras?: number } | null)?.palabras ?? 0;
    let duracionS: number | null = null;
    if (!previa) {
      const resultados: { offset_ms: number; resultado: ResultadoTranscripcion }[] = [];
      for (const s of segs) {
        const r = await deps.aai.obtener(s.aai_transcript_id!);
        if (r.status !== 'completed') throw new Error(`El segmento ${s.seq} ya no aparece completado en AssemblyAI`);
        resultados.push({ offset_ms: s.offset_ms ?? 0, resultado: r });
      }
      const mapa = mapaPorDefecto(g, (await ajustes()).nombresVale);
      if (mapa !== g.mapa_hablantes) await actualizarGrabacion(g.id, { mapa_hablantes: mapa });
      const clara = armarTranscripcionClara({ grabacion: { ...g, mapa_hablantes: mapa }, segmentos: resultados });
      // Los tramos-marca de huecos (H13) no cuentan como voz.
      palabras = clara.segmentos.filter((t) => !esTramoHueco(t)).reduce((a, t) => a + (t.texto.trim() ? t.texto.trim().split(/\s+/).length : 0), 0);
      duracionS = clara.duracion_s;
      const res: ResultadoGuardado = await deps.almacenamiento.guardarTranscripcion(clara);
      const largo = clara.segmentos.reduce((a, t) => a + t.texto.length, 0);
      const { error } = await db.from('transcripciones').insert({
        grabacion_id: g.id, r2_key: res.r2Key, b2_key: res.b2Key, b2_copiada_at: res.b2Key ? ahora.toISOString() : null,
        formato_v: res.formatoV, kek_v: res.kekV, dek_envuelta: hex(res.dekEnvuelta), sha256_cifrado: res.sha256,
        bytes: res.bytes, palabras, tokens_aprox: Math.ceil(largo / 3.5), duracion_s: clara.duracion_s,
        modelo: g.modelo, idioma: clara.idioma,
      });
      if (error && error.code !== '23505') throw new Error(`transcripciones insert: ${error.message}`);
      await auditar('cron', 'transcripcion_guardada', { grabacionId: g.id, patientId: g.patient_id, detalle: { palabras, bytes: res.bytes, segmentos: segs.length, copia_b2: !!res.b2Key }, cliente: db });
      if (res.b2Error) await auditar('cron', 'copia_b2', { grabacionId: g.id, resultado: 'error', detalle: { error: res.b2Error }, cliente: db });
    }
    // B4 (80-revision-seguridad): el audio y el transcript de AssemblyAI se borran SOLO con las dos
    // copias confirmadas (R2 verificada + B2). Si la copia a B2 falló, se reintenta primero (con el
    // backoff del paso, el audio sigue guardado); si se agotan los intentos, como la transcripción
    // cifrada ya está verificada en R2 y el audio se borra solo a las 24 h de todas formas, se sigue
    // con el borrado, la copia queda PENDIENTE (b2_key null) y hay aviso en el panel. El paso
    // `respaldos` vuelve a intentar las copias pendientes en cada corrida.
    if (!(await asegurarCopiaB2(g, ahora))) return;
    // Recién con la transcripción cifrada guardada se borra en AssemblyAI y el audio (regla 5 de §4).
    for (const s of segs) {
      const ok = await borrarTranscriptTrasGuardar(s, { aai: deps.aai, db, ahora });
      if (!ok) throw new Error('La transcripción aún no figura guardada; no se borra nada');
    }
    let borrados = 0;
    for (const s of segs) {
      if (s.audio_borrado_at) continue;
      await deps.almacenamiento.borrarAudio(s.r2_key);
      await actualizarSegmento(s.id, { audio_borrado_at: ahora.toISOString() });
      borrados++;
    }
    if (borrados) await auditar('cron', 'borrar_audio', { grabacionId: g.id, detalle: { segmentos: borrados }, cliente: db });
    await transicionar(g.id, ['transcribiendo'], 'transcrita', {
      audio_borrado_at: ahora.toISOString(), intentos: 0, ultimo_error: null, proximo_intento_at: null,
      ...(g.duracion_seg == null && duracionS != null ? { duracion_seg: duracionS } : {}),
    } as Partial<Grabacion>, db);
    if (!palabras) {
      await alerta({
        tipo: 'transcripcion', grabacionId: g.id, clave: `sin-voz:${g.id}`, accion: 'revisar',
        titulo: `No se reconoció voz en la ${etiquetaSesion(g)}`,
        detalle: 'La grabación llegó, pero la transcripción quedó vacía (¿micrófono tapado o en silencio?). No se genera resumen.',
      });
    }
  }

  /** Copia en B2 de una transcripción. true = hay copia (o ya no tiene sentido esperar). */
  async function copiarPendienteB2(tr: { id: string; r2_key: string }, ahora: Date): Promise<boolean> {
    try {
      const { b2Key } = await deps.almacenamiento.copiarAB2(tr.r2_key);
      await db.from('transcripciones').update({ b2_key: b2Key, b2_copiada_at: ahora.toISOString() }).eq('id', tr.id).is('b2_key', null);
      return true;
    } catch (e) {
      console.warn('[transcriptor/pipeline] copia a B2 pendiente:', msg(e));
      return false;
    }
  }

  /**
   * B4: false = no seguir (se programó otro intento: el audio NO se borra todavía).
   * true = hay copia en B2, o se agotaron los intentos y se sigue con la copia marcada pendiente.
   */
  async function asegurarCopiaB2(g: GrabacionP6, ahora: Date): Promise<boolean> {
    const { data: tr, error } = await db.from('transcripciones').select('id, r2_key, b2_key')
      .eq('grabacion_id', g.id).is('deleted_at', null).maybeSingle();
    if (error) throw new Error(`transcripciones: ${error.message}`);
    if (!tr || (tr as { b2_key?: string | null }).b2_key) return true;
    if (await copiarPendienteB2(tr as { id: string; r2_key: string }, ahora)) return true;
    const n = (g.intentos ?? 0) + 1;
    if (n < MAX_GUARDADO) {
      await actualizarGrabacion(g.id, {
        intentos: n, ultimo_error: 'Copia de respaldo en B2 pendiente',
        proximo_intento_at: new Date(ahora.getTime() + esperaTrasFallos(n)).toISOString(),
      });
      return false;
    }
    await auditar('cron', 'copia_b2', { grabacionId: g.id, resultado: 'error', detalle: { pendiente: true, intentos: n }, cliente: db });
    await alerta({
      tipo: 'respaldo', grabacionId: g.id, clave: `respaldo:${g.id}`, accion: 'revisar',
      titulo: `La copia de respaldo (B2) de la transcripción de la ${etiquetaSesion(g)} quedó pendiente`,
      detalle: 'La transcripción está guardada y cifrada en R2 (verificada). La copia en B2 se reintenta sola en cada corrida; si el aviso sigue, revisa las llaves de B2.',
    });
    return true;
  }

  /** Paso `respaldos`: copias en B2 que quedaron pendientes (B4). Cierra el aviso cuando lo logra. */
  async function respaldos(ahora: Date): Promise<number> {
    const { data, error } = await db.from('transcripciones').select('id, grabacion_id, r2_key')
      .is('b2_key', null).is('deleted_at', null).limit(LOTE);
    if (error) throw new Error(`transcripciones: ${error.message}`);
    let n = 0;
    for (const tr of (data ?? []) as { id: string; grabacion_id: string; r2_key: string }[]) {
      if (queda() < 3_000) break;
      if (await copiarPendienteB2(tr, ahora)) {
        n++;
        await auditar('cron', 'copia_b2', { grabacionId: tr.grabacion_id, detalle: { reintento: true }, cliente: db });
        await alertas.resolverAlertasDe(tr.grabacion_id, 'respaldo').catch(() => undefined);
      }
    }
    return n;
  }

  async function procesarTranscripciones(ahora: Date): Promise<number> {
    const lista = await grabacionesEn(['transcribiendo'], ahora);
    let n = 0;
    for (const g0 of lista) {
      if (queda() < MIN_GUARDAR_MS) break;
      await conToma(g0, ahora, async (g) => {
        if (g.estado !== 'transcribiendo') return;
        const segs = await segmentosDe(g.id);
        if (!segs.length || segs.some((s) => !s.aai_transcript_id)) return; // lo envía reintentarEnvios
        try {
          // a) Sondeo de los que llevan > 30 min sin webhook.
          for (const s of segs) {
            const activo = (ACTIVOS_AAI as readonly string[]).includes(String(s.aai_estado));
            const enviado = s.aai_enviado_at ? Date.parse(s.aai_enviado_at) : 0;
            if (activo && ahora.getTime() - enviado >= SONDEO_SIN_WEBHOOK_MS) await sondear(s, ahora);
          }
          // b) Errores de AssemblyAI → reintento (mismo modelo, luego Pro) o error definitivo.
          const conError = segs.filter((s) => s.aai_estado === 'error');
          if (conError.length) {
            for (const s of conError) {
              try { await deps.aai.borrar(s.aai_transcript_id!); } catch { /* transcript con error: sin datos que proteger */ }
              const errores = (s.aai_errores ?? 0) + 1;
              await actualizarSegmento(s.id, { aai_errores: errores, aai_transcript_id: null, aai_estado: null, aai_enviado_at: null });
              s.aai_errores = errores;
              s.aai_transcript_id = null;
            }
            const r = await enviarSegmentos(g, ahora);
            if (r === 'listo') n++;
            return;
          }
          // c) Todos completos → unir, cifrar, guardar y borrar.
          if (segs.every((s) => s.aai_estado === 'completed')) {
            await guardar(g, segs, ahora);
            n++;
          }
        } catch (e) {
          await fallo(g, ahora, 'transcribiendo', e, {
            max: MAX_GUARDADO, recuperable: true, tipo: 'transcripcion', titulo: 'No se pudo guardar la transcripción de la',
            detalle: 'Se reintentó varias veces. El audio no se borra hasta que la transcripción quede guardada y cifrada. Toca Reintentar.',
          });
        }
      });
    }
    return n;
  }

  // ── 3. Resumen (Messages API directa) ────────────────────────────────────────

  async function filaResumen(g: GrabacionP6, transcripcionId: string): Promise<ResumenIA | null> {
    const { data, error } = await db.from('resumenes_ia').select('*').eq('grabacion_id', g.id).eq('autor', 'ia')
      .order('version', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`resumenes_ia: ${error.message}`);
    const ultima = data as ResumenIA | null;
    if (ultima?.estado === 'listo') return ultima; // ya estaba: solo falta cerrar la grabación
    if (ultima) {
      if (ultima.estado === 'error') {
        // Vale tocó Reintentar en el panel: vuelve a empezar.
        await db.from('resumenes_ia').update({ estado: 'pendiente', intentos: 0, ultimo_error: null }).eq('id', ultima.id).eq('estado', 'error');
        return { ...ultima, estado: 'pendiente', intentos: 0 };
      }
      return ultima;
    }
    const nueva = {
      grabacion_id: g.id, patient_id: g.patient_id, booking_id: g.booking_id, transcripcion_id: transcripcionId,
      version: 1, autor: 'ia', plantilla: plantillaDesdeTipo(g.tipo), modelo: MODELO_RESUMEN, modo: 'directo', estado: 'pendiente',
    };
    const { data: ins, error: e2 } = await db.from('resumenes_ia').insert(nueva).select('*').maybeSingle();
    if (e2 && e2.code !== '23505') throw new Error(`resumenes_ia insert: ${e2.message}`);
    if (ins) return ins as ResumenIA;
    const { data: otra } = await db.from('resumenes_ia').select('*').eq('grabacion_id', g.id).eq('version', 1).maybeSingle();
    return (otra as ResumenIA | null) ?? null;
  }

  async function participantes(g: GrabacionP6): Promise<Participante[]> {
    const out: Participante[] = [{ rol: 'Terapeuta', nombre: 'Valentina' }];
    if (!g.patient_id) return out;
    if (g.tipo === 'pareja') {
      // H14: nombres de pila de las dos personas que firmaron (consent_ids de la grabación), sin
      // apellidos. El orden no dice quién habló primero: el prompt pide asignar por el contenido.
      const ids = (g.consent_ids ?? []).filter(Boolean);
      if (!ids.length) return out;
      const { data } = await db.from('consents').select('id, signer_name').in('id', ids);
      const pilas = [...new Set(((data ?? []) as { signer_name?: string | null }[]).map((c) => nombreDePila(c.signer_name)).filter(Boolean))];
      for (const n of pilas.slice(0, 2)) out.push({ rol: 'Miembro', nombre: n });
      return out;
    }
    const { data } = await db.from('patients').select('name').eq('id', g.patient_id).maybeSingle();
    const pila = nombreDePila((data as { name?: string } | null)?.name);
    if (pila) out.push({ rol: 'Paciente', nombre: pila });
    return out;
  }

  /**
   * Pedido de Vale (17 oct 2026): si la sesión aún no tiene evolución, se guarda con el texto del
   * resumen recién listo (evolucionAuto.ts: nunca pisa, idempotente). Jamás lanza ni detiene el
   * cierre de la grabación; los errores quedan en la bitácora.
   */
  async function evolucionDesdeResumen(g: GrabacionP6, fila: ResumenIA, contenido: string | null): Promise<void> {
    try {
      const md = contenido ?? (await leerContenidoResumen(fila as never, cif));
      await autollenarEvolucion({ db, grabacion: g, contenido: md, version: fila.version });
    } catch (e) {
      await auditar('sistema', ACCION_EVOLUCION_AUTO, {
        grabacionId: g.id, patientId: g.patient_id, resultado: 'error', detalle: { etapa: 'leer_resumen' }, cliente: db,
      }).catch(() => false);
      console.warn('[transcriptor/pipeline] evolución automática omitida:', e instanceof Error ? e.name : 'error');
    }
  }

  async function resumirUna(g: GrabacionP6, ahora: Date): Promise<boolean> {
    if (g.estado === 'transcrita') {
      const m = await transicionar(g.id, ['transcrita'], 'resumiendo', { intentos: 0 } as Partial<Grabacion>, db);
      if (!m) return false;
      g = { ...g, ...(m as GrabacionP6) };
    }
    if (g.estado !== 'resumiendo') return false;
    let fila: ResumenIA | null;
    let peticion: PeticionResumenCompleta;
    let instruccionesId: string | null;
    let transcripcionId: string;
    try {
      const { data: tr, error } = await db.from('transcripciones').select('id, r2_key')
        .eq('grabacion_id', g.id).is('deleted_at', null).maybeSingle();
      if (error) throw new Error(`transcripciones: ${error.message}`);
      if (!tr) throw new Error('No hay transcripción guardada para resumir');
      transcripcionId = tr.id as string;
      fila = await filaResumen(g, transcripcionId);
      if (!fila) throw new Error('No se pudo crear la fila del resumen');
      if (fila.estado === 'listo') {
        // Recuperación (se cortó entre el resumen y el cierre): la evolución se intenta de nuevo (idempotente).
        await evolucionDesdeResumen(g, fila, null);
        await transicionar(g.id, ['resumiendo'], 'lista', { intentos: 0, ultimo_error: null, proximo_intento_at: null } as Partial<Grabacion>, db);
        await alertas.resolverAlertasDe(g.id).catch(() => undefined);
        return true;
      }
      const tramos = (await deps.almacenamiento.leerTranscripcion(tr.r2_key as string)).segmentos;
      if (!tramos.some((t) => !esTramoHueco(t))) {
        await db.from('resumenes_ia').update({ estado: 'error', ultimo_error: 'sin_voz' }).eq('id', fila.id);
        await transicionar(g.id, ['resumiendo'], 'lista', { nota_sistema: 'No se reconoció voz en la grabación; no hay resumen.', intentos: 0, proximo_intento_at: null } as Partial<Grabacion>, db);
        return true;
      }
      const instr = await cargarInstrucciones('resumen', db);
      instruccionesId = instr.id;
      const previo = await contextoSesionAnterior(g, db, cif).catch(() => null);
      peticion = {
        resumenId: fila.id, customId: `res_${fila.id.replace(/-/g, '')}`.slice(0, 64),
        plantilla: plantillaDesdeTipo(g.tipo), instrucciones: instr.texto, transcripcion: tramos, contextoPrevio: previo,
        sesion: {
          fecha: g.session_date, modalidad: g.origen,
          duracionMin: g.duracion_seg ? g.duracion_seg / 60 : null,
          participantes: await participantes(g), pausas: g.pausas ?? [],
        },
      };
    } catch (e) {
      await fallo(g, ahora, 'resumiendo', e, {
        max: MAX_RESUMEN, recuperable: true, tipo: 'resumen', accion: 'reintentar_resumen',
        titulo: 'No se pudo preparar el resumen de la', detalle: 'La transcripción está guardada. Toca Reintentar resumen.',
      });
      return false;
    }

    const intento = (fila.intentos ?? 0) + 1;
    try {
      const resumir = deps.resumir ?? resumirSesion;
      // Un solo intento por minuto y con el tiempo que queda: los reintentos los da el cron (backoff).
      const timeoutMs = Math.max(5_000, Math.min(LIMITE_RESUMEN_MS, quedaResumen() - 5_000));
      const r = await resumir(peticion, { intentos: 1, timeoutMs, ...(deps.claude ? { cliente: deps.claude } : {}) });
      // H7: el contenido se guarda cifrado (VOT1, DEK propia); `contenido` en claro queda null.
      const cifradas = await columnasContenidoCifrado(fila.id, r.contenido, cif);
      const { error } = await db.from('resumenes_ia').update({
        estado: 'listo', ...cifradas, modelo: r.modelo, modo: 'directo', prompt_version: r.promptVersion,
        instrucciones_id: instruccionesId, transcripcion_id: transcripcionId, intentos: intento, ultimo_error: null,
        tokens_entrada: r.uso.entrada + r.uso.cacheEscritura + r.uso.cacheLectura, tokens_salida: r.uso.salida,
        costo_usd: Number(r.costoUsd.toFixed(5)), listo_at: ahora.toISOString(),
      }).eq('id', fila.id).neq('estado', 'listo');
      if (error) throw new Error(`resumenes_ia update: ${error.message}`);
      await auditar('anthropic', ACC.resumen, {
        grabacionId: g.id, patientId: g.patient_id,
        detalle: { modelo: r.modelo, prompt_version: r.promptVersion, tokens_salida: r.uso.salida, costo_usd: r.costoUsd, truncado: r.truncado, citas_eliminadas: r.verificacion.eliminadas },
        cliente: db,
      });
      await evolucionDesdeResumen(g, fila, r.contenido);
      await transicionar(g.id, ['resumiendo'], 'lista', { intentos: 0, ultimo_error: null, proximo_intento_at: null } as Partial<Grabacion>, db);
      await alertas.resolverAlertasDe(g.id).catch(() => undefined);
      return true;
    } catch (e) {
      const err = clasificarError(e);
      const definitivo = !err.recuperable || intento >= MAX_RESUMEN;
      await db.from('resumenes_ia').update({ intentos: intento, ultimo_error: err.codigo, estado: definitivo ? 'error' : 'pendiente' }).eq('id', fila.id).neq('estado', 'listo');
      await fallo({ ...g, intentos: intento - 1 }, ahora, 'resumiendo', new Error(`Claude: ${err.codigo}${err.status ? ` (HTTP ${err.status})` : ''}`), {
        max: MAX_RESUMEN, definitivo, tipo: 'resumen', accion: 'reintentar_resumen',
        titulo: 'No se pudo generar el resumen automático de la',
        detalle: err.recuperable
          ? `Anthropic no respondió en ${intento} intentos. La transcripción está guardada; toca Reintentar resumen.`
          : 'Anthropic rechazó la petición (revisa la llave ANTHROPIC_API_KEY o el modelo). La transcripción está guardada.',
      });
      return false;
    }
  }

  async function resumir(ahora: Date): Promise<number> {
    const aj = await ajustes();
    if (aj.resumenModo !== 'directo') {
      await alerta({
        tipo: 'config', clave: 'config:resumen-modo', accion: 'revisar',
        titulo: `El ajuste transcriptor_resumen_modo dice "${aj.resumenModo.slice(0, 20)}"; se usa "directo"`,
        detalle: 'Decisión del 16 oct: sin Batch (modo HIPAA). Cambia el ajuste a "directo" para quitar este aviso.',
      });
    }
    const lista = await grabacionesEn(['transcrita', 'resumiendo'], ahora);
    let n = 0;
    for (const g0 of lista) {
      if (quedaResumen() < MIN_RESUMEN_MS) break;
      await conToma(g0, ahora, async (g) => { if (await resumirUna(g, ahora)) n++; });
    }
    return n;
  }

  // ── 6. Limpieza ──────────────────────────────────────────────────────────────

  async function limpiar(ahora: Date): Promise<number> {
    let n = 0;
    const corte = new Date(ahora.getTime() - HUERFANA_MS).toISOString();
    const viejas = await grabacionesEn(['creada'], ahora, (q) => q.lt('created_at', corte));
    for (const g0 of viejas) {
      if (queda() < 2_000) break;
      await conToma(g0, ahora, async (g) => {
        const { count } = await db.from('grabacion_segmentos').select('id', { count: 'exact', head: true }).eq('grabacion_id', g.id);
        if ((count ?? 0) > 0) return; // tiene audio en camino: no es huérfana
        const m = await transicionar(g.id, ['creada'], 'cancelada', { nota_sistema: 'Cancelada automáticamente: se preparó la grabación pero no llegó audio en 72 horas.' } as Partial<Grabacion>, db);
        if (m) {
          await auditar('cron', ACC.cancelarHuerfana, { grabacionId: g.id, patientId: g.patient_id, cliente: db });
          n++;
        }
      });
    }
    // Tomas vencidas (proceso cortado por maxDuration): se liberan para que el panel no las vea "ocupadas".
    const lease = new Date(ahora.getTime() - TIEMPOS.leaseTomaMs).toISOString();
    await db.from('grabaciones').update({ tomada_en: null }).lt('tomada_en', lease);
    return n;
  }

  // ── Corrida completa ────────────────────────────────────────────────────────

  async function correr(ahora: Date = new Date()): Promise<ResultadoCorrida> {
    const t0 = reloj();
    limite = t0 + (deps.presupuestoMs ?? PRESUPUESTO_MS);
    limiteResumen = t0 + (deps.presupuestoResumenMs ?? PRESUPUESTO_RESUMEN_MS);
    ajustesCache = null;
    const pasos: Record<string, number> = {};
    const errores: string[] = [];
    const paso = async (nombre: string, fn: (a: Date) => Promise<number>, conPresupuestoResumen = false) => {
      if ((conPresupuestoResumen ? quedaResumen() : queda()) <= 1_000) return;
      try { pasos[nombre] = await fn(ahora); } catch (e) {
        errores.push(`${nombre}: ${msg(e)}`);
        console.warn(`[transcriptor/pipeline] ${nombre}:`, msg(e));
      }
    };
    await db.from('settings').upsert({ key: AJUSTES.latido, value: ahora.toISOString() }, { onConflict: 'key' });
    const aj = await ajustes();
    // El vigilante corre siempre: apagar máquinas huérfanas evita costo aunque el transcriptor esté apagado.
    await paso('vigilar', vigilar);
    if (!aj.activo) {
      const { count } = await db.from('grabaciones').select('id', { count: 'exact', head: true })
        .in('estado', ['subida', 'transcribiendo', 'transcrita', 'resumiendo']);
      if ((count ?? 0) > 0) {
        await alerta({
          tipo: 'config', clave: 'config:apagado-con-pendientes', accion: 'revisar',
          titulo: `El transcriptor está apagado y hay ${count} grabación(es) detenidas a mitad de proceso`,
          detalle: 'El audio temporal se borra solo a las 24 h. Enciende el transcriptor para terminarlas.',
        });
      }
      return { ok: errores.length === 0, apagado: true, pasos, errores, ms: reloj() - t0 };
    }
    await paso('bots', despacharBots);
    await paso('resumenes', resumir);
    await paso('envios', reintentarEnvios);
    await paso('transcripciones', procesarTranscripciones);
    // 17 oct (velocidad): lo que recién quedó 'transcrita' se resume en ESTA corrida, no en la del minuto
    // siguiente. resumir() toma cada grabación por fila, así que repetir el paso no duplica trabajo.
    if (pasos.transcripciones) await paso('resumenes_nuevos', resumir, true);
    await paso('respaldos', respaldos);
    await paso('archivo', async (a) => (await import('./pasoArchivo')).pasoArchivo(deps, a)); // 02-decisiones-16oct-noche B: resúmenes fuera de las 4 últimas sesiones → R2+B2
    await paso('limpieza', limpiar);
    return { ok: errores.length === 0, apagado: false, pasos, errores, ms: reloj() - t0 };
  }

  return {
    despacharBots,
    despacharPorEnlace,
    reintentarEnvios,
    procesarTranscripciones,
    /** Contrato de tipos.ts: con modo 'directo' (decisión 1) "crear batch" = resumir directo. */
    crearBatchResumenes: resumir,
    /** Sin Batch (decisión 1, modo HIPAA): no hay batches que revisar. */
    revisarBatches: async () => 0,
    vigilar,
    resumir,
    limpiar,
    correr,
  };
}

/** Dependencias reales (Supabase service_role, R2/B2, AssemblyAI, Fly, Anthropic). */
export async function depsProduccion(): Promise<DepsPipeline> {
  const [{ supabase }, { almacenamiento, assemblyai }, { crearBot }, { evaluarEnBase }] = await Promise.all([
    import('../supabase'),
    import('./dependencias-p4'),
    import('./bot'),
    import('./consentimiento'),
  ]);
  return {
    db: supabase,
    almacenamiento,
    aai: assemblyai,
    bot: crearBot({ db: supabase }),
    puedeGrabar: (patientId, tipo) => evaluarEnBase(patientId, tipo, supabase),
  };
}
