// Transcriptor IA — avisos de errores técnicos (paquete P8).
// Decisión 8 (docs/transcriptor/01-decisiones-16oct.md): cada error técnico aparece en el PANEL
// (todas las páginas de /admin, ver src/components/admin/AlertasTranscriptor.astro) hasta que se
// resuelve; el correo a Vale es solo respaldo (máx. 1 por clave cada 6 h).
// NO es alerta de riesgo clínico (decisión 2: eso no se construye).
//
// Reglas:
//   • Sin contenido clínico: título y detalle son técnicos ("AssemblyAI respondió 500"). Nunca texto
//     de la sesión, del resumen, preguntas ni nombres de pacientes. Las URLs se borran del texto
//     (podrían ser URLs firmadas) y se acorta. El correo no lleva datos de la sesión.
//   • registrarAlerta NUNCA lanza: si la base falla, console.error y se intenta igual el correo
//     (con un freno en memoria por instancia, para no inundar a Vale si el cron corre cada minuto).
//   • Deduplicación por `clave`: mientras haya una alerta abierta con esa clave se suma `veces`.
//     Índice único parcial en 0017_transcriptor_alertas.sql (clave) where resuelta_at is null.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EstadoGrabacion, Origen } from './tipos';
import { secreto } from '../secretos';

// ─── Contrato (P6 y otros paquetes lo usan tal cual) ─────────────────────────

export type AlertaTipo = 'subida' | 'transcripcion' | 'resumen' | 'bot' | 'respaldo' | 'salud' | 'costo' | 'config';
export type AlertaAccion = 'reintentar' | 'reintentar_resumen' | 'revisar' | 'ninguna';

export interface NuevaAlerta {
  tipo: AlertaTipo;
  titulo: string;
  detalle?: string;
  grabacionId?: string | null;
  accion?: AlertaAccion;
  clave?: string;
}

export const TIPOS_ALERTA: readonly AlertaTipo[] = ['subida', 'transcripcion', 'resumen', 'bot', 'respaldo', 'salud', 'costo', 'config'];
export const ACCIONES_ALERTA: readonly AlertaAccion[] = ['reintentar', 'reintentar_resumen', 'revisar', 'ninguna'];

/** Fila de public.transcriptor_alertas. */
export interface AlertaFila {
  id: string;
  creada_at: string;
  tipo: AlertaTipo;
  titulo: string;
  detalle: string | null;
  grabacion_id: string | null;
  accion: AlertaAccion;
  clave: string;
  veces: number;
  ultima_vez: string;
  resuelta_at: string | null;
  resuelta_por: 'vale' | 'sistema' | null;
  correo_enviado_at: string | null;
}

/** Datos mínimos de la sesión para que Vale sepa de cuál se trata (solo en el panel, nunca en correo). */
export interface SesionDeAlerta {
  session_date: string;
  inicio_at: string | null;
  origen: Origen;
  estado: EstadoGrabacion;
  estado_antes_error: EstadoGrabacion | null;
  patient_id: string | null;
  paciente: string | null;
}

export interface AlertaAbierta extends AlertaFila {
  sesion: SesionDeAlerta | null;
}

// ─── Funciones puras (con pruebas en alertas.test.ts) ────────────────────────

export const FRENO_CORREO_MS = 6 * 60 * 60_000;
export const MAX_TITULO = 200;
export const MAX_DETALLE = 1000;
export const MAX_CLAVE = 200;

/** Quita URLs (podrían ser firmadas) y saltos de línea; acorta. */
export function sanearTexto(s: unknown, max: number): string {
  const t = String(s ?? '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\bbearer\s+\S+/gi, 'Bearer [oculto]')
    .replace(/\b(authorization|x-api-key|api[_-]?key)\s*[:=]\s*(?!Bearer \[oculto\])\S+/gi, '$1: [oculto]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, '[oculto]')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Clave de deduplicación: la dada, o '<tipo>:<grabacionId>' o '<tipo>:<título>'. */
export function claveDe(a: Pick<NuevaAlerta, 'tipo' | 'clave' | 'grabacionId' | 'titulo'>): string {
  const base = a.clave?.trim() || (a.grabacionId ? `${a.tipo}:${a.grabacionId}` : `${a.tipo}:${sanearTexto(a.titulo, 120).toLowerCase()}`);
  return base.slice(0, MAX_CLAVE);
}

/** ¿Toca correo? Sí si nunca se envió para esa clave o el último fue hace ≥ 6 h. */
export function debeEnviarCorreo(ultimoCorreo: string | null, ahora: Date): boolean {
  if (!ultimoCorreo) return true;
  const t = Date.parse(ultimoCorreo);
  return Number.isNaN(t) || ahora.getTime() - t >= FRENO_CORREO_MS;
}

/** Normaliza la entrada (tipo/acción válidos, textos saneados). */
export function normalizarAlerta(a: NuevaAlerta): Required<Omit<NuevaAlerta, 'detalle' | 'grabacionId'>> & { detalle: string | null; grabacionId: string | null } {
  const tipo: AlertaTipo = TIPOS_ALERTA.includes(a.tipo) ? a.tipo : 'salud';
  const accion: AlertaAccion = a.accion && ACCIONES_ALERTA.includes(a.accion) ? a.accion : 'revisar';
  const grabacionId = a.grabacionId && /^[0-9a-f-]{36}$/i.test(a.grabacionId) ? a.grabacionId : null;
  const titulo = sanearTexto(a.titulo, MAX_TITULO) || 'Error del transcriptor';
  const detalle = a.detalle ? sanearTexto(a.detalle, MAX_DETALLE) || null : null;
  // Una acción de reintento sin grabación no tiene qué reintentar.
  const accionFinal: AlertaAccion = !grabacionId && (accion === 'reintentar' || accion === 'reintentar_resumen') ? 'revisar' : accion;
  return { tipo, titulo, detalle, grabacionId, accion: accionFinal, clave: claveDe({ ...a, tipo, grabacionId, titulo }) };
}

const ETIQUETA_TIPO: Record<AlertaTipo, string> = {
  subida: 'Subida del audio',
  transcripcion: 'Transcripción',
  resumen: 'Resumen',
  bot: 'Bot de Meet',
  respaldo: 'Respaldo',
  salud: 'Chequeo diario',
  costo: 'Gasto',
  config: 'Configuración',
};
export const etiquetaTipo = (t: AlertaTipo) => ETIQUETA_TIPO[t] ?? 'Transcriptor';

const escaparHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Correo de respaldo: SIN datos de la sesión ni del paciente; solo qué falló y el enlace al panel. */
export function armarCorreo(f: Pick<AlertaFila, 'tipo' | 'titulo' | 'detalle' | 'veces'>, urlPanel: string): { asunto: string; html: string; texto: string } {
  const asunto = sanearTexto(`⚠ Transcriptor: ${f.titulo}`, 150);
  const lineas = [
    `${etiquetaTipo(f.tipo)}: ${f.titulo}`,
    f.detalle ? `Detalle técnico: ${f.detalle}` : '',
    f.veces > 1 ? `Se repitió ${f.veces} veces.` : '',
    'El aviso está en tu panel (arriba, en rojo) con el botón para resolverlo. Este correo es solo un respaldo.',
    `Abrir el panel: ${urlPanel}`,
  ].filter(Boolean);
  const html = `
    <div style="font-family:'Inter',sans-serif;max-width:480px;margin:0 auto;padding:1.5rem;color:#1A1A18;background:#FAF7F4;">
      <h2 style="font-size:1rem;font-weight:600;margin:0 0 1rem;border-bottom:2px solid #b91c1c;padding-bottom:0.5rem;">El transcriptor tiene un problema</h2>
      <p style="font-size:0.9rem;margin:0 0 0.5rem;"><strong>${escaparHtml(etiquetaTipo(f.tipo))}:</strong> ${escaparHtml(f.titulo)}</p>
      ${f.detalle ? `<p style="font-size:0.85rem;color:#6B6860;margin:0 0 0.5rem;">Detalle técnico: ${escaparHtml(f.detalle)}</p>` : ''}
      ${f.veces > 1 ? `<p style="font-size:0.85rem;color:#6B6860;margin:0 0 0.5rem;">Se repitió ${f.veces} veces.</p>` : ''}
      <p style="font-size:0.85rem;margin:1rem 0;">El aviso está en tu panel (arriba, en rojo) con el botón para resolverlo. Este correo es solo un respaldo.</p>
      <p style="margin:0;"><a href="${escaparHtml(urlPanel)}" style="display:inline-block;background:#b91c1c;color:#fff;text-decoration:none;font-weight:600;padding:0.6rem 1rem;border-radius:6px;">Abrir el panel</a></p>
    </div>`;
  return { asunto, html, texto: lineas.join('\n\n') };
}

// ─── Repositorio (Supabase o falso en pruebas) ───────────────────────────────

export interface FiltroResolver {
  id?: string;
  grabacionId?: string;
  tipo?: AlertaTipo;
  /** Resuelve las abiertas cuya clave empieza con este prefijo… */
  prefijo?: string;
  /** …salvo estas claves (siguen fallando). */
  salvo?: readonly string[];
}

export interface RepoAlertas {
  abiertaPorClave(clave: string): Promise<AlertaFila | null>;
  /** conflicto = true si chocó con el índice único (otra instancia la creó al mismo tiempo). */
  insertar(fila: Omit<AlertaFila, 'id' | 'creada_at' | 'resuelta_at' | 'resuelta_por' | 'correo_enviado_at'>): Promise<{ fila: AlertaFila | null; conflicto: boolean }>;
  /** Suma 1 a `veces` solo si sigue abierta y con las mismas `veces` (concurrencia optimista). */
  sumarVez(id: string, vecesPrevias: number, cambios: { ultima_vez: string; titulo: string; detalle: string | null; accion: AlertaAccion }): Promise<AlertaFila | null>;
  /** Último correo enviado para esa clave, en cualquier alerta (abierta o resuelta). */
  ultimoCorreo(clave: string): Promise<string | null>;
  /** Marca correo_enviado_at = ahora si sigue null o < límite. true = esta instancia envía. */
  reclamarCorreo(id: string, ahoraIso: string, limiteIso: string): Promise<boolean>;
  liberarCorreo(id: string, previo: string | null): Promise<void>;
  obtener(id: string): Promise<AlertaFila | null>;
  listarAbiertas(limite: number): Promise<AlertaAbierta[]>;
  resolver(filtro: FiltroResolver, por: 'vale' | 'sistema', ahoraIso: string): Promise<number>;
  correoDestino(): Promise<string | null>;
}

const COLS = 'id, creada_at, tipo, titulo, detalle, grabacion_id, accion, clave, veces, ultima_vez, resuelta_at, resuelta_por, correo_enviado_at';

/** Tabla aún no creada (migración 0017 sin aplicar): el panel no debe romperse ni llenar los logs. */
function esTablaFaltante(e: { code?: string; message?: string } | null | undefined): boolean {
  return !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|could not find the table/i.test(e.message ?? ''));
}

/** La tabla 0017 no existe: no se manda correo de respaldo (evita un correo por instancia nueva). */
export class TablaAlertasFaltanteError extends Error {
  constructor() { super('falta la tabla transcriptor_alertas (migración 0017 sin aplicar)'); this.name = 'TablaAlertasFaltanteError'; }
}

export function repoAlertasSupabase(db: SupabaseClient): RepoAlertas {
  const t = () => db.from('transcriptor_alertas');
  return {
    async abiertaPorClave(clave) {
      const { data, error } = await t().select(COLS).eq('clave', clave).is('resuelta_at', null).maybeSingle();
      if (error) {
        if (esTablaFaltante(error)) throw new TablaAlertasFaltanteError();
        throw new Error(`alertas.abiertaPorClave: ${error.message}`);
      }
      return (data as AlertaFila | null) ?? null;
    },
    async insertar(fila) {
      let { data, error } = await t().insert(fila).select(COLS).maybeSingle();
      // La grabación ya no existe (llave foránea): el aviso igual se muestra, sin sesión asociada.
      if (error?.code === '23503' && fila.grabacion_id) {
        ({ data, error } = await t().insert({ ...fila, grabacion_id: null, accion: fila.accion === 'ninguna' ? 'ninguna' : 'revisar' }).select(COLS).maybeSingle());
      }
      if (error) {
        if (error.code === '23505') return { fila: null, conflicto: true };
        throw new Error(`alertas.insertar: ${error.message}`);
      }
      return { fila: (data as AlertaFila | null) ?? null, conflicto: false };
    },
    async sumarVez(id, vecesPrevias, cambios) {
      const { data, error } = await t()
        .update({ ...cambios, veces: vecesPrevias + 1 })
        .eq('id', id).eq('veces', vecesPrevias).is('resuelta_at', null)
        .select(COLS).maybeSingle();
      if (error) throw new Error(`alertas.sumarVez: ${error.message}`);
      return (data as AlertaFila | null) ?? null;
    },
    async ultimoCorreo(clave) {
      const { data, error } = await t().select('correo_enviado_at').eq('clave', clave)
        .not('correo_enviado_at', 'is', null).order('correo_enviado_at', { ascending: false }).limit(1);
      if (error) throw new Error(`alertas.ultimoCorreo: ${error.message}`);
      return (data?.[0] as { correo_enviado_at: string } | undefined)?.correo_enviado_at ?? null;
    },
    async reclamarCorreo(id, ahoraIso, limiteIso) {
      const { data, error } = await t().update({ correo_enviado_at: ahoraIso })
        .eq('id', id).or(`correo_enviado_at.is.null,correo_enviado_at.lt.${limiteIso}`)
        .select('id').maybeSingle();
      if (error) throw new Error(`alertas.reclamarCorreo: ${error.message}`);
      return !!data;
    },
    async liberarCorreo(id, previo) {
      const { error } = await t().update({ correo_enviado_at: previo }).eq('id', id);
      if (error) throw new Error(`alertas.liberarCorreo: ${error.message}`);
    },
    async obtener(id) {
      const { data, error } = await t().select(COLS).eq('id', id).maybeSingle();
      if (error) throw new Error(`alertas.obtener: ${error.message}`);
      return (data as AlertaFila | null) ?? null;
    },
    async listarAbiertas(limite) {
      const { data, error } = await t().select(COLS).is('resuelta_at', null)
        .order('ultima_vez', { ascending: false }).limit(limite);
      if (error) {
        if (esTablaFaltante(error)) return [];
        throw new Error(`alertas.listarAbiertas: ${error.message}`);
      }
      const filas = (data ?? []) as AlertaFila[];
      const ids = [...new Set(filas.map((f) => f.grabacion_id).filter((x): x is string => !!x))];
      const sesiones = new Map<string, SesionDeAlerta>();
      if (ids.length) {
        const { data: gs } = await db.from('grabaciones')
          .select('id, session_date, inicio_at, origen, estado, estado_antes_error, patient_id').in('id', ids);
        const pids = [...new Set((gs ?? []).map((g: { patient_id: string | null }) => g.patient_id).filter((x): x is string => !!x))];
        const nombres = new Map<string, string>();
        if (pids.length) {
          const { data: ps } = await db.from('patients').select('id, name').in('id', pids);
          for (const p of (ps ?? []) as { id: string; name: string | null }[]) if (p.name) nombres.set(p.id, p.name);
        }
        for (const g of (gs ?? []) as (Omit<SesionDeAlerta, 'paciente'> & { id: string })[]) {
          sesiones.set(g.id, {
            session_date: g.session_date, inicio_at: g.inicio_at, origen: g.origen, estado: g.estado,
            estado_antes_error: g.estado_antes_error, patient_id: g.patient_id,
            paciente: g.patient_id ? nombres.get(g.patient_id) ?? null : null,
          });
        }
      }
      return filas.map((f) => ({ ...f, sesion: f.grabacion_id ? sesiones.get(f.grabacion_id) ?? null : null }));
    },
    async resolver(filtro, por, ahoraIso) {
      let q = t().select('id, clave').is('resuelta_at', null);
      if (filtro.id) q = q.eq('id', filtro.id);
      if (filtro.grabacionId) q = q.eq('grabacion_id', filtro.grabacionId);
      if (filtro.tipo) q = q.eq('tipo', filtro.tipo);
      if (filtro.prefijo) q = q.like('clave', `${filtro.prefijo.replace(/[\\%_]/g, '\\$&')}%`);
      const { data, error } = await q.limit(500);
      if (error) {
        if (esTablaFaltante(error)) return 0;
        throw new Error(`alertas.resolver: ${error.message}`);
      }
      const salvo = new Set(filtro.salvo ?? []);
      const ids = ((data ?? []) as { id: string; clave: string }[]).filter((r) => !salvo.has(r.clave)).map((r) => r.id);
      if (!ids.length) return 0;
      const { data: upd, error: e2 } = await t().update({ resuelta_at: ahoraIso, resuelta_por: por })
        .in('id', ids).is('resuelta_at', null).select('id');
      if (e2) throw new Error(`alertas.resolver: ${e2.message}`);
      return upd?.length ?? 0;
    },
    async correoDestino() {
      const { data } = await db.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
      const v = String((data as { value?: string } | null)?.value ?? '').trim();
      return v || null;
    },
  };
}

// ─── Correo (Resend, mismo remitente que src/lib/email.ts, sin tocar ese archivo) ─

/** Mismo respaldo que email.ts (ADMIN_EMAIL_FALLBACK): el correo real de Vale, nunca de terceros. */
export const CORREO_VALE_RESPALDO = 'vinculosquesostienen@gmail.com';
export const URL_PANEL = 'https://www.valentinaorellana.cl/admin';

export type EnviarCorreoAlerta = (para: string, c: { asunto: string; html: string; texto: string }) => Promise<boolean>;

// La llave de Resend SOLO en runtime (secretos.ts): nunca `import.meta.env` entero, que Vite
// incrusta en el bundle con todas las variables (revisión 16 oct, A2/M1). EMAIL_FROM no es
// secreto: acceso literal.
function envDe(n: 'RESEND_API_KEY' | 'EMAIL_FROM'): string | undefined {
  if (n === 'RESEND_API_KEY') return secreto('RESEND_API_KEY');
  const p = typeof process !== 'undefined' ? process.env?.EMAIL_FROM : undefined;
  if (p) return p;
  try { return import.meta.env.EMAIL_FROM; }
  catch { return undefined; } // fuera de Vite (pruebas) no hay import.meta.env
}

export const enviarCorreoResend: EnviarCorreoAlerta = async (para, c) => {
  const key = envDe('RESEND_API_KEY');
  if (!key) { console.warn('[transcriptor/alertas] RESEND_API_KEY no configurado — correo omitido'); return false; }
  const crudo = (envDe('EMAIL_FROM') || 'onboarding@resend.dev').trim();
  const from = `Ps. Valentina Orellana <${crudo.match(/<([^>]+)>/)?.[1]?.trim() ?? crudo}>`;
  try {
    const { Resend } = await import('resend');
    const res = await new Resend(key).emails.send({ from, to: para, subject: c.asunto, html: c.html, text: c.texto });
    try { await (await import('../logger')).logEmail('email/transcriptor-alerta', para, c.asunto, !res.error, res.error?.message); } catch { /* sin log */ }
    return !res.error;
  } catch (e) {
    console.error('[transcriptor/alertas] no se pudo enviar el correo:', e instanceof Error ? e.message : e);
    return false;
  }
};

// ─── Servicio ────────────────────────────────────────────────────────────────

export interface DepsAlertas {
  repo?: RepoAlertas | (() => Promise<RepoAlertas>);
  enviarCorreo?: EnviarCorreoAlerta;
  ahora?: () => Date;
  /** Registro en transcriptor_auditoria al abrir una alerta nueva (no en cada repetición). */
  auditarNueva?: (f: AlertaFila) => Promise<void>;
  urlPanel?: string;
}

export interface ServicioAlertas {
  registrarAlerta(a: NuevaAlerta): Promise<void>;
  resolverAlertasDe(grabacionId: string, tipo?: AlertaTipo): Promise<void>;
  listarAlertasAbiertas(limite?: number): Promise<AlertaAbierta[]>;
  resolverAlerta(id: string, por?: 'vale' | 'sistema'): Promise<boolean>;
  obtenerAlerta(id: string): Promise<AlertaFila | null>;
  /** Para el chequeo diario: cierra las alertas con ese prefijo que ya no fallan. */
  resolverPorPrefijo(prefijo: string, salvo: readonly string[]): Promise<number>;
}

export function crearAlertas(deps: DepsAlertas = {}): ServicioAlertas {
  const ahora = deps.ahora ?? (() => new Date());
  const enviar = deps.enviarCorreo ?? enviarCorreoResend;
  const urlPanel = deps.urlPanel ?? URL_PANEL;
  let repoCache: RepoAlertas | null = typeof deps.repo === 'object' ? deps.repo : null;
  const repo = async (): Promise<RepoAlertas> => {
    if (repoCache) return repoCache;
    repoCache = typeof deps.repo === 'function'
      ? await deps.repo()
      : repoAlertasSupabase((await import('../supabase')).supabase);
    return repoCache;
  };
  // Freno en memoria (por instancia) para cuando la base no responde.
  const correosEnMemoria = new Map<string, number>();

  async function correoDeRespaldoSinBase(n: ReturnType<typeof normalizarAlerta>) {
    const previo = correosEnMemoria.get(n.clave);
    const t = ahora().getTime();
    if (previo !== undefined && t - previo < FRENO_CORREO_MS) return;
    correosEnMemoria.set(n.clave, t);
    const c = armarCorreo({ tipo: n.tipo, titulo: n.titulo, detalle: n.detalle, veces: 1 }, urlPanel);
    if (!(await enviar(CORREO_VALE_RESPALDO, c))) correosEnMemoria.delete(n.clave);
  }

  async function registrarAlerta(a: NuevaAlerta): Promise<void> {
    let n: ReturnType<typeof normalizarAlerta>;
    try { n = normalizarAlerta(a); } catch (e) { console.error('[transcriptor/alertas] alerta inválida:', e); return; }
    let r: RepoAlertas;
    let fila: AlertaFila | null = null;
    let nueva = false;
    try {
      r = await repo();
      const iso = ahora().toISOString();
      for (let intento = 0; intento < 4 && !fila; intento++) {
        const abierta = await r.abiertaPorClave(n.clave);
        if (abierta) {
          fila = await r.sumarVez(abierta.id, abierta.veces, { ultima_vez: iso, titulo: n.titulo, detalle: n.detalle, accion: n.accion });
          continue; // null = otra instancia la tocó o la resolvieron: se vuelve a mirar
        }
        const ins = await r.insertar({
          tipo: n.tipo, titulo: n.titulo, detalle: n.detalle, grabacion_id: n.grabacionId, accion: n.accion,
          clave: n.clave, veces: 1, ultima_vez: iso,
        });
        if (ins.fila) { fila = ins.fila; nueva = true; }
        else if (!ins.conflicto) throw new Error('la base no devolvió la alerta insertada');
      }
      if (!fila) throw new Error('no se pudo registrar la alerta tras 4 intentos');
    } catch (e) {
      console.error('[transcriptor/alertas] no se pudo guardar la alerta', n.clave, '-', e instanceof Error ? e.message : e);
      if (e instanceof TablaAlertasFaltanteError) return;
      try { await correoDeRespaldoSinBase(n); } catch { /* nunca lanza */ }
      return;
    }

    if (nueva && deps.auditarNueva) {
      try { await deps.auditarNueva(fila); } catch { /* la bitácora no bloquea el aviso */ }
    }

    // Correo de respaldo (máx. 1 por clave cada 6 h).
    try {
      const t = ahora();
      const ultimo = await r.ultimoCorreo(n.clave);
      if (!debeEnviarCorreo(ultimo, t)) return;
      const limite = new Date(t.getTime() - FRENO_CORREO_MS).toISOString();
      if (!(await r.reclamarCorreo(fila.id, t.toISOString(), limite))) return;
      const para = (await r.correoDestino().catch(() => null)) ?? CORREO_VALE_RESPALDO;
      const ok = await enviar(para, armarCorreo(fila, urlPanel));
      if (!ok) await r.liberarCorreo(fila.id, fila.correo_enviado_at);
    } catch (e) {
      console.error('[transcriptor/alertas] correo de respaldo:', e instanceof Error ? e.message : e);
    }
  }

  return {
    registrarAlerta,
    async resolverAlertasDe(grabacionId, tipo) {
      try { await (await repo()).resolver({ grabacionId, tipo }, 'sistema', ahora().toISOString()); }
      catch (e) { console.error('[transcriptor/alertas] resolverAlertasDe:', e instanceof Error ? e.message : e); }
    },
    async listarAlertasAbiertas(limite = 50) {
      try { return await (await repo()).listarAbiertas(limite); }
      catch (e) { console.error('[transcriptor/alertas] listarAlertasAbiertas:', e instanceof Error ? e.message : e); return []; }
    },
    async resolverAlerta(id, por = 'vale') {
      return (await (await repo()).resolver({ id }, por, ahora().toISOString())) > 0;
    },
    async obtenerAlerta(id) {
      return (await repo()).obtener(id);
    },
    async resolverPorPrefijo(prefijo, salvo) {
      try { return await (await repo()).resolver({ prefijo, salvo }, 'sistema', ahora().toISOString()); }
      catch (e) { console.error('[transcriptor/alertas] resolverPorPrefijo:', e instanceof Error ? e.message : e); return 0; }
    },
  };
}

// ─── Instancia por defecto (Supabase + Resend + bitácora) ────────────────────

const porDefecto = crearAlertas({
  auditarNueva: async (f) => {
    const { auditar } = await import('./auditoria');
    await auditar('sistema', 'alerta', { grabacionId: f.grabacion_id, detalle: { op: 'nueva', tipo: f.tipo, clave_alerta: f.clave } });
  },
});

/** Registra (o suma una repetición de) un error técnico. Nunca lanza. */
export async function registrarAlerta(a: NuevaAlerta): Promise<void> {
  return porDefecto.registrarAlerta(a);
}
/** Cierra las alertas abiertas de una grabación (p. ej. cuando el paso volvió a salir bien). Nunca lanza. */
export async function resolverAlertasDe(grabacionId: string, tipo?: AlertaTipo): Promise<void> {
  return porDefecto.resolverAlertasDe(grabacionId, tipo);
}
/** Alertas abiertas con la sesión asociada (para el banner del panel). Nunca lanza: [] si falla. */
export async function listarAlertasAbiertas(limite?: number): Promise<AlertaAbierta[]> {
  return porDefecto.listarAlertasAbiertas(limite);
}
/** "Marcar como resuelto" (Vale) o cierre automático. true si cerró una alerta abierta. Lanza si la base falla. */
export async function resolverAlerta(id: string, por: 'vale' | 'sistema' = 'vale'): Promise<boolean> {
  return porDefecto.resolverAlerta(id, por);
}
export async function obtenerAlerta(id: string): Promise<AlertaFila | null> {
  return porDefecto.obtenerAlerta(id);
}
export async function resolverAlertasPorPrefijo(prefijo: string, salvo: readonly string[]): Promise<number> {
  return porDefecto.resolverPorPrefijo(prefijo, salvo);
}
