// Transcriptor IA — utilidades puras del panel (paquete P7).
// Textos que ve Vale (estado de cada grabación, problemas sin términos técnicos), render seguro
// del resumen en Markdown simple, nombres de hablantes, validaciones de los endpoints del panel
// y costo estimado del mes. Sin base de datos ni red: pruebas en panel.test.ts.
//
// Decisiones que respeta (01-decisiones-16oct.md): el resumen es un ANEXO rotulado, separado de
// la nota de evolución; la sección "Atención" se muestra tal cual, como cualquier otra sección
// (sin colores de alarma, sin insignias, sin avisos).
import { MODELO_U2, MODELO_U35_PRO, ROTULO_RESUMEN, type EstadoGrabacion, type Grabacion, type TramoTranscrito } from './tipos';
import { HABLANTE_NO_IDENTIFICADO, HABLANTE_SIN_SEPARAR, formatearTiempo } from './hablantes';
import { AJUSTE_NOMBRES_VALE } from './bot';
import { esperandoVale, NOTA_NADIE_LLEGO } from './botReconexion';
import { paraRevisarHoy } from './resumen';

// ─── Rótulos y textos fijos ──────────────────────────────────────────────────

export { ROTULO_RESUMEN };
/** Rótulo de una versión que Vale editó (sigue siendo de origen IA: nunca se rotula como nota suya). */
export const ROTULO_EDITADO = 'Resumen automático (IA) — editado por la terapeuta';
export const AVISO_RESUMEN = 'Generado automáticamente por IA a partir de la grabación. Puede tener errores: no reemplaza tu nota clínica.';
/** Nota fija del panel "Preguntar a la IA" (02-decisiones-16oct-noche, B). */
export const AVISO_IA_PUEDE_ERRAR = 'La IA puede cometer errores. Revisa las respuestas.';
export const AVISO_RESPUESTA ='Respuesta de IA basada solo en las transcripciones. Revisa las citas.';

/** Ajuste nuevo de P5 (bot.ts): nombres visibles de Vale en Meet separados por "|". */
export { AJUSTE_NOMBRES_VALE, NOMBRES_VALE_DEFECTO } from './bot';
export const MAX_NOMBRES_VALE = 6;
export const MAX_HABLANTES = 30;
export const MAX_NOMBRE_HABLANTE = 60;
export const MAX_RESUMEN_EDITADO = 20_000;

// ─── Estado visible de una grabación ─────────────────────────────────────────

/** proceso = "procesando"; listo; problema = "con problema"; neutro = terminó sin grabar (no es falla). */
export type Tono = 'proceso' | 'listo' | 'problema' | 'neutro';

const ESTADO_VISIBLE: Record<EstadoGrabacion, { texto: string; tono: Tono }> = {
  creada:             { texto: 'Preparada, aún sin audio', tono: 'neutro' },
  sin_consentimiento: { texto: 'No se grabó: falta el consentimiento de grabación', tono: 'neutro' },
  bot_lanzando:       { texto: 'El asistente está entrando al Meet', tono: 'proceso' },
  bot_en_lobby:       { texto: 'Esperando que admitas al asistente en Meet', tono: 'proceso' },
  bot_no_admitido:    { texto: 'El asistente no fue admitido: no se grabó', tono: 'neutro' },
  grabando:           { texto: 'Grabando', tono: 'proceso' },
  pausada:            { texto: 'Grabación en pausa', tono: 'proceso' },
  subiendo:           { texto: 'Subiendo el audio', tono: 'proceso' },
  subida:             { texto: 'Procesando: transcribiendo', tono: 'proceso' },
  transcribiendo:     { texto: 'Procesando: transcribiendo', tono: 'proceso' },
  transcrita:         { texto: 'Procesando: escribiendo el resumen', tono: 'proceso' },
  resumiendo:         { texto: 'Procesando: escribiendo el resumen', tono: 'proceso' },
  lista:              { texto: 'Listo', tono: 'listo' },
  sin_audio:          { texto: 'Con problema: la grabación no tiene audio', tono: 'problema' },
  cancelada:          { texto: 'Cancelada', tono: 'neutro' },
  error:              { texto: 'Con problema', tono: 'problema' },
};

export function estadoVisible(estado: EstadoGrabacion | string | null | undefined): { texto: string; tono: Tono } {
  return ESTADO_VISIBLE[estado as EstadoGrabacion] ?? { texto: 'Estado desconocido', tono: 'neutro' };
}

/**
 * Qué le pasó a SU grabación y qué hacer, sin términos técnicos (40-ux §7). El detalle técnico
 * (ultimo_error) nunca se muestra aquí: queda en la base y en /admin/logs.
 */
export function textoProblema(g: Pick<Grabacion, 'estado' | 'estado_antes_error'> & Partial<Pick<Grabacion, 'nota_sistema'>>): string | null {
  // r2: el robot esperó y nadie entró a la reunión (no es una falla del audio).
  if (g.estado === 'sin_audio' && g.nota_sistema === NOTA_NADIE_LLEGO) return NOTA_NADIE_LLEGO;
  // Vale, 18 oct: Vale salió y la grabación espera 15 min por si vuelve (misma grabación, una transcripción).
  if (g.estado === 'grabando' && esperandoVale({ estado: g.estado, bot_machine_id: null, nota_sistema: g.nota_sistema })) return g.nota_sistema ?? null;
  if (g.estado === 'sin_audio') return 'La grabación quedó sin audio, así que no se generó resumen.';
  if (g.estado !== 'error') return null;
  switch (g.estado_antes_error) {
    case 'creada': case 'grabando': case 'pausada': case 'subiendo':
      return 'No se pudo terminar de recibir el audio. Si quedó guardado en el teléfono, abre "Grabar sesión" en ese teléfono con internet.';
    case 'bot_lanzando': case 'bot_en_lobby':
      return 'El asistente de notas no pudo entrar al Meet. Esta sesión no se grabó.';
    case 'subida': case 'transcribiendo':
      return 'No se pudo transcribir la sesión. El audio está a salvo: puedes reintentar.';
    case 'transcrita': case 'resumiendo':
      return 'La transcripción está lista, pero el resumen no se pudo generar. Puedes reintentar.';
    default:
      return 'Algo falló al procesar esta grabación. Puedes reintentar.';
  }
}

/** ¿Muestra el botón "Reintentar"? (mismo criterio que estados.destinoReintento, sin importar la base). */
export function sePuedeReintentar(g: Pick<Grabacion, 'estado' | 'estado_antes_error'>): boolean {
  return g.estado === 'error' && !!g.estado_antes_error;
}

// ─── Fechas y textos cortos ──────────────────────────────────────────────────

const MESES_LARGOS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** '2026-10-15' → 'miércoles 15 de octubre de 2026' (sin Intl: igual en todo entorno). */
export function fechaLarga(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return iso ?? '';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return `${DIAS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]} ${d} de ${MESES_LARGOS[mo - 1]} de ${y}`;
}

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** '2026-10-03' → '3 oct 2026' (mismo formato que fechaLegible de resumen.ts, que usan las citas de la IA). */
export function fechaCorta(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return iso ?? '';
  return `${Number(m[3])} ${MESES_CORTOS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** Segundos → '50 min', '1 h 05 min', '45 s'. */
export function duracionTexto(seg: number | null | undefined): string {
  if (seg == null || !Number.isFinite(seg) || seg < 0) return '';
  const s = Math.round(seg);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

export function tipoTexto(g: Pick<Grabacion, 'tipo' | 'origen'>): string {
  const t = g.tipo === 'pareja' ? 'Pareja' : g.tipo === 'individual' ? 'Individual' : 'Sesión';
  return `${t} ${g.origen === 'online' ? 'online' : 'presencial'}`;
}

// ─── Render seguro del resumen (Markdown simple → HTML) ──────────────────────

export function escaparHtml(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 'mm:ss' | 'h:mm:ss' → segundos. */
function segundos(marca: string): number | null {
  const p = marca.split(':').map(Number);
  if (p.length < 2 || p.length > 3 || p.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

/** Negrita, cursiva y marcas [mm:ss] (opcionalmente enlazadas a la transcripción). Entra texto YA escapado. */
function enLinea(esc: string, enlaceMinuto?: (seg: number) => string): string {
  let t = esc
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(«])\*([^*\s][^*]*?)\*(?=[\s).,;:»]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(«])_([^_\s][^_]*?)_(?=[\s).,;:»]|$)/g, '$1<em>$2</em>');
  if (enlaceMinuto) {
    t = t.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (todo, marca: string) => {
      const s = segundos(marca);
      return s == null ? todo : `<a class="ia-min" href="${escaparHtml(enlaceMinuto(s))}">[${marca}]</a>`;
    });
  }
  return t;
}

/**
 * Markdown del resumen (formato de resumen.ts: "## título", línea "*datos*", "### Sección",
 * viñetas "- ") → HTML. Todo se escapa ANTES de dar formato, así que el contenido del modelo
 * nunca puede inyectar HTML. El título "## …" se omite (la tarjeta pone el rótulo fijo).
 * "Atención" se dibuja igual que cualquier sección (decisión 16 oct: sin alarma).
 */
export function resumenAHtml(md: string | null | undefined, enlaceMinuto?: (seg: number) => string): string {
  const out: string[] = [];
  let enLista = false;
  const cerrarLista = () => { if (enLista) { out.push('</ul>'); enLista = false; } };
  for (const cruda of (md ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const l = cruda.trim();
    if (!l) { cerrarLista(); continue; }
    if (/^#{1,2}\s+/.test(l)) { cerrarLista(); continue; }
    const h = /^#{3,6}\s+(.+)$/.exec(l);
    if (h) { cerrarLista(); out.push(`<h4>${enLinea(escaparHtml(h[1]), enlaceMinuto)}</h4>`); continue; }
    const v = /^(?:[-*•]|\d{1,2}[.)])\s+(.+)$/.exec(l);
    if (v) {
      if (!enLista) { out.push('<ul>'); enLista = true; }
      out.push(`<li>${enLinea(escaparHtml(v[1]), enlaceMinuto)}</li>`);
      continue;
    }
    cerrarLista();
    const meta = /^\*([^*].*)\*$/.exec(l) ?? /^_([^_].*)_$/.exec(l);
    if (meta) { out.push(`<p class="ia-meta">${enLinea(escaparHtml(meta[1]), enlaceMinuto)}</p>`); continue; }
    out.push(`<p>${enLinea(escaparHtml(l), enlaceMinuto)}</p>`);
  }
  cerrarLista();
  return out.join('\n');
}

/** Texto plano del resumen para "Copiar a mi nota" (sin título ni marcas de Markdown). */
export function resumenATexto(md: string | null | undefined): string {
  return (md ?? '').replace(/\r\n?/g, '\n').split('\n')
    .filter((l) => !/^#{1,2}\s+/.test(l.trim()))
    .map((l) => l.trim()
      .replace(/^#{3,6}\s+(.+)$/, (_, t: string) => `${t.toUpperCase()}`)
      .replace(/^[-*•]\s+/, '• ')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/^\*([^*].*)\*$/, '$1')
      .replace(/^_([^_].*)_$/, '$1'))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Marca breve que encabeza una evolución que viene del resumen IA (trazabilidad clínica). */
export const ENCABEZADO_EVOLUCION_IA = 'Basado en el resumen automático (IA) — revisar y editar:';

/** Texto de la evolución a partir del resumen (botón "Usar como base" y autollenado). '' si no hay resumen. */
export function textoEvolucionDesdeResumen(md: string | null | undefined): string {
  const texto = resumenATexto(md);
  return texto ? `${ENCABEZADO_EVOLUCION_IA}\n${texto}` : '';
}

/** La nota todavía lleva la marca del autollenado (Vale puede borrarla al editar). */
export function esEvolucionDesdeResumen(content: string | null | undefined): boolean {
  return (content ?? '').trimStart().startsWith(ENCABEZADO_EVOLUCION_IA);
}

// ─── Hablantes ───────────────────────────────────────────────────────────────
// La transcripción guardada ya trae el nombre que puso P2 al unir (p. ej. 'Hablante A' o
// 'Hablante A (parte 2)' en presencial; el nombre de Meet en online). mapa_hablantes usa las
// CLAVES de P2 ('A', '2-A', nombre de Meet): renombrar aquí guarda mapa[clave] = nombre nuevo,
// así una futura unión y esta vista coinciden.

/** Etiqueta guardada → clave de mapa_hablantes. */
export function claveDeEtiqueta(etiqueta: string): string {
  const m = /^Hablante ([A-Z]{1,2})(?: \(parte (\d+)\))?$/.exec((etiqueta ?? '').trim());
  if (!m) return (etiqueta ?? '').trim();
  return m[2] ? `${m[2]}-${m[1]}` : m[1];
}

/** Las etiquetas genéricas (sin separar / no identificado) no se renombran. */
export function esRenombrable(etiqueta: string): boolean {
  return !!etiqueta && etiqueta !== HABLANTE_SIN_SEPARAR && etiqueta !== HABLANTE_NO_IDENTIFICADO;
}

/** Nombre a mostrar para una etiqueta guardada. */
export function nombreHablante(etiqueta: string, mapa: Record<string, string> | null | undefined): string {
  if (!esRenombrable(etiqueta)) return etiqueta;
  const n = mapa?.[claveDeEtiqueta(etiqueta)] ?? mapa?.[etiqueta];
  return typeof n === 'string' && n.trim() ? n.trim() : etiqueta;
}

/** Tramos con los nombres de mapa_hablantes aplicados (útil también para P3/P6 si quieren usarlo). */
export function aplicarMapaHablantes(tramos: TramoTranscrito[], mapa: Record<string, string> | null | undefined): TramoTranscrito[] {
  return tramos.map((t) => ({ ...t, hablante: nombreHablante(t.hablante, mapa) }));
}

export type Resultado<T> = { ok: true; valor: T } | { ok: false; error: string };

const CONTROL = /[\u0000-\u001f\u007f<>]/g;

/**
 * Valida los cambios de nombres que manda la ficha: { clave: nombre }. Nombre vacío = volver al
 * nombre por defecto (se borra la clave). Devuelve el mapa COMPLETO resultante.
 */
export function fusionarMapaHablantes(actual: Record<string, string> | null | undefined, cambios: unknown): Resultado<Record<string, string>> {
  if (!cambios || typeof cambios !== 'object' || Array.isArray(cambios)) return { ok: false, error: 'Nombres no válidos.' };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(actual ?? {})) if (typeof v === 'string') out[k] = v;
  const entradas = Object.entries(cambios as Record<string, unknown>);
  if (!entradas.length) return { ok: false, error: 'No hay cambios.' };
  if (entradas.length > MAX_HABLANTES) return { ok: false, error: 'Demasiados hablantes.' };
  for (const [claveCruda, v] of entradas) {
    const clave = claveCruda.replace(CONTROL, '').trim();
    if (!clave || clave.length > 80) return { ok: false, error: 'Hablante no válido.' };
    if (!esRenombrable(clave)) return { ok: false, error: 'Ese hablante no se puede renombrar.' };
    if (typeof v !== 'string') return { ok: false, error: 'Nombre no válido.' };
    const nombre = v.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
    if (nombre.length > MAX_NOMBRE_HABLANTE) return { ok: false, error: `Cada nombre puede tener hasta ${MAX_NOMBRE_HABLANTE} caracteres.` };
    if (nombre) out[clave] = nombre; else delete out[clave];
  }
  if (Object.keys(out).length > MAX_HABLANTES) return { ok: false, error: 'Demasiados hablantes.' };
  return { ok: true, valor: out };
}

/** "Valentina Orellana | Vínculos que sostienen" (o una por línea) → 'Valentina Orellana|Vínculos que sostienen'. */
export function normalizarNombresVale(texto: unknown): Resultado<string> {
  if (typeof texto !== 'string') return { ok: false, error: 'Escribe al menos un nombre.' };
  const nombres = [...new Set(texto.split(/[|\n]/).map((n) => n.replace(CONTROL, '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (!nombres.length) return { ok: false, error: 'Escribe al menos un nombre.' };
  if (nombres.length > MAX_NOMBRES_VALE) return { ok: false, error: `Puedes poner hasta ${MAX_NOMBRES_VALE} nombres.` };
  if (nombres.some((n) => n.length < 2 || n.length > 60)) return { ok: false, error: 'Cada nombre debe tener entre 2 y 60 caracteres.' };
  return { ok: true, valor: nombres.join('|') };
}

// ─── Ajustes que se pueden cambiar desde el panel ────────────────────────────

export const AJUSTES_EDITABLES = {
  transcriptor_activo: 'booleano',
  transcriptor_bot_activo: 'booleano',
  [AJUSTE_NOMBRES_VALE]: 'nombres',
} as const;
export type ClaveAjusteEditable = keyof typeof AJUSTES_EDITABLES;

export function validarAjuste(clave: unknown, valor: unknown): Resultado<{ clave: ClaveAjusteEditable; valor: string }> {
  if (typeof clave !== 'string' || !(clave in AJUSTES_EDITABLES)) return { ok: false, error: 'Ese ajuste no se puede cambiar aquí.' };
  const c = clave as ClaveAjusteEditable;
  if (AJUSTES_EDITABLES[c] === 'booleano') {
    if (valor === true || valor === 'true') return { ok: true, valor: { clave: c, valor: 'true' } };
    if (valor === false || valor === 'false') return { ok: true, valor: { clave: c, valor: 'false' } };
    return { ok: false, error: 'Valor no válido.' };
  }
  const n = normalizarNombresVale(valor);
  return n.ok ? { ok: true, valor: { clave: c, valor: n.valor } } : n;
}

// ─── Decisión 3: sin passkey obligatoria no se enciende el transcriptor ──────
// (revisión de seguridad 16 oct, A1). Se aplica en ajustes.ts (rechazo en el servidor) y la
// página /admin/transcriptor muestra el mismo motivo junto a los interruptores.

export const AJUSTES_QUE_EXIGEN_PASSKEY = ['transcriptor_activo', 'transcriptor_bot_activo'] as const;

/** ¿Este cambio es un ENCENDIDO que exige passkey obligatoria? (apagar siempre se permite). */
export function exigePasskeyObligatoria(clave: string, valor: string): boolean {
  return valor === 'true' && (AJUSTES_QUE_EXIGEN_PASSKEY as readonly string[]).includes(clave);
}

/**
 * Ronda 2 (18 oct): toda escritura de /api/admin/transcriptor/ajustes exige sesión con passkey
 * (exigirAccesoClinico), como las demás rutas sensibles, SALVO apagar el transcriptor o el robot:
 * apagar reduce el riesgo y debe poder hacerse siempre (p. ej. desde un teléfono sin la passkey).
 */
export function ajustePermitidoSinPasskey(clave: string, valor: string): boolean {
  return valor === 'false' && (AJUSTES_QUE_EXIGEN_PASSKEY as readonly string[]).includes(clave);
}

/** Estado de passkeys (de passkey/servidor.ts estadoPasskeys) o 'error' si no se pudo leer. */
export type EstadoPasskeyActivacion = { cantidad: number; obligatoria: boolean; migracionPendiente: boolean } | 'error';

/** null = se puede encender; si no, el motivo en palabras de Vale. Falla cerrado. */
export function motivoBloqueoActivacion(estado: EstadoPasskeyActivacion | null | undefined, nivelSesion: 'contrasena' | 'passkey' | null): string | null {
  if (!estado || estado === 'error') return 'No pude revisar la configuración de tu passkey. Intenta de nuevo en unos minutos.';
  if (estado.migracionPendiente) return 'Falta aplicar en Supabase la migración de passkeys (0015). Sin passkey obligatoria no se puede encender el transcriptor.';
  if (estado.cantidad === 0) return 'Para encender el transcriptor, primero registra tu passkey (Face ID o huella) en Seguridad y activa "Passkey obligatoria".';
  if (!estado.obligatoria) return 'Para encender el transcriptor, primero activa "Passkey obligatoria" en Seguridad: así la contraseña sola no basta para ver transcripciones ni resúmenes.';
  if (nivelSesion !== 'passkey') return 'Confirma esta sesión con tu passkey en Seguridad para encender el transcriptor.';
  return null;
}

// ─── Costo estimado del mes ──────────────────────────────────────────────────
// Precios oficiales verificados en 50-arquitectura §8 (15 oct 2026). Es una ESTIMACIÓN para el
// panel: la cifra real es la factura de cada proveedor (P8 compara en su reporte mensual).

export const PRECIOS_USD = {
  u2PorHora: 0.15,
  u35ProPorHora: 0.21,
  diarizacionPorHora: 0.02,
  flyPorSegundo: 0.00000517,
  /** Minutos de máquina del bot además del audio (entrar, esperar en sala, salir). */
  botExtraSeg: 10 * 60,
} as const;
export const IVA = 1.19;

export interface EntradaCosto {
  /** Por segmento transcrito: segundos facturados + modelo y diarización de su grabación. */
  segmentos: { audioSeg: number | null; modelo: string; diarizacion: boolean }[];
  usdResumenes: number;
  usdPreguntas: number;
  /** Duración (s) de cada grabación online con bot (para estimar Fly). */
  botDuraciones: (number | null)[];
  usdClp: number;
}
export interface CostoMes {
  usd: { transcripcion: number; resumenes: number; preguntas: number; bot: number; total: number };
  clp: { transcripcion: number; resumenes: number; preguntas: number; bot: number; total: number };
}

export function costoMes(e: EntradaCosto): CostoMes {
  let transcripcion = 0;
  for (const s of e.segmentos) {
    const h = Math.max(0, Number(s.audioSeg) || 0) / 3600;
    const tarifa = s.modelo === MODELO_U35_PRO ? PRECIOS_USD.u35ProPorHora : s.modelo === MODELO_U2 ? PRECIOS_USD.u2PorHora : PRECIOS_USD.u35ProPorHora;
    transcripcion += h * (tarifa + (s.diarizacion ? PRECIOS_USD.diarizacionPorHora : 0));
  }
  const bot = e.botDuraciones.reduce<number>((acc, d) => acc + (Math.max(0, Number(d) || 0) + PRECIOS_USD.botExtraSeg) * PRECIOS_USD.flyPorSegundo, 0);
  const resumenes = Math.max(0, Number(e.usdResumenes) || 0);
  const preguntas = Math.max(0, Number(e.usdPreguntas) || 0);
  const usd = { transcripcion, resumenes, preguntas, bot, total: transcripcion + resumenes + preguntas + bot };
  const f = (Number(e.usdClp) > 0 ? Number(e.usdClp) : 950) * IVA;
  const aClp = (x: number) => Math.round(x * f);
  return {
    usd,
    clp: { transcripcion: aClp(transcripcion), resumenes: aClp(resumenes), preguntas: aClp(preguntas), bot: aClp(bot), total: aClp(usd.total) },
  };
}

/** Porcentaje del tope (0–100+, entero). */
export function porcentajeTope(totalClp: number, topeClp: number): number {
  if (!(topeClp > 0)) return 0;
  return Math.round((Math.max(0, totalClp) / topeClp) * 100);
}

// ─── Transcripción para la vista ─────────────────────────────────────────────

export interface LineaVista { tipo: 'tramo' | 'pausa'; ms: number; marca: string; hablante?: string; texto: string }

/** Tramos + pausas ordenados por tiempo, con nombres aplicados y [mm:ss]. */
export function lineasTranscripcion(
  tramos: TramoTranscrito[],
  pausas: { desde_ms: number; hasta_ms: number }[] | null | undefined,
  mapa: Record<string, string> | null | undefined,
): LineaVista[] {
  const lineas: LineaVista[] = tramos.map((t) => ({
    tipo: 'tramo', ms: t.inicio_ms, marca: formatearTiempo(t.inicio_ms), hablante: nombreHablante(t.hablante, mapa), texto: t.texto,
  }));
  for (const p of pausas ?? []) {
    if (!Number.isFinite(p?.desde_ms) || !Number.isFinite(p?.hasta_ms)) continue;
    const min = Math.max(1, Math.round((p.hasta_ms - p.desde_ms) / 60000));
    lineas.push({ tipo: 'pausa', ms: p.desde_ms, marca: formatearTiempo(p.desde_ms), texto: `Grabación pausada a pedido (${min} min)` });
  }
  return lineas.sort((a, b) => a.ms - b.ms || (a.tipo === 'pausa' ? -1 : 1));
}

/** Etiquetas únicas (en orden de aparición) para el formulario de renombrar. */
export function etiquetasUnicas(tramos: TramoTranscrito[]): string[] {
  return [...new Set(tramos.map((t) => t.hablante).filter(Boolean))];
}

// ─── Ficha estilo historial (02-decisiones-16oct-noche, B) ───────────────────
// Una entrada por sesión: la reserva (si la hay), la nota de evolución de Vale y la(s) grabación(es)
// con su resumen IA. Se une por booking_id; lo que no tiene reserva se une por fecha.

export interface ReservaHistorial { id: string; session_date: string; session_time?: string | null; session_type?: string | null; status?: string | null; custom_title?: string | null }
export interface NotaHistorial { id: string; booking_id?: string | null; session_date: string; session_type?: string | null }
export interface TarjetaHistorial { g: { id: string; booking_id: string | null; session_date: string; inicio_at?: string | null; tipo?: string | null; origen?: string | null } }

export interface EntradaHistorial<N extends NotaHistorial, T extends TarjetaHistorial> {
  clave: string;
  fecha: string;
  /** 'HH:MM' (de la reserva o del inicio de la grabación) o ''. */
  hora: string;
  reserva: ReservaHistorial | null;
  /** online | presencial | pareja-online | pareja-presencial (o null). */
  sessionType: string | null;
  notas: N[];
  ia: T[];
}

const horaChile = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  : '';

/** session_type de una grabación (tipo + origen) para la etiqueta y el formulario de nota. */
export function sessionTypeDeGrabacion(g: { tipo?: string | null; origen?: string | null }): string | null {
  if (!g.origen) return null;
  return g.tipo === 'pareja' ? `pareja-${g.origen}` : g.origen;
}

export function armarHistorial<N extends NotaHistorial, T extends TarjetaHistorial>(p: {
  notas: N[]; tarjetas: T[]; reservas: ReservaHistorial[]; hoy: string;
}): EntradaHistorial<N, T>[] {
  const porClave = new Map<string, EntradaHistorial<N, T>>();
  const reservas = new Map(p.reservas.map((r) => [r.id, r]));
  const entrada = (clave: string, fecha: string) => {
    let e = porClave.get(clave);
    if (!e) { e = { clave, fecha, hora: '', reserva: null, sessionType: null, notas: [], ia: [] }; porClave.set(clave, e); }
    return e;
  };
  const conReserva = (e: EntradaHistorial<N, T>, r: ReservaHistorial) => {
    if (e.reserva) return;
    e.reserva = r; e.hora = (r.session_time ?? '').slice(0, 5); e.sessionType = r.session_type ?? null;
  };
  // Reservas que ya ocurrieron (o de hoy), no canceladas ni vencidas (una reserva web que no se
  // pagó nunca fue sesión; auditoría 19 oct 2026): se puede escribir su evolución.
  for (const r of p.reservas) {
    if (r.status === 'cancelled' || r.status === 'expired' || r.session_date === '2099-12-31' || r.session_date > p.hoy) continue;
    conReserva(entrada(`b:${r.id}`, r.session_date), r);
  }
  for (const t of p.tarjetas) {
    const r = t.g.booking_id ? reservas.get(t.g.booking_id) : undefined;
    const e = r ? entrada(`b:${r.id}`, r.session_date) : entrada(`d:${t.g.session_date}`, t.g.session_date);
    if (r) conReserva(e, r);
    if (!e.hora) e.hora = horaChile(t.g.inicio_at);
    e.sessionType ??= sessionTypeDeGrabacion(t.g);
    e.ia.push(t);
  }
  for (const n of p.notas) {
    const r = n.booking_id ? reservas.get(n.booking_id) : undefined;
    // Sin reserva: se junta con la grabación sin reserva de ese día (si la hay).
    const e = r ? entrada(`b:${r.id}`, r.session_date) : entrada(`d:${n.session_date}`, n.session_date);
    if (r) conReserva(e, r);
    e.sessionType ??= n.session_type ?? null;
    e.notas.push(n);
  }
  return [...porClave.values()].sort((a, b) => b.fecha.localeCompare(a.fecha) || b.hora.localeCompare(a.hora));
}

export const ETIQUETA_SESION: Record<string, string> = {
  online: 'Individual online', presencial: 'Individual presencial', 'pareja-online': 'Pareja online', 'pareja-presencial': 'Pareja presencial',
};

/**
 * "Para revisar hoy": "Para trabajar en la próxima sesión" + "Tareas" del ÚLTIMO resumen listo
 * (la sesión más reciente que tenga alguna de las dos secciones). null si no hay.
 */
export function bloqueParaRevisarHoy<T extends { g: { id: string; session_date: string; created_at?: string | null }; contenido: string | null }>(tarjetas: T[]): {
  grabacionId: string; fecha: string; proxima: string | null; tareas: string | null; md: string;
} | null {
  const orden = [...tarjetas].filter((t) => t.contenido)
    .sort((a, b) => b.g.session_date.localeCompare(a.g.session_date) || String(b.g.created_at ?? '').localeCompare(String(a.g.created_at ?? '')));
  for (const t of orden) {
    const { proxima, tareas } = paraRevisarHoy(t.contenido);
    if (!proxima && !tareas) continue;
    const md = [proxima ? `### Para trabajar en esta sesión\n${proxima}` : null, tareas ? `### Tareas que quedaron\n${tareas}` : null].filter(Boolean).join('\n\n');
    return { grabacionId: t.g.id, fecha: t.g.session_date, proxima, tareas, md };
  }
  return null;
}

// ─── Robot de Meet: modo y sesión de su cuenta (añadido en t-n-pulido) ───────
// Solo al final del archivo (otro paquete edita panel.ts en paralelo). Pruebas en panelRobot.test.ts.
import { AJUSTE_BOT_MODO, normalizarModoBot, type ModoBot } from './botCuenta';

export { AJUSTE_BOT_MODO };
export type EstadoSesionRobot = 'sin_sesion' | 'activa' | 'vencida';

/** Columnas NO secretas de transcriptor_bot_sesion (el panel nunca lee sesion_cifrada). */
export interface FilaSesionRobot { cuenta_email?: string | null; estado?: string | null; actualizada_at?: string | null; vencida_motivo?: string | null }

/** Estado de la sesión de Google del robot: sin fila o sin cuenta = 'sin_sesion'. */
export function estadoSesionRobot(f: FilaSesionRobot | null | undefined): EstadoSesionRobot {
  if (!f || !String(f.cuenta_email ?? '').trim()) return 'sin_sesion';
  return f.estado === 'vigente' ? 'activa' : 'vencida';
}

export const TEXTO_SESION_ROBOT: Record<EstadoSesionRobot, string> = {
  sin_sesion: 'Todavía no se ha iniciado sesión en la cuenta del robot (85-robot-meet §7.2, con Claude).',
  activa: 'El robot entra con su cuenta, con su nombre y foto, sin pedir permiso.',
  vencida: 'Google pidió iniciar sesión de nuevo. Mientras tanto entra como invitado y tú lo admites (85-robot-meet §7.3).',
};
export const ETIQUETA_SESION_ROBOT: Record<EstadoSesionRobot, string> = { sin_sesion: 'Sin sesión', activa: 'Activa', vencida: 'Vencida' };

/** Texto del interruptor del asistente según el modo y la sesión ("Tú lo admites en Meet" solo cuando es cierto). */
export function textoAsistenteMeet(modo: ModoBot, sesion: EstadoSesionRobot): string {
  const base = 'El asistente "Notas Ps. Valentina Orellana" entra solo a tus sesiones online con consentimiento de grabación.';
  if (modo === 'cuenta' && sesion === 'activa') return `${base} Entra con su propia cuenta de Google, sin pedir permiso. Solo en eventos que no organizas tú (como los de Encuadrado) pide unirse y lo admites.`;
  if (modo === 'cuenta') return `${base} Hoy entra como invitado porque su cuenta no tiene una sesión activa: tú lo admites en Meet.`;
  return `${base} Tú lo admites en Meet.`;
}

/** Valida transcriptor_bot_modo. 'cuenta' exige que la cuenta del robot ya exista (sesión activa o vencida). */
export function validarModoBot(valor: unknown, sesion: EstadoSesionRobot | 'error'): Resultado<ModoBot> {
  if (valor !== 'cuenta' && valor !== 'invitado') return { ok: false, error: 'Valor no válido.' };
  const modo = normalizarModoBot(valor);
  if (modo === 'cuenta' && sesion === 'error') return { ok: false, error: 'No pude revisar la cuenta del robot. Intenta de nuevo en unos minutos.' };
  if (modo === 'cuenta' && sesion === 'sin_sesion') return { ok: false, error: 'Primero hay que iniciar sesión una vez en la cuenta del robot (85-robot-meet §7.2, con Claude). Mientras tanto queda como invitado.' };
  return { ok: true, valor: modo };
}
