// Transcriptor IA — prueba ciega Sonnet 5.5 vs Haiku 5.5 del resumen (/admin/transcriptor/comparar).
// Lógica PURA (sin base ni red, salvo `generarPar`, que llama a Claude con el cliente inyectable):
//   • Parámetros por modelo, verificados en la doc oficial (skill claude-api, 17 oct 2026):
//       - claude-sonnet-5-5: thinking {type:'disabled'} → 400; para apagarlo se usa 'between_tools',
//         válido solo con esfuerzo ≤ high y sin otros campos. Es exactamente CONFIG_RESUMEN (producción).
//       - claude-haiku-5-5: acepta {type:'disabled'} con esfuerzo ≤ high (su esfuerzo por defecto es medium).
//     Los dos van SIN pensamiento, con el mismo esfuerzo ('medium') y el mismo tope de salida, para que la
//     comparación sea del modelo y no de la configuración.
//   • El prompt es el ACTUAL de producción (resumen.ts: armarPromptResumen + posprocesarResumen, con la
//     misma verificación de citas). Se arma UNA vez y se manda igual a los dos modelos.
//   • Orden ciego: qué modelo es "Resumen 1" se sortea por caso en el servidor (sortearOrden).
//   • Evaluación automática de fidelidad SIN otra IA: citas que no se verificaron, secciones fijas que
//     faltaron o sobraron en la salida del modelo, minutos que no calzan con la transcripción, viñetas de
//     Tareas/Próxima sin minuto, relato escrito en viñetas, términos (nombres propios, números) que no
//     aparecen en la transcripción (y cuántos de ellos están en el relato), largo del relato según la
//     duración, y —en los casos sintéticos— lo esperado (riesgo consignado, tramo no registrado, tareas).
//     El relato (17 oct) NO exige minuto por frase: solo en momentos clave.
//   • Revelado: solo cuando todos los casos listos tienen voto (revelar).
import { CONFIG_RESUMEN, costoUsd, llamarClaude, type ClienteMensajes, type ConfigUso, type OpcionesReintento, type UsoTokens } from './claude';
import {
  PROMPT_VERSION_RESUMEN, RE_CITA, SECCION_RELATO, armarPromptResumen, claveSeccion, normalizarParaComparar, normalizarSalida,
  parsearResumen, posprocesarResumen, segundosDeMarca, type MetaSesion, type Plantilla, type PromptArmado,
} from './resumen';
import { MODELO_PREGUNTAS, MODELO_RESUMEN, type AccionAuditoria, type TramoTranscrito } from './tipos';
import type { EsperadoCaso } from './pruebas/comparacion/tipos';

// ─── Modelos y parámetros ────────────────────────────────────────────────────

export const MODELO_SONNET = MODELO_RESUMEN;   // 'claude-sonnet-5-5'
export const MODELO_HAIKU = MODELO_PREGUNTAS;  // 'claude-haiku-5-5'
export const MODELOS_COMPARADOS = [MODELO_SONNET, MODELO_HAIKU] as const;
export type ModeloComparado = (typeof MODELOS_COMPARADOS)[number];

/** Paciente de la ficha "Prueba Transcriptor" (sus transcripciones son los casos reales). */
export const PACIENTE_PRUEBA = 'ed21535c-ee1b-444b-9669-a3b1688fa1c2';
/** Tope de casos reales por corrida (costo: cada uno ≈ US$0,02–0,03 con Sonnet). */
export const MAX_CASOS_REALES = 4;
/** Tope de costo de una corrida (lo pidió Vale): se muestra en la página. */
export const TOPE_CORRIDA_USD = 0.3;

/**
 * Acción propia en la bitácora. La columna `transcriptor_auditoria.accion` es texto libre (0014:
 * largo 1..80), así que no requiere migración; el tipo AccionAuditoria de tipos.ts no se toca.
 * Las lecturas de contenido clínico usan las acciones de siempre (ver_transcripcion / ver_resumen).
 */
export const ACCION_COMPARAR = 'comparar_modelos' as AccionAuditoria;

/**
 * Costo estimado (conservador) de UN caso: Sonnet + Haiku. Entrada ≈ 1.700 tokens fijos del prompt +
 * 400 tokens por minuto de conversación; salida ≈ 1.000 tokens por resumen. Sirve para elegir cuántos
 * casos reales caben bajo el tope de la corrida (crearCorrida).
 */
export function estimarCostoCasoUsd(minutos: number): number {
  const entrada = 1_700 + 400 * Math.max(1, minutos || 0);
  const uso = (m: string) => costoUsd(m, { entrada, salida: 1_000, cacheEscritura: 0, cacheLectura: 0 });
  return uso(MODELO_SONNET) + uso(MODELO_HAIKU);
}

/** Elige, en orden, los casos reales que caben bajo el tope junto con los sintéticos. */
export function realesBajoTope<T extends { minutos: number }>(reales: T[], minutosSinteticos: number[], tope = TOPE_CORRIDA_USD): T[] {
  let total = minutosSinteticos.reduce((a, m) => a + estimarCostoCasoUsd(m), 0);
  const out: T[] = [];
  for (const r of reales) {
    if (out.length >= MAX_CASOS_REALES) break;
    const c = estimarCostoCasoUsd(r.minutos);
    if (total + c > tope) continue;
    total += c;
    out.push(r);
  }
  return out;
}

export function esModeloComparado(m: unknown): m is ModeloComparado {
  return m === MODELO_SONNET || m === MODELO_HAIKU;
}

export function nombreModelo(m: string): string {
  return m === MODELO_SONNET ? 'Sonnet 5.5' : m === MODELO_HAIKU ? 'Haiku 5.5' : m;
}

/** Configuración de la llamada para cada modelo de la prueba. */
export function configComparacion(modelo: string): ConfigUso {
  if (modelo === MODELO_SONNET) {
    // Igual a producción: Sonnet 5.5 rechaza 'disabled'; 'between_tools' lo apaga (esfuerzo ≤ high).
    return { ...CONFIG_RESUMEN, modelo: MODELO_SONNET, thinking: { type: 'between_tools' } };
  }
  if (modelo === MODELO_HAIKU) {
    // Haiku 5.5 acepta 'disabled' con esfuerzo ≤ high. Mismo esfuerzo y tope que Sonnet.
    return { modelo: MODELO_HAIKU, maxTokens: CONFIG_RESUMEN.maxTokens, thinking: { type: 'disabled' }, esfuerzo: CONFIG_RESUMEN.esfuerzo };
  }
  throw new Error(`Modelo fuera de la prueba: ${modelo}`);
}

// ─── Orden ciego ─────────────────────────────────────────────────────────────

/** Número al azar en [0, 1) con crypto (no Math.random). */
export function azarSeguro(): number {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0] / 2 ** 32;
}

/** Sortea qué modelo es "Resumen 1" y cuál "Resumen 2". */
export function sortearOrden(azar: () => number = azarSeguro): { modelo_1: ModeloComparado; modelo_2: ModeloComparado } {
  return azar() < 0.5
    ? { modelo_1: MODELO_SONNET, modelo_2: MODELO_HAIKU }
    : { modelo_1: MODELO_HAIKU, modelo_2: MODELO_SONNET };
}

// ─── Evaluación automática (sin IA) ──────────────────────────────────────────

export interface EvaluacionResumen {
  palabras: number;
  rango: [number, number];
  fueraDeRango: boolean;
  citas: { total: number; verificadas: number; noVerificadas: number; minutosCorregidos: number };
  /** Secciones fijas que el modelo NO escribió (el código las completa con "No consta"). */
  seccionesFaltantes: string[];
  /** Secciones que el modelo agregó por su cuenta (incluida una "Atención" aparte). */
  seccionesExtra: number;
  /** [mm:ss] del resumen que no calzan con ningún tramo (±90 s) o pasan del final. */
  minutosSinTramo: string[];
  /** Viñetas de Tareas/Próxima (y "Puntos" antiguo) sin minuto ni cita (no rastreables a la transcripción). */
  vinetasSinMinuto: number;
  /** Líneas en viñeta dentro del relato (debía ser prosa). */
  relatoEnVinetas: number;
  /** Términos sin sustento que están en el relato ("Resumen de la sesión"). */
  terminosRelato: string[];
  /** Nombres propios o números del resumen que no aparecen en la transcripción (posible invención). */
  terminosSinSustento: string[];
  riesgo: { consignado: boolean; esperado: boolean | null };
  /** Solo casos sintéticos: términos del tramo "no registrar" que sí aparecieron. */
  prohibidosEncontrados: string[] | null;
  /** Solo casos sintéticos: tareas esperadas que no aparecen en "Tareas". */
  tareasFaltantes: string[] | null;
  truncado: boolean;
}

const SECCIONES_OBLIGATORIAS: { clave: 'relato' | 'tareas' | 'proxima'; titulo: string }[] = [
  { clave: 'relato', titulo: SECCION_RELATO },
  { clave: 'tareas', titulo: 'Tareas' },
  { clave: 'proxima', titulo: 'Para trabajar en la próxima sesión' },
];

const UNIDADES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte',
  'veintiuno', 'veintidos', 'veintitres', 'veinticuatro', 'veinticinco', 'veintiseis', 'veintisiete', 'veintiocho', 'veintinueve'];
const DECENAS: Record<number, string> = { 3: 'treinta', 4: 'cuarenta', 5: 'cincuenta', 6: 'sesenta', 7: 'setenta', 8: 'ochenta', 9: 'noventa' };

/** 0–100 en palabras, sin tildes (como queda tras normalizarParaComparar). null fuera de rango. */
export function numeroEnPalabras(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 100) return null;
  if (n < 30) return UNIDADES[n];
  if (n === 100) return 'cien';
  const d = Math.floor(n / 10), u = n % 10;
  return u ? `${DECENAS[d]} y ${UNIDADES[u]}` : DECENAS[d];
}

/** Palabras que no cuentan como "nombre propio" (roles, rótulos y formato del resumen). */
const PALABRAS_DE_FORMATO = new Set([
  'terapeuta', 'paciente', 'miembro', 'hablante', 'ps', 'ia', 'nna', 'notas', 'tareas', 'puntos', 'no', 'consta',
  'dicho', 'por', 'se', 'en', 'de', 'la', 'el', 'los', 'las', 'del', 'mencion', 'verificacion', 'automatica',
  'sesion', 'pareja', 'proxima', 'para', 'trabajar', 'importantes', 'mas', 'pendiente', 'anterior', 'transcripcion',
  'ambos', 'ambas', 'segun', 'un', 'una', 'y', 'o', 'que', 'su', 'sus', 'al', 'lo', 'le', 'les', 'es', 'esta', 'este',
  'hablantes', 'inferido', 'inferida', 'cuenta', 'dice', 'refiere', 'menciona', 'indica', 'comenta', 'senala', 'relata',
  'resumen', 'menciones', 'temas', 'riesgo', 'como', 'tarea', 'expresa', 'aborda', 'explora', 'acuerda',
]);

function sinTildes(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Texto del resumen sin título, línea de datos, citas, minutos ni notas de verificación. */
function cuerpoEvaluable(md: string): string[] {
  return (md ?? '').split('\n')
    .filter((l) => !/^##\s/.test(l.trim()) && !/^\*[^*].*\*$/.test(l.trim()) && !/^_Verificaci[oó]n autom/.test(l.trim()))
    .map((l) => l.replace(RE_CITA, ' ').replace(/«[^»]*»/g, ' ').replace(/\[[^\]]*\]/g, ' '));
}

/**
 * Cuenta palabras como el FORMATO del prompt: si hay relato ("Resumen de la sesión"), solo el relato;
 * en el formato antiguo, todo menos títulos y bloques de mención de riesgo.
 */
export function contarPalabras(md: string): number {
  const relato = parsearResumen(md).secciones.filter((s) => claveSeccion(s.titulo) === 'relato').map((s) => s.cuerpo).join('\n');
  if (relato.trim()) return cuerpoEvaluable(relato).reduce((n, l) => n + (l.trim().replace(/^[-*•]\s+/, '').match(/[\p{L}\p{N}]+/gu) ?? []).length, 0);
  let enRiesgo = false;
  let n = 0;
  for (const l of cuerpoEvaluable(md)) {
    const t = l.trim();
    if (/^###\s/.test(t)) { enRiesgo = false; continue; }
    if (/^[-*•]\s+Se habl[oó] de .+Dicho por:/.test(t)) { enRiesgo = true; continue; }
    if (/^_Menci[oó]n consignada/.test(t)) { enRiesgo = false; continue; }
    if (enRiesgo && !/^[-*•]\s/.test(t)) continue;  // renglón con sangría de la mención
    enRiesgo = false;
    n += (t.replace(/^[-*•]\s+/, '').match(/[\p{L}\p{N}]+/gu) ?? []).length;
  }
  return n;
}

/** Términos (nombres propios a media frase y números) del resumen que no están en la transcripción. */
export function terminosSinSustento(md: string, tramos: TramoTranscrito[], conocidos: string[] = []): string[] {
  const corpus = ` ${normalizarParaComparar(tramos.map((t) => t.texto).join(' '))} `;
  const permitidos = new Set(conocidos.map((x) => normalizarParaComparar(x)).filter(Boolean));
  const fuera = new Set<string>();
  for (const linea of cuerpoEvaluable(md)) {
    const t = linea.trim();
    if (!t || /^###\s/.test(t)) continue;
    // Frases: después de viñeta, punto, dos puntos, raya o comienzo → la primera palabra puede ir en mayúscula.
    const frases = t.replace(/^[-*•]\s+/, '').replace(/\*\*|__|`/g, '').split(/(?<=[.!?:;—–])\s+|\s+[—–-]\s+|\(|\)/);
    for (const f of frases) {
      const palabras = f.trim().split(/\s+/).filter(Boolean);
      palabras.forEach((p, i) => {
        const limpia = p.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (!limpia) return;
        const norm = normalizarParaComparar(limpia);
        if (/^\d+([.,]\d+)?$/.test(limpia)) {
          const n = Number(limpia.replace(',', '.'));
          const enPalabras = numeroEnPalabras(n);
          if (corpus.includes(` ${norm} `) || (enPalabras && corpus.includes(` ${enPalabras} `))) return;
          fuera.add(limpia);
          return;
        }
        if (i === 0 || limpia.length < 3 || !/^\p{Lu}/u.test(limpia)) return;
        if (PALABRAS_DE_FORMATO.has(sinTildes(limpia.toLowerCase())) || permitidos.has(norm)) return;
        if (corpus.includes(` ${norm} `)) return;
        fuera.add(limpia);
      });
    }
  }
  return [...fuera].slice(0, 30);
}

/** Minutos [mm:ss] del resumen (fuera de las citas también) que no calzan con ningún tramo. */
export function minutosSinTramo(md: string, tramos: TramoTranscrito[], toleranciaSeg = 90): string[] {
  const finSeg = tramos.reduce((m, t) => Math.max(m, t.fin_ms / 1000), 0);
  const inicios = tramos.map((t) => t.inicio_ms / 1000);
  const malos = new Set<string>();
  for (const m of (md ?? '').matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g)) {
    const s = segundosDeMarca(m[1]);
    if (s == null) continue;
    const cerca = inicios.some((i) => Math.abs(i - s) <= toleranciaSeg);
    if (s > finSeg + 30 || !cerca) malos.add(m[1]);
  }
  return [...malos];
}

/** Viñetas de las secciones fijas sin [mm:ss] ni cita (excepto "No consta…" y avisos). */
export function vinetasSinMinuto(md: string): number {
  let n = 0;
  for (const s of parsearResumen(md).secciones) {
    const k = claveSeccion(s.titulo);
    if (k !== 'puntos' && k !== 'tareas' && k !== 'proxima') continue; // el relato no exige minuto por frase
    for (const l of s.cuerpo.split('\n')) {
      const t = l.trim();
      if (!/^[-*•]\s+/.test(t)) continue;
      if (/no consta/i.test(t) || /^[-*•]\s+De la pareja:?\s*$/i.test(t) || /:\s*$/.test(t)) continue;
      if (/\[\d{1,2}:\d{2}(?::\d{2})?\]/.test(t) || /«/.test(t)) continue;
      n++;
    }
  }
  return n;
}

export interface EntradaEvaluacion {
  /** Texto tal como lo devolvió el modelo (antes de normalizar y completar). */
  textoModelo: string;
  /** Resumen final (posprocesado, con citas verificadas). */
  contenido: string;
  verificacion: { total: number; verificadas: number; minutosCorregidos: number; eliminadas: number };
  tramos: TramoTranscrito[];
  truncado: boolean;
  /** Nombres que sí están permitidos aunque no estén en la transcripción (participantes). */
  conocidos?: string[];
  esperado?: EsperadoCaso | null;
  corta?: boolean;
  /** Duración de la sesión en minutos (si falta, se toma del último tramo). */
  minutos?: number | null;
}

/** Largo pedido para el relato: 5–9 palabras por minuto (50 min: 250–450); corta: 60–120. */
export function rangoRelato(minutos: number, corta: boolean): [number, number] {
  if (corta) return [60, 120];
  const m = Math.max(1, minutos || 0);
  return [Math.max(60, Math.round(5 * m)), Math.max(120, Math.round(9 * m))];
}

/** Líneas en viñeta dentro del relato. */
export function relatoEnVinetas(md: string): number {
  return parsearResumen(md).secciones.filter((s) => claveSeccion(s.titulo) === 'relato')
    .flatMap((s) => s.cuerpo.split('\n')).filter((l) => /^\s*[-*•]\s+/.test(l)).length;
}

export function evaluarResumen(e: EntradaEvaluacion): EvaluacionResumen {
  const crudo = parsearResumen(normalizarSalida(e.textoModelo, ''));
  const claves = crudo.secciones.map((s) => claveSeccion(s.titulo));
  const faltantes = SECCIONES_OBLIGATORIAS.filter((s) => !claves.includes(s.clave)).map((s) => s.titulo);
  const extra = claves.filter((k) => k === null || k === 'atencion' || k === 'puntos').length;
  const corta = e.corta ?? e.esperado?.corta ?? false;
  const minutos = e.minutos || e.tramos.reduce((m, t) => Math.max(m, t.fin_ms), 0) / 60_000;
  const rango = rangoRelato(minutos, corta);
  const palabras = contarPalabras(e.contenido);
  const final = parsearResumen(e.contenido);
  const textoNorm = ` ${normalizarParaComparar(e.contenido)} `;
  const tareas = ` ${normalizarParaComparar(final.secciones.filter((s) => claveSeccion(s.titulo) === 'tareas').map((s) => s.cuerpo).join(' '))} `;
  return {
    palabras,
    rango,
    // Margen de 15 % sobre el rango del prompt antes de marcarlo.
    fueraDeRango: palabras < rango[0] * 0.85 || palabras > rango[1] * 1.15,
    citas: {
      total: e.verificacion.total,
      verificadas: e.verificacion.verificadas,
      noVerificadas: e.verificacion.eliminadas,
      minutosCorregidos: e.verificacion.minutosCorregidos,
    },
    seccionesFaltantes: faltantes,
    seccionesExtra: extra,
    minutosSinTramo: minutosSinTramo(e.contenido, e.tramos),
    vinetasSinMinuto: vinetasSinMinuto(e.contenido),
    relatoEnVinetas: relatoEnVinetas(e.contenido),
    terminosSinSustento: terminosSinSustento(e.contenido, e.tramos, e.conocidos ?? []),
    terminosRelato: terminosSinSustento(
      final.secciones.filter((s) => claveSeccion(s.titulo) === 'relato').map((s) => `### ${s.titulo}\n${s.cuerpo}`).join('\n'),
      e.tramos, e.conocidos ?? []),
    riesgo: { consignado: final.tieneMencionRiesgo, esperado: e.esperado ? e.esperado.riesgo : null },
    prohibidosEncontrados: e.esperado
      ? e.esperado.terminosProhibidos.filter((t) => textoNorm.includes(` ${normalizarParaComparar(t)}`))
      : null,
    tareasFaltantes: e.esperado
      ? e.esperado.tareas.filter((t) => !tareas.includes(normalizarParaComparar(t)))
      : null,
    truncado: e.truncado,
  };
}

/**
 * Versión para guardar de un caso REAL: sin ningún texto del resumen (solo conteos). Los términos sin
 * sustento podrían ser nombres o datos de la sesión, así que se guarda cuántos son, no cuáles.
 */
export function evaluacionSinTexto(ev: EvaluacionResumen): EvaluacionResumen & { terminosSinSustentoN: number; terminosRelatoN: number } {
  return { ...ev, terminosSinSustento: [], terminosSinSustentoN: ev.terminosSinSustento.length, terminosRelato: [], terminosRelatoN: (ev.terminosRelato ?? []).length };
}

/** Problemas legibles (para la página), sin decir el modelo. */
export function problemasDe(ev: EvaluacionResumen & { terminosSinSustentoN?: number; terminosRelatoN?: number }): { texto: string; grave: boolean }[] {
  const out: { texto: string; grave: boolean }[] = [];
  const nTerm = ev.terminosSinSustentoN ?? ev.terminosSinSustento.length;
  // Evaluaciones guardadas antes del relato (17 oct) no traen estos campos.
  const nRelato = ev.terminosRelatoN ?? (ev.terminosRelato ?? []).length;
  if (ev.truncado) out.push({ texto: 'Se cortó por largo máximo.', grave: true });
  if (ev.prohibidosEncontrados?.length) out.push({ texto: `Incluyó lo del tramo que se pidió no registrar (${ev.prohibidosEncontrados.join(', ')}).`, grave: true });
  if (ev.riesgo.esperado === true && !ev.riesgo.consignado) out.push({ texto: 'No consignó la mención de riesgo que había.', grave: true });
  if (ev.riesgo.esperado === false && ev.riesgo.consignado) out.push({ texto: 'Consignó una mención de riesgo que no se esperaba.', grave: false });
  if (ev.citas.noVerificadas) out.push({ texto: `${ev.citas.noVerificadas} ${ev.citas.noVerificadas === 1 ? 'cita no coincidía' : 'citas no coincidían'} con la transcripción (se quitaron).`, grave: true });
  if (ev.seccionesFaltantes.length) out.push({ texto: `No escribió: ${ev.seccionesFaltantes.join(', ')} (el sistema la completó con "No consta").`, grave: false });
  if (ev.seccionesExtra) out.push({ texto: `Agregó ${ev.seccionesExtra} ${ev.seccionesExtra === 1 ? 'sección' : 'secciones'} fuera de la estructura.`, grave: false });
  if (ev.minutosSinTramo.length) out.push({ texto: `Minutos que no calzan con la transcripción: ${ev.minutosSinTramo.join(', ')}.`, grave: false });
  if (nTerm) out.push({ texto: `${ev.terminosSinSustento.length ? `Términos que no aparecen en la transcripción: ${ev.terminosSinSustento.join(', ')}.` : `${nTerm} ${nTerm === 1 ? 'término' : 'términos'} (nombres o números) que no aparecen en la transcripción.`}${nRelato ? ` ${nRelato === nTerm ? (nTerm === 1 ? 'Está' : 'Todos están') : `${nRelato} de ellos están`} en el relato.` : ''}`, grave: false });
  if (ev.tareasFaltantes?.length) out.push({ texto: `Faltó en Tareas: ${ev.tareasFaltantes.join(', ')}.`, grave: false });
  if (ev.relatoEnVinetas) out.push({ texto: `El relato tiene ${ev.relatoEnVinetas} ${ev.relatoEnVinetas === 1 ? 'línea' : 'líneas'} en viñeta (debía ser prosa).`, grave: false });
  if (ev.vinetasSinMinuto) out.push({ texto: `${ev.vinetasSinMinuto} ${ev.vinetasSinMinuto === 1 ? 'viñeta' : 'viñetas'} sin minuto ni cita.`, grave: false });
  if (ev.fueraDeRango) out.push({ texto: `Largo del relato: ${ev.palabras} palabras (lo pedido: ${ev.rango[0]}–${ev.rango[1]}).`, grave: false });
  return out;
}

// ─── Generación (la única parte con red; cliente inyectable) ─────────────────

export interface EntradaPar {
  plantilla: Plantilla;
  instrucciones: string;
  transcripcion: TramoTranscrito[];
  sesion: MetaSesion;
}

export interface ResumenGenerado {
  modelo: ModeloComparado;
  contenido: string;
  textoModelo: string;
  verificacion: { total: number; verificadas: number; minutosCorregidos: number; eliminadas: number };
  uso: UsoTokens;
  costoUsd: number;
  truncado: boolean;
  ms: number;
}

export type ResultadoPar =
  | { ok: true; r: ResumenGenerado }
  | { ok: false; modelo: ModeloComparado; codigo: string };

/** Prompt único para los dos modelos (mismo system, mismas instrucciones, misma transcripción). */
export function promptComparacion(e: EntradaPar): PromptArmado {
  return armarPromptResumen({ plantilla: e.plantilla, instrucciones: e.instrucciones, transcripcion: e.transcripcion, sesion: e.sesion, contextoPrevio: null });
}

/** Genera los dos resúmenes en paralelo. Nunca lanza: cada lado vuelve ok o con su código de error. */
export async function generarPar(
  e: EntradaPar,
  modelos: readonly [ModeloComparado, ModeloComparado],
  op: Partial<OpcionesReintento> & { cliente?: ClienteMensajes } = {},
): Promise<[ResultadoPar, ResultadoPar]> {
  const prompt = promptComparacion(e);
  const uno = async (modelo: ModeloComparado): Promise<ResultadoPar> => {
    const t0 = Date.now();
    try {
      const r = await llamarClaude({ uso: configComparacion(modelo), system: prompt.system, messages: prompt.messages }, op);
      const post = posprocesarResumen(r.texto, { plantilla: e.plantilla, sesion: e.sesion, transcripcion: e.transcripcion, truncado: r.truncado });
      return { ok: true, r: { modelo, contenido: post.contenido, textoModelo: r.texto, verificacion: post.verificacion, uso: r.uso, costoUsd: r.costoUsd, truncado: r.truncado, ms: Date.now() - t0 } };
    } catch (err) {
      const codigo = (err as { codigo?: unknown })?.codigo;
      return { ok: false, modelo, codigo: typeof codigo === 'string' ? codigo : 'desconocido' };
    }
  };
  const [a, b] = await Promise.all([uno(modelos[0]), uno(modelos[1])]);
  return [a, b];
}

/** Lo que se guarda en detalle_1 / detalle_2 (jsonb). Sin texto clínico. */
export interface DetalleResumen {
  modelo: string;
  promptVersion: string;
  uso: UsoTokens;
  costoUsd: number;
  ms: number;
  evaluacion: EvaluacionResumen & { terminosSinSustentoN?: number };
}

export function detalleDe(r: ResumenGenerado, ev: EvaluacionResumen, real: boolean): DetalleResumen {
  return {
    modelo: r.modelo,
    promptVersion: PROMPT_VERSION_RESUMEN,
    uso: r.uso,
    costoUsd: r.costoUsd,
    ms: r.ms,
    evaluacion: real ? evaluacionSinTexto(ev) : ev,
  };
}

// ─── Revelado ────────────────────────────────────────────────────────────────

export type Preferencia = '1' | '2' | 'iguales';
export const esPreferencia = (x: unknown): x is Preferencia => x === '1' || x === '2' || x === 'iguales';

export interface CasoParaRevelar {
  id: string;
  estado: 'pendiente' | 'generando' | 'listo' | 'error';
  modelo_1: string;
  modelo_2: string;
  preferencia: Preferencia | null;
  costo_usd_1: number | null;
  costo_usd_2: number | null;
  detalle_1: Pick<DetalleResumen, 'uso'> | null;
  detalle_2: Pick<DetalleResumen, 'uso'> | null;
}

/** Se revela cuando no queda nada generándose y TODOS los casos listos tienen voto (al menos uno). */
export function puedeRevelar(casos: Pick<CasoParaRevelar, 'estado' | 'preferencia'>[]): boolean {
  if (!casos.length) return false;
  if (casos.some((c) => c.estado === 'pendiente' || c.estado === 'generando')) return false;
  const listos = casos.filter((c) => c.estado === 'listo');
  return listos.length > 0 && listos.every((c) => c.preferencia !== null);
}

export interface TotalModelo { modelo: string; nombre: string; preferido: number; costoUsd: number; entrada: number; salida: number }
export interface Revelado {
  porCaso: { id: string; modelo1: string; modelo2: string; preferido: string | 'iguales' }[];
  totales: TotalModelo[];
  iguales: number;
}

const tokensEntrada = (u: UsoTokens | undefined) => (u ? u.entrada + u.cacheEscritura + u.cacheLectura : 0);

export function revelar(casos: CasoParaRevelar[]): Revelado | null {
  if (!puedeRevelar(casos)) return null;
  const totales = new Map<string, TotalModelo>(MODELOS_COMPARADOS.map((m) => [m, { modelo: m, nombre: nombreModelo(m), preferido: 0, costoUsd: 0, entrada: 0, salida: 0 }]));
  const sumar = (m: string, costo: number | null, d: Pick<DetalleResumen, 'uso'> | null) => {
    const t = totales.get(m) ?? { modelo: m, nombre: nombreModelo(m), preferido: 0, costoUsd: 0, entrada: 0, salida: 0 };
    t.costoUsd += Number(costo) || 0;
    t.entrada += tokensEntrada(d?.uso);
    t.salida += d?.uso?.salida ?? 0;
    totales.set(m, t);
    return t;
  };
  let iguales = 0;
  const porCaso: Revelado['porCaso'] = [];
  for (const c of casos.filter((x) => x.estado === 'listo')) {
    const t1 = sumar(c.modelo_1, c.costo_usd_1, c.detalle_1);
    const t2 = sumar(c.modelo_2, c.costo_usd_2, c.detalle_2);
    let preferido: string = 'iguales';
    if (c.preferencia === '1') { t1.preferido++; preferido = c.modelo_1; }
    else if (c.preferencia === '2') { t2.preferido++; preferido = c.modelo_2; }
    else iguales++;
    porCaso.push({ id: c.id, modelo1: c.modelo_1, modelo2: c.modelo_2, preferido });
  }
  for (const t of totales.values()) t.costoUsd = Math.round(t.costoUsd * 100_000) / 100_000;
  return { porCaso, totales: [...totales.values()], iguales };
}

/** Costo total de la corrida (los dos modelos, todos los casos generados). */
export function costoCorrida(casos: Pick<CasoParaRevelar, 'costo_usd_1' | 'costo_usd_2'>[]): number {
  const usd = casos.reduce((a, c) => a + (Number(c.costo_usd_1) || 0) + (Number(c.costo_usd_2) || 0), 0);
  return Math.round(usd * 100_000) / 100_000;
}
