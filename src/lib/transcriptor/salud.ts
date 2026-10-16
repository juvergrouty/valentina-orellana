// Transcriptor IA — chequeo diario de salud (paquete P8). Lo llama /api/cron/transcriptor-salud.
// 50-arquitectura §6 + decisión 8 (01-decisiones-16oct.md): cada falla → registrarAlerta con su
// clave (aviso rojo en el panel, correo solo de respaldo). Si todo está bien NO avisa nada: solo
// guarda el resultado en transcriptor_salud (0014). Cuando un chequeo vuelve a OK, sus alertas
// 'salud:<chequeo>…' se cierran solas (resuelta_por = 'sistema').
//
// Privacidad: las llamadas a proveedores son mínimas y sin datos clínicos (listar 1 objeto, listar
// 1 transcript, leer la ficha de un modelo). Los detalles guardados son conteos y estados; nunca
// texto, nombres ni URLs firmadas.
import type { ChequeoSalud, EstadoGrabacion, Origen, SaludFila } from './tipos';
import { MODELO_PREGUNTAS, MODELO_RESUMEN, MODELO_U2, MODELO_U35_PRO } from './tipos';
import { sanearTexto, type AlertaTipo, type NuevaAlerta } from './alertas';
import vercelJson from '../../../vercel.json';

// ─── Tipos ────────────────────────────────────────────────────────────────────

/** Chequeos de P8. Los de tipos.ts + 3 nuevos (la columna `chequeo` es texto libre). */
export type ChequeoP8 = ChequeoSalud | 'config' | 'aai_borrado' | 'permisos_microfono';

export interface ResultadoP8 {
  chequeo: ChequeoP8;
  ok: boolean;
  detalle?: Record<string, unknown>;
  alertas: NuevaAlerta[];
}

export interface AjustesSalud { activo: boolean; botActivo: boolean; presupuestoClp: number; usdClp: number }

export interface GrabacionSalud {
  id: string;
  estado: EstadoGrabacion;
  estado_antes_error: EstadoGrabacion | null;
  origen: Origen;
  updated_at: string;
  hora_fin_prevista: string | null;
}

export interface SegmentoSalud {
  grabacion_id: string;
  estado_grabacion: EstadoGrabacion;
  audio_borrado_at: string | null;
  aai_transcript_id: string | null;
  aai_estado: string | null;
  aai_borrado_at: string | null;
  /** aai_completado_at ?? aai_enviado_at ?? subido_at ?? created_at */
  referencia_at: string;
}

export interface CostosCrudos {
  /** Segundos de audio facturados por AssemblyAI, con el modelo y diarización de su grabación. */
  audio: { seg: number; modelo: string; diarizacion: boolean }[];
  usdResumenes: number;
  usdPreguntas: number;
}

export interface FuentesSalud {
  ajustes(): Promise<AjustesSalud>;
  env(nombre: string): string | undefined;
  grabacionesNoTerminales(): Promise<GrabacionSalud[]>;
  segmentosPendientesDeBorrar(): Promise<SegmentoSalud[]>;
  transcripcionesSinCopiaB2(limite: Date): Promise<{ id: string; grabacion_id: string; created_at: string }[]>;
  objetosAudioR2(): Promise<{ key: string; modificado: Date | null }[]>;
  /** Contenido de respaldos/ultimo.txt en B2 (null si no existe). */
  ultimoRespaldo(): Promise<string | null>;
  costosMes(desde: Date, hasta: Date): Promise<CostosCrudos>;
  /** grabacion_id de las alertas abiertas que NO son del propio chequeo (clave 'salud:atascadas:…'),
   *  para no duplicar las que abrió el orquestador. Las del chequeo se vuelven a registrar (suman
   *  `veces`) y así no se cierran solas mientras la sesión siga mal. */
  grabacionesConAlertaAbierta(): Promise<Set<string>>;
  probarR2(): Promise<void>;
  probarB2(): Promise<void>;
  probarAssemblyAI(): Promise<void>;
  probarAnthropic(): Promise<void>;
  /** Contenido de vercel.json desplegado. */
  vercel(): unknown;
}

// ─── Constantes ───────────────────────────────────────────────────────────────

const H = 60 * 60_000;
export const UMBRAL_ATASCADA_MS = 2 * H;
export const UMBRAL_TELEFONO_MS = 12 * H;
export const ABANDONADA_MS = 7 * 24 * H;
export const GRACIA_BORRADO_MS = 2 * H;
export const GRACIA_CANCELADA_MS = 24 * H;
export const GRACIA_COPIA_B2_MS = 1 * H;
export const AUDIO_R2_MAX_MS = 26 * H;          // ciclo de vida de 1 día + margen
export const RESPALDO_MAX_MS = 8 * 24 * H;
export const UMBRAL_GASTO = 0.9;
export const IVA = 0.19;                          // servicios digitales extranjeros (IVA Chile)
/** US$ por hora de audio (50-arquitectura §8, precios oficiales 15 oct 2026). */
export const TARIFA_AAI_HORA: Record<string, number> = { [MODELO_U2]: 0.15, [MODELO_U35_PRO]: 0.21 };
export const TARIFA_DIARIZACION_HORA = 0.02;

/** Estados intermedios que no deberían durar más de 2 h. */
export const ESTADOS_INTERMEDIOS: readonly EstadoGrabacion[] = [
  'creada', 'bot_lanzando', 'bot_en_lobby', 'grabando', 'pausada', 'subiendo', 'subida', 'transcribiendo', 'transcrita', 'resumiendo',
];
const POST_TRANSCRIPCION: readonly EstadoGrabacion[] = ['transcrita', 'resumiendo', 'lista'];

/** Variables obligatorias con el transcriptor activo (solo nombres; 30-seguridad §6). */
export const VARIABLES_REQUERIDAS = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RESEND_API_KEY',
  'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_AUDIO', 'R2_BUCKET_TRANSCRIPCIONES',
  'B2_ENDPOINT', 'B2_REGION', 'B2_KEY_ID', 'B2_APPLICATION_KEY', 'B2_BUCKET',
  'TRANSCRIPTOR_KEK_ACTIVA',
  'ASSEMBLYAI_API_KEY', 'ASSEMBLYAI_WEBHOOK_SECRET', 'ANTHROPIC_API_KEY',
] as const;
export const VARIABLES_BOT = ['FLY_API_TOKEN', 'FLY_APP_BOT', 'FLY_IMAGEN', 'BOT_TOKEN_SECRET'] as const;

// ─── Utilidades puras ─────────────────────────────────────────────────────────

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const err = (e: unknown) => sanearTexto(e instanceof Error ? `${e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}` : String(e), 300);
const clave = (c: ChequeoP8, sufijo?: string) => (sufijo ? `salud:${c}:${sufijo}` : `salud:${c}`);

/** Tipo de alerta según el paso en que quedó la grabación. */
export function tipoPorEstado(estado: EstadoGrabacion | null, origen: Origen): AlertaTipo {
  switch (estado) {
    case 'creada': case 'bot_lanzando': case 'bot_en_lobby': return origen === 'online' ? 'bot' : 'subida';
    case 'grabando': case 'pausada': case 'subiendo': return origen === 'online' ? 'bot' : 'subida';
    case 'subida': case 'transcribiendo': return 'transcripcion';
    case 'transcrita': case 'resumiendo': return 'resumen';
    default: return 'salud';
  }
}

const NOMBRE_PASO: Partial<Record<EstadoGrabacion, string>> = {
  creada: 'esperando empezar', bot_lanzando: 'lanzando el bot', bot_en_lobby: 'bot esperando en la sala',
  grabando: 'grabando', pausada: 'en pausa', subiendo: 'subiendo el audio', subida: 'esperando transcripción',
  transcribiendo: 'transcribiendo', transcrita: 'esperando resumen', resumiendo: 'haciendo el resumen',
};

/** Parsea la primera línea de ultimo.txt: YYYYMMDDTHHMMSSZ (respaldo.sh). */
export function fechaRespaldo(contenido: string | null): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec((contenido ?? '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Gasto en USD (AssemblyAI por modelo + Anthropic). */
export function calcularGastoUsd(c: CostosCrudos): { assemblyai: number; anthropic: number; total: number } {
  let aai = 0;
  for (const a of c.audio) {
    const horas = Math.max(0, Number(a.seg) || 0) / 3600;
    aai += horas * ((TARIFA_AAI_HORA[a.modelo] ?? TARIFA_AAI_HORA[MODELO_U35_PRO]) + (a.diarizacion ? TARIFA_DIARIZACION_HORA : 0));
  }
  const anthropic = (Number(c.usdResumenes) || 0) + (Number(c.usdPreguntas) || 0);
  return { assemblyai: aai, anthropic, total: aai + anthropic };
}

export const usdAClpConIva = (usd: number, usdClp: number) => usd * usdClp * (1 + IVA);

/** Inicio y fin del mes calendario de Chile que contiene `ahora` (aprox. UTC-3; error ≤ 1 h). */
export function mesChile(ahora: Date, desplazamiento = 0): { desde: Date; hasta: Date; etiqueta: string; diasMes: number; diaActual: number } {
  const cl = new Date(ahora.getTime() - 3 * H);
  const y = cl.getUTCFullYear(), m = cl.getUTCMonth() + desplazamiento;
  const desde = new Date(Date.UTC(y, m, 1) + 3 * H);
  const hasta = new Date(Date.UTC(y, m + 1, 1) + 3 * H);
  const ini = new Date(Date.UTC(y, m, 1));
  const etiqueta = `${ini.getUTCFullYear()}-${String(ini.getUTCMonth() + 1).padStart(2, '0')}`;
  const diasMes = new Date(Date.UTC(ini.getUTCFullYear(), ini.getUTCMonth() + 1, 0)).getUTCDate();
  return { desde, hasta, etiqueta, diasMes, diaActual: desplazamiento === 0 ? cl.getUTCDate() : diasMes };
}

// ─── Chequeos (puros sobre las fuentes) ──────────────────────────────────────

type Ctx = { f: FuentesSalud; ahora: Date; ajustes: AjustesSalud };

function chequeoConfig({ f, ajustes }: Ctx): ResultadoP8 {
  const faltan: string[] = VARIABLES_REQUERIDAS.filter((n) => !f.env(n));
  const activa = f.env('TRANSCRIPTOR_KEK_ACTIVA');
  const v = /^v?(\d{1,3})$/i.exec(activa ?? '')?.[1];
  if (activa && !v) faltan.push('TRANSCRIPTOR_KEK_ACTIVA (formato v1, v2…)');
  if (v && !f.env(`TRANSCRIPTOR_KEK_V${Number(v)}`)) faltan.push(`TRANSCRIPTOR_KEK_V${Number(v)}`);
  if (ajustes.botActivo) for (const n of VARIABLES_BOT) if (!f.env(n)) faltan.push(n);
  if (!faltan.length) return { chequeo: 'config', ok: true, alertas: [] };
  return {
    chequeo: 'config', ok: false, detalle: { faltan },
    alertas: [{
      tipo: 'config', clave: clave('config'), accion: 'revisar',
      titulo: `Faltan ${faltan.length === 1 ? '1 variable' : `${faltan.length} variables`} de configuración en Vercel`,
      detalle: `Faltan: ${faltan.join(', ')}. Sin ellas el transcriptor no puede funcionar.`,
    }],
  };
}

async function chequeoProveedor(
  chequeo: 'r2' | 'b2' | 'assemblyai' | 'anthropic', probar: () => Promise<void>, nombre: string,
): Promise<ResultadoP8> {
  try {
    await probar();
    return { chequeo, ok: true, alertas: [] };
  } catch (e) {
    return {
      chequeo, ok: false, detalle: { error: err(e) },
      alertas: [{ tipo: 'salud', clave: clave(chequeo), accion: 'revisar', titulo: `${nombre} no responde bien`, detalle: err(e) }],
    };
  }
}

async function chequeoAtascadas({ f, ahora }: Ctx): Promise<ResultadoP8> {
  const [gs, conAlerta] = await Promise.all([f.grabacionesNoTerminales(), f.grabacionesConAlertaAbierta()]);
  const alertas: NuevaAlerta[] = [];
  let atascadas = 0, enError = 0;
  for (const g of gs) {
    if (g.estado === 'error') {
      enError++;
      if (conAlerta.has(g.id)) continue; // ya hay un aviso abierto de esta sesión (lo abrió el orquestador)
      const antes = g.estado_antes_error;
      alertas.push({
        tipo: tipoPorEstado(antes, g.origen), grabacionId: g.id, clave: clave('atascadas', g.id),
        accion: antes === 'transcrita' || antes === 'resumiendo' ? 'reintentar_resumen'
          : !antes || (g.origen === 'online' && ['grabando', 'pausada', 'subiendo'].includes(antes)) ? 'revisar' : 'reintentar',
        titulo: `Una sesión quedó con error${antes && NOMBRE_PASO[antes] ? ` (${NOMBRE_PASO[antes]})` : ''}`,
      });
      continue;
    }
    if (!ESTADOS_INTERMEDIOS.includes(g.estado)) continue;
    // Presencial: la grabación queda 'creada' mientras el iPhone graba sin red (modo avión) y hasta
    // que sube; se avisa a las 12 h (50-arquitectura §4 regla 8). Una 'creada' presencial de más de
    // 7 días se asume preparada y nunca grabada (no se insiste para siempre).
    // Online: 'creada' espera la hora de la sesión → cuenta desde la hora de fin prevista.
    const presencialEnTelefono = g.origen === 'presencial' && ['creada', 'grabando', 'pausada', 'subiendo'].includes(g.estado);
    const referencia = g.estado === 'creada' || g.estado === 'grabando' || g.estado === 'pausada' || g.estado === 'bot_en_lobby'
      ? Math.max(ms(g.updated_at) || 0, ms(g.hora_fin_prevista) || 0)
      : ms(g.updated_at);
    const edad = ahora.getTime() - referencia;
    if (!Number.isFinite(referencia) || edad < (presencialEnTelefono ? UMBRAL_TELEFONO_MS : UMBRAL_ATASCADA_MS)) continue;
    if (presencialEnTelefono && g.estado === 'creada' && edad > ABANDONADA_MS) continue;
    atascadas++;
    if (conAlerta.has(g.id)) continue;
    const horas = Math.floor((ahora.getTime() - referencia) / H);
    alertas.push({
      tipo: tipoPorEstado(g.estado, g.origen), grabacionId: g.id, clave: clave('atascadas', g.id),
      accion: presencialEnTelefono || ['grabando', 'pausada', 'subiendo', 'bot_en_lobby'].includes(g.estado) ? 'revisar'
        : g.estado === 'transcrita' || g.estado === 'resumiendo' ? 'reintentar_resumen' : 'reintentar',
      titulo: presencialEnTelefono
        ? `Una grabación presencial lleva ${horas} h sin subirse: abre Grabar en el teléfono con internet`
        : `Una sesión lleva ${horas} h detenida en «${NOMBRE_PASO[g.estado] ?? g.estado}»`,
    });
  }
  return { chequeo: 'atascadas', ok: atascadas === 0 && enError === 0, detalle: { atascadas, en_error: enError }, alertas };
}

async function chequeoAudioBorrado({ f, ahora }: Ctx): Promise<ResultadoP8> {
  const [segs, objetos] = await Promise.all([f.segmentosPendientesDeBorrar(), f.objetosAudioR2()]);
  const t = ahora.getTime();
  const sinBorrar = segs.filter((s) => {
    if (s.audio_borrado_at) return false;
    const ref = ms(s.referencia_at);
    if (POST_TRANSCRIPCION.includes(s.estado_grabacion)) return t - ref >= GRACIA_BORRADO_MS;
    if (s.estado_grabacion === 'cancelada' || s.estado_grabacion === 'sin_audio') return t - ref >= GRACIA_CANCELADA_MS;
    return false;
  });
  const viejos = objetos.filter((o) => o.modificado && t - o.modificado.getTime() >= AUDIO_R2_MAX_MS);
  const grabaciones = new Set(sinBorrar.map((s) => s.grabacion_id)).size;
  if (!sinBorrar.length && !viejos.length) return { chequeo: 'audio_borrado', ok: true, alertas: [] };
  const partes = [
    sinBorrar.length ? `${sinBorrar.length} audio(s) de ${grabaciones} sesión(es) ya transcrita(s) siguen en R2` : '',
    viejos.length ? `${viejos.length} archivo(s) de audio con más de 1 día en R2 (la regla de borrado automático del bucket no está funcionando)` : '',
  ].filter(Boolean);
  return {
    chequeo: 'audio_borrado', ok: false, detalle: { segmentos_sin_borrar: sinBorrar.length, grabaciones, objetos_viejos_r2: viejos.length },
    alertas: [{ tipo: 'salud', clave: clave('audio_borrado'), accion: 'revisar', titulo: 'Hay audio que debió borrarse y sigue guardado', detalle: partes.join('. ') }],
  };
}

async function chequeoAaiBorrado({ f, ahora }: Ctx): Promise<ResultadoP8> {
  const segs = await f.segmentosPendientesDeBorrar();
  const t = ahora.getTime();
  const pendientes = segs.filter((s) =>
    s.aai_transcript_id && !s.aai_borrado_at
    && (s.aai_estado === 'completed' || s.aai_estado === 'error')
    && [...POST_TRANSCRIPCION, 'error', 'cancelada', 'sin_audio'].includes(s.estado_grabacion)
    && t - ms(s.referencia_at) >= GRACIA_BORRADO_MS);
  if (!pendientes.length) return { chequeo: 'aai_borrado', ok: true, alertas: [] };
  const grabaciones = new Set(pendientes.map((s) => s.grabacion_id)).size;
  return {
    chequeo: 'aai_borrado', ok: false, detalle: { transcripts: pendientes.length, grabaciones },
    alertas: [{
      tipo: 'transcripcion', clave: clave('aai_borrado'), accion: 'revisar',
      titulo: 'AssemblyAI todavía guarda transcripciones que debieron borrarse',
      detalle: `${pendientes.length} transcript(s) de ${grabaciones} sesión(es) sin borrar en AssemblyAI (más de 2 h después de guardarse).`,
    }],
  };
}

async function chequeoCopiasB2({ f, ahora }: Ctx): Promise<ResultadoP8> {
  const filas = await f.transcripcionesSinCopiaB2(new Date(ahora.getTime() - GRACIA_COPIA_B2_MS));
  if (!filas.length) return { chequeo: 'copias_b2', ok: true, alertas: [] };
  return {
    chequeo: 'copias_b2', ok: false, detalle: { sin_copia: filas.length },
    alertas: [{
      tipo: 'respaldo', clave: clave('copias_b2'), accion: 'revisar',
      titulo: `${filas.length === 1 ? '1 transcripción no tiene' : `${filas.length} transcripciones no tienen`} copia en Backblaze B2`,
      detalle: 'Están guardadas (cifradas) en R2, pero falta la segunda copia de seguridad.',
    }],
  };
}

async function chequeoRespaldo({ f, ahora }: Ctx): Promise<ResultadoP8> {
  const contenido = await f.ultimoRespaldo();
  const fecha = fechaRespaldo(contenido);
  if (fecha && ahora.getTime() - fecha.getTime() < RESPALDO_MAX_MS) {
    return { chequeo: 'respaldo_supabase', ok: true, detalle: { ultimo: fecha.toISOString() }, alertas: [] };
  }
  const dias = fecha ? Math.floor((ahora.getTime() - fecha.getTime()) / (24 * H)) : null;
  return {
    chequeo: 'respaldo_supabase', ok: false, detalle: { ultimo: fecha?.toISOString() ?? null, dias },
    alertas: [{
      tipo: 'respaldo', clave: clave('respaldo_supabase'), accion: 'revisar',
      titulo: fecha ? `El último respaldo semanal de la base tiene ${dias} días` : 'No se encontró el respaldo semanal de la base',
      detalle: fecha ? 'Debería renovarse cada semana (máquina programada de Fly "respaldo-semanal").' : 'Falta respaldos/ultimo.txt en Backblaze B2.',
    }],
  };
}

async function chequeoGasto({ f, ahora, ajustes }: Ctx): Promise<ResultadoP8> {
  const mes = mesChile(ahora);
  const usd = calcularGastoUsd(await f.costosMes(mes.desde, ahora));
  const clp = Math.round(usdAClpConIva(usd.total, ajustes.usdClp));
  const proyeccion = Math.round(clp / Math.max(1, mes.diaActual) * mes.diasMes);
  const p = ajustes.presupuestoClp;
  const detalle = { mes: mes.etiqueta, usd: Math.round(usd.total * 100) / 100, clp_con_iva: clp, proyeccion_clp: proyeccion, presupuesto_clp: p };
  const fmt = (n: number) => `$${n.toLocaleString('es-CL')}`;
  if (p > 0 && clp >= UMBRAL_GASTO * p) {
    return {
      chequeo: 'gasto', ok: false, detalle,
      alertas: [{ tipo: 'costo', clave: clave('gasto'), accion: 'revisar',
        titulo: `El transcriptor lleva ${fmt(clp)} este mes (${Math.round(clp / p * 100)} % del presupuesto de ${fmt(p)})`,
        detalle: `Proyección a fin de mes: ${fmt(proyeccion)} con IVA.` }],
    };
  }
  if (p > 0 && mes.diaActual >= 7 && proyeccion > p) {
    return {
      chequeo: 'gasto', ok: false, detalle,
      alertas: [{ tipo: 'costo', clave: clave('gasto'), accion: 'revisar',
        titulo: `A este ritmo el transcriptor se pasa del presupuesto (${fmt(proyeccion)} de ${fmt(p)})`,
        detalle: `Gasto a la fecha: ${fmt(clp)} con IVA.` }],
    };
  }
  return { chequeo: 'gasto', ok: true, detalle, alertas: [] };
}

/** La regla de vercel.json: micrófono SOLO en /admin/grabar; el resto del sitio, microphone=(). */
export function revisarReglaMicrofono(config: unknown): { ok: boolean; problema?: string } {
  const headers = (config as { headers?: { source?: string; headers?: { key?: string; value?: string }[] }[] })?.headers;
  if (!Array.isArray(headers)) return { ok: false, problema: 'vercel.json no tiene la sección headers' };
  const pp = (src: string) => headers.find((h) => h.source === src)?.headers?.find((x) => x.key?.toLowerCase() === 'permissions-policy')?.value ?? null;
  const grabar = pp('/admin/grabar');
  const resto = pp('/((?!admin/grabar$).*)');
  if (!grabar || !/(^|[,\s])microphone=\(self\)/.test(grabar)) return { ok: false, problema: '/admin/grabar ya no tiene microphone=(self)' };
  if (!resto || !/(^|[,\s])microphone=\(\)/.test(resto)) return { ok: false, problema: 'el resto del sitio ya no bloquea el micrófono (microphone=())' };
  const otros = headers.filter((h) => h.source !== '/admin/grabar')
    .flatMap((h) => h.headers ?? []).filter((x) => x.key?.toLowerCase() === 'permissions-policy' && /microphone=\((?!\))/.test(x.value ?? ''));
  if (otros.length) return { ok: false, problema: 'otra ruta habilita el micrófono' };
  return { ok: true };
}

function chequeoMicrofono({ f }: Ctx): ResultadoP8 {
  const r = revisarReglaMicrofono(f.vercel());
  if (r.ok) return { chequeo: 'permisos_microfono', ok: true, alertas: [] };
  return {
    chequeo: 'permisos_microfono', ok: false, detalle: { problema: r.problema },
    alertas: [{ tipo: 'config', clave: clave('permisos_microfono'), accion: 'revisar',
      titulo: 'La regla de permisos del micrófono cambió', detalle: `vercel.json: ${r.problema}. El grabador del iPhone podría no funcionar o el micrófono quedar abierto en otras páginas.` }],
  };
}

// ─── Ejecución ────────────────────────────────────────────────────────────────

const NOMBRE_CHEQUEO: Record<ChequeoP8, string> = {
  config: 'la configuración', r2: 'Cloudflare R2', b2: 'Backblaze B2', assemblyai: 'AssemblyAI', anthropic: 'Anthropic (Claude)',
  atascadas: 'las sesiones en curso', audio_borrado: 'el borrado del audio', aai_borrado: 'el borrado en AssemblyAI',
  copias_b2: 'las copias en B2', respaldo_supabase: 'el respaldo semanal', gasto: 'el gasto del mes',
  permisos_microfono: 'el permiso del micrófono', clave: 'la llave de cifrado', fly: 'Fly.io', calendar: 'Google Calendar',
  pg_cron: 'las tareas automáticas', cobertura_online: 'la cobertura online', resumenes: 'los resúmenes',
};

/** Fila de transcriptor_salud a partir del resultado y la fila anterior (pura). */
export function filaSalud(prev: Pick<SaludFila, 'ultimo_ok_at' | 'fallo_desde' | 'alertado_at'> | undefined, r: ResultadoP8, ahora: Date) {
  const iso = ahora.toISOString();
  return {
    chequeo: r.chequeo,
    ok: r.ok,
    revisado_at: iso,
    ultimo_ok_at: r.ok ? iso : prev?.ultimo_ok_at ?? null,
    fallo_desde: r.ok ? null : prev?.fallo_desde ?? iso,
    detalle: r.detalle ?? null,
    alertado_at: r.alertas.length ? iso : prev?.alertado_at ?? null,
  };
}

export interface DepsEjecucion {
  fuentes: FuentesSalud;
  ahora?: Date;
  registrar: (a: NuevaAlerta) => Promise<void>;
  resolverPorPrefijo: (prefijo: string, salvo: readonly string[]) => Promise<number>;
  saludPrevia: () => Promise<Pick<SaludFila, 'chequeo' | 'ultimo_ok_at' | 'fallo_desde' | 'alertado_at'>[]>;
  guardarSalud: (filas: ReturnType<typeof filaSalud>[]) => Promise<void>;
  /** Tiempo máximo por chequeo (default 15 s). */
  timeoutMs?: number;
}

export interface ResumenSalud {
  ok: boolean;
  activo: boolean;
  resultados: { chequeo: ChequeoP8; ok: boolean; revisado: boolean }[];
  alertas: number;
}

function conTiempo<T>(p: Promise<T>, ms: number, nombre: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => t && clearTimeout(t)),
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${nombre}: sin respuesta en ${Math.round(ms / 1000)} s`)), ms); }),
  ]);
}

export async function ejecutarSalud(d: DepsEjecucion): Promise<ResumenSalud> {
  const ahora = d.ahora ?? new Date();
  // Dos chequeos leen los mismos segmentos: una sola consulta.
  let segmentos: Promise<SegmentoSalud[]> | null = null;
  const f: FuentesSalud = { ...d.fuentes, segmentosPendientesDeBorrar: () => (segmentos ??= d.fuentes.segmentosPendientesDeBorrar()) };
  const ajustes = await f.ajustes();
  const ctx: Ctx = { f, ahora, ajustes };
  const timeout = d.timeoutMs ?? 15_000;

  // Con el transcriptor apagado solo se revisan los datos que ya existan y la regla del micrófono
  // (no tiene sentido avisar que faltan llaves de algo que Vale todavía no activa).
  const tareas: [ChequeoP8, () => Promise<ResultadoP8> | ResultadoP8][] = [
    ['permisos_microfono', () => chequeoMicrofono(ctx)],
    ['atascadas', () => chequeoAtascadas(ctx)],
    ['audio_borrado', () => chequeoAudioBorrado(ctx)],
    ['aai_borrado', () => chequeoAaiBorrado(ctx)],
    ['copias_b2', () => chequeoCopiasB2(ctx)],
  ];
  if (ajustes.activo) {
    tareas.unshift(['config', () => chequeoConfig(ctx)]);
    tareas.push(
      ['r2', () => chequeoProveedor('r2', f.probarR2, 'Cloudflare R2 (audio y transcripciones)')],
      ['b2', () => chequeoProveedor('b2', f.probarB2, 'Backblaze B2 (copias de seguridad)')],
      ['assemblyai', () => chequeoProveedor('assemblyai', f.probarAssemblyAI, 'AssemblyAI (transcripción)')],
      ['anthropic', () => chequeoProveedor('anthropic', f.probarAnthropic, 'Anthropic (resúmenes)')],
      ['respaldo_supabase', () => chequeoRespaldo(ctx)],
      ['gasto', () => chequeoGasto(ctx)],
    );
  } else {
    // Sin el transcriptor activo, R2 solo se revisa si hay datos (lo hacen los chequeos de arriba).
  }

  const resultados = await Promise.all(tareas.map(async ([chequeo, correr]) => {
    try {
      return { r: await conTiempo(Promise.resolve().then(correr), timeout, NOMBRE_CHEQUEO[chequeo]), revisado: true };
    } catch (e) {
      const r: ResultadoP8 = {
        chequeo, ok: false, detalle: { error: err(e) },
        alertas: [{
          tipo: chequeo === 'respaldo_supabase' || chequeo === 'copias_b2' ? 'respaldo' : 'salud',
          clave: clave(chequeo, 'no_revisado'), accion: 'revisar',
          titulo: `El chequeo diario no pudo revisar ${NOMBRE_CHEQUEO[chequeo]}`, detalle: err(e),
        }],
      };
      return { r, revisado: false };
    }
  }));

  // Alertas (registrarAlerta nunca lanza) y cierre de las que ya no fallan.
  let nAlertas = 0;
  for (const { r } of resultados) for (const a of r.alertas) { await d.registrar(a); nAlertas++; }
  for (const { r, revisado } of resultados) {
    if (!revisado) continue;
    await d.resolverPorPrefijo(clave(r.chequeo), r.alertas.map((a) => a.clave!).filter(Boolean));
  }

  // Resultado en transcriptor_salud (si falla, se avisa: es el registro del chequeo).
  try {
    const previas = new Map((await d.saludPrevia()).map((p) => [p.chequeo, p]));
    await d.guardarSalud(resultados.map(({ r }) => filaSalud(previas.get(r.chequeo as ChequeoSalud), r, ahora)));
  } catch (e) {
    await d.registrar({ tipo: 'salud', clave: 'salud:registro', accion: 'revisar', titulo: 'No se pudo guardar el resultado del chequeo diario', detalle: err(e) });
    nAlertas++;
  }

  return {
    ok: resultados.every(({ r }) => r.ok),
    activo: ajustes.activo,
    resultados: resultados.map(({ r, revisado }) => ({ chequeo: r.chequeo, ok: r.ok, revisado })),
    alertas: nAlertas,
  };
}

// ─── Fuentes reales (Supabase, R2/B2, AssemblyAI, Anthropic) ─────────────────

function envReal(n: string): string | undefined {
  const p = typeof process !== 'undefined' ? process.env?.[n] : undefined;
  let v = p;
  if (!v) { try { v = ((import.meta.env ?? {}) as unknown as Record<string, string | undefined>)[n]; } catch { v = undefined; } }
  const t = typeof v === 'string' ? v.trim() : '';
  return t || undefined;
}

const esTablaFaltante = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|could not find the table/i.test(e.message ?? ''));

export async function fuentesReales(): Promise<FuentesSalud> {
  const { supabase: db } = await import('../supabase');
  const lista = async <T>(q: PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>, que: string): Promise<T[]> => {
    const { data, error } = await q;
    if (error) { if (esTablaFaltante(error)) return []; throw new Error(`${que}: ${error.message}`); }
    return (data ?? []) as T[];
  };
  const TERMINALES_SQL = '(lista,sin_audio,cancelada,sin_consentimiento,bot_no_admitido)';
  const AAI_TIMEOUT = 10_000;

  return {
    async ajustes() {
      const { data } = await db.from('settings').select('key, value')
        .in('key', ['transcriptor_activo', 'transcriptor_bot_activo', 'transcriptor_presupuesto_clp', 'transcriptor_usd_clp']);
      const m = new Map(((data ?? []) as { key: string; value: string }[]).map((r) => [r.key, String(r.value ?? '')]));
      const num = (k: string, def: number) => { const n = Number(m.get(k)); return Number.isFinite(n) && n > 0 ? n : def; };
      return {
        activo: m.get('transcriptor_activo') === 'true',
        botActivo: m.get('transcriptor_bot_activo') === 'true',
        presupuestoClp: num('transcriptor_presupuesto_clp', 35000),
        usdClp: num('transcriptor_usd_clp', 950),
      };
    },
    env: envReal,
    grabacionesNoTerminales: () => lista<GrabacionSalud>(
      db.from('grabaciones').select('id, estado, estado_antes_error, origen, updated_at, hora_fin_prevista')
        .not('estado', 'in', TERMINALES_SQL).limit(500), 'grabaciones'),
    async segmentosPendientesDeBorrar() {
      type Fila = { grabacion_id: string; audio_borrado_at: string | null; aai_transcript_id: string | null; aai_estado: string | null;
        aai_borrado_at: string | null; aai_completado_at: string | null; aai_enviado_at: string | null; subido_at: string | null; created_at: string;
        grabaciones: { estado: EstadoGrabacion } | { estado: EstadoGrabacion }[] | null };
      const filas = await lista<Fila>(
        db.from('grabacion_segmentos')
          .select('grabacion_id, audio_borrado_at, aai_transcript_id, aai_estado, aai_borrado_at, aai_completado_at, aai_enviado_at, subido_at, created_at, grabaciones!inner(estado)')
          .or('audio_borrado_at.is.null,and(aai_transcript_id.not.is.null,aai_borrado_at.is.null)')
          .limit(1000), 'segmentos');
      return filas.map((s) => {
        const g = Array.isArray(s.grabaciones) ? s.grabaciones[0] : s.grabaciones;
        return {
          grabacion_id: s.grabacion_id, estado_grabacion: (g?.estado ?? 'creada') as EstadoGrabacion,
          audio_borrado_at: s.audio_borrado_at, aai_transcript_id: s.aai_transcript_id, aai_estado: s.aai_estado, aai_borrado_at: s.aai_borrado_at,
          referencia_at: s.aai_completado_at ?? s.aai_enviado_at ?? s.subido_at ?? s.created_at,
        };
      });
    },
    transcripcionesSinCopiaB2: (limite) => lista(
      db.from('transcripciones').select('id, grabacion_id, created_at')
        .is('b2_copiada_at', null).is('deleted_at', null).lt('created_at', limite.toISOString()).limit(200), 'transcripciones'),
    async objetosAudioR2() {
      // Solo si R2 está configurado (con el transcriptor apagado puede no estarlo).
      if (!envReal('R2_ACCOUNT_ID') || !envReal('R2_BUCKET_AUDIO')) return [];
      const { almacenamiento } = await import('./almacenamiento');
      return (await almacenamiento.listar('audio', 'a/', 1000)).map((o) => ({ key: o.key, modificado: o.modificado }));
    },
    async ultimoRespaldo() {
      const { crearClienteB2 } = await import('./almacenamiento');
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const bucket = envReal('B2_BUCKET');
      if (!bucket) throw new Error('Falta B2_BUCKET');
      try {
        const r = await crearClienteB2().send(new GetObjectCommand({ Bucket: bucket, Key: 'respaldos/ultimo.txt' }));
        const texto = await r.Body?.transformToString('utf-8');
        return texto ? texto.slice(0, 500) : null;
      } catch (e) {
        const x = e as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (x?.name === 'NoSuchKey' || x?.$metadata?.httpStatusCode === 404) return null;
        throw new Error(`B2 respaldos/ultimo.txt: ${x?.name ?? 'error'} ${x?.$metadata?.httpStatusCode ?? ''}`.trim());
      }
    },
    async costosMes(desde, hasta) {
      type FilaSeg = { aai_audio_seg: number | null; grabaciones: { modelo: string; diarizacion: boolean } | { modelo: string; diarizacion: boolean }[] | null };
      const [segs, res, pre] = await Promise.all([
        lista<FilaSeg>(db.from('grabacion_segmentos').select('aai_audio_seg, grabaciones!inner(modelo, diarizacion)')
          .not('aai_audio_seg', 'is', null).gte('created_at', desde.toISOString()).lt('created_at', hasta.toISOString()).limit(5000), 'costos audio'),
        lista<{ costo_usd: number | null }>(db.from('resumenes_ia').select('costo_usd')
          .gte('created_at', desde.toISOString()).lt('created_at', hasta.toISOString()).limit(5000), 'costos resúmenes'),
        lista<{ costo_usd: number | null }>(db.from('preguntas_ia').select('costo_usd')
          .gte('created_at', desde.toISOString()).lt('created_at', hasta.toISOString()).limit(5000), 'costos preguntas'),
      ]);
      return {
        audio: segs.map((s) => { const g = Array.isArray(s.grabaciones) ? s.grabaciones[0] : s.grabaciones;
          return { seg: Number(s.aai_audio_seg) || 0, modelo: g?.modelo ?? MODELO_U35_PRO, diarizacion: !!g?.diarizacion }; }),
        usdResumenes: res.reduce((a, r) => a + (Number(r.costo_usd) || 0), 0),
        usdPreguntas: pre.reduce((a, r) => a + (Number(r.costo_usd) || 0), 0),
      };
    },
    async grabacionesConAlertaAbierta() {
      const filas = await lista<{ grabacion_id: string | null }>(
        db.from('transcriptor_alertas').select('grabacion_id').is('resuelta_at', null).not('grabacion_id', 'is', null)
          .not('clave', 'like', 'salud:atascadas:%').limit(500), 'alertas');
      return new Set(filas.map((f) => f.grabacion_id!).filter(Boolean));
    },
    async probarR2() {
      const { almacenamiento } = await import('./almacenamiento');
      await almacenamiento.listar('audio', 'a/', 1);
      await almacenamiento.listar('transcripciones', 't/', 1);
    },
    async probarB2() {
      const { crearClienteB2 } = await import('./almacenamiento');
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const bucket = envReal('B2_BUCKET');
      if (!bucket) throw new Error('Falta B2_BUCKET');
      await crearClienteB2().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 't/', MaxKeys: 1 }));
    },
    async probarAssemblyAI() {
      const key = envReal('ASSEMBLYAI_API_KEY');
      if (!key) throw new Error('Falta ASSEMBLYAI_API_KEY');
      // GET /v2/transcript?limit=1: lista (vacía o con 1 id) — sin audio ni texto.
      const r = await fetch('https://api.assemblyai.com/v2/transcript?limit=1', {
        headers: { authorization: key }, signal: AbortSignal.timeout(AAI_TIMEOUT),
      });
      await r.body?.cancel().catch(() => {});
      if (r.status === 401 || r.status === 403) throw new Error(`la llave fue rechazada (HTTP ${r.status})`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    },
    async probarAnthropic() {
      const { clienteAnthropic } = await import('./claude');
      const c = clienteAnthropic();
      // models.retrieve: ficha pública del modelo (sin datos). Confirma llave válida y modelos vigentes.
      await c.models.retrieve(MODELO_RESUMEN);
      await c.models.retrieve(MODELO_PREGUNTAS);
    },
    vercel: () => vercelJson,
  };
}

/** Ejecución completa con Supabase + alertas reales. */
export async function ejecutarSaludReal(ahora = new Date()): Promise<ResumenSalud> {
  const { supabase: db } = await import('../supabase');
  const alertas = await import('./alertas');
  return ejecutarSalud({
    ahora,
    fuentes: await fuentesReales(),
    registrar: alertas.registrarAlerta,
    resolverPorPrefijo: alertas.resolverAlertasPorPrefijo,
    async saludPrevia() {
      const { data, error } = await db.from('transcriptor_salud').select('chequeo, ultimo_ok_at, fallo_desde, alertado_at');
      if (error) throw new Error(`transcriptor_salud: ${error.message}`);
      return (data ?? []) as Pick<SaludFila, 'chequeo' | 'ultimo_ok_at' | 'fallo_desde' | 'alertado_at'>[];
    },
    async guardarSalud(filas) {
      if (!filas.length) return;
      const { error } = await db.from('transcriptor_salud').upsert(filas, { onConflict: 'chequeo' });
      if (error) throw new Error(`transcriptor_salud: ${error.message}`);
    },
  });
}
