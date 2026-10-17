// Transcriptor IA — une los segmentos transcritos y asigna hablantes (paquete P2). Funciones puras.
//
// Entrada: la grabación (origen, tipo, línea de hablantes del bot, mapa de nombres, pausas) y los
// resultados de AssemblyAI de cada segmento con su desfase (offset_ms). AssemblyAI entrega `words[]` con
// start/end en MILISEGUNDOS relativos al inicio de ESE archivo y, con speaker_labels, `speaker` = letra
// mayúscula secuencial (A, B, C…) POR TRANSCRIPT (https://www.assemblyai.com/docs/api-reference/transcripts/submit).
// Salida: tramos [{inicio_ms, fin_ms, hablante, texto}] en el reloj de la sesión (0 = inicio del segmento 0).
//
// ── Formato de la línea de hablantes del bot (online) — contrato con P5 (bot-evento `fin`) ──────────────
// `linea_hablantes: LineaHablante[]` (tipos.ts) = eventos { t_ms, nombre, on }:
//   · t_ms: entero ≥ 0, ms desde el MISMO origen que offset_ms de los segmentos (inicio del segmento seq 0,
//     es decir, cuando el bot empezó a grabar tras ser admitido).
//   · nombre: nombre visible del tile en Meet (tal cual; se recorta a 80 caracteres). El de la propia Vale
//     también viene; el del bot (BOT_NOMBRE) se ignora.
//   · on: true cuando el tile se ilumina (empieza a hablar), false cuando se apaga.
//   · Orden cualquiera (se ordena por t_ms). Un `on` sin `off` se cierra al final de la grabación; `on`
//     repetidos del mismo nombre se funden; un `off` sin `on` previo se ignora.
// Usar `validarLineaHablantes(x)` en bot-evento para aceptar solo este formato.
//
// ── Claves de hablante (mapa_hablantes, lo renombra Vale en P7) ──────────────────────────────────────
//   · Presencial con diarización: AssemblyAI etiqueta por transcript, así que la "A" del segmento 1 no es
//     necesariamente la "A" del segmento 2 (tras una pausa). Clave = `claveHablante(indice, letra)`:
//     'A' en el primer segmento, '2-A' en el segundo, '3-A'… Nombre por defecto 'Hablante A',
//     'Hablante A (parte 2)'.
//   · Online: clave = nombre de Meet (mapa_hablantes puede renombrarlo). Pareja online con un recuadro
//     compartido: clave = "Recuadro · Hablante A" (separarRecuadroCompartido; se renombra igual).
//   · Sin diarización ni línea: HABLANTE_SIN_SEPARAR. Online sin intervalo claro: HABLANTE_NO_IDENTIFICADO.
import {
  BOT_NOMBRE,
  type Grabacion, type LineaHablante, type ModeloTranscripcion, type PalabraAAI, type ResultadoTranscripcion,
  type TramoTranscrito, type TranscripcionClara, type UnirTranscripcion,
} from './tipos';

export const HABLANTE_NO_IDENTIFICADO = 'Hablante no identificado';
export const HABLANTE_SIN_SEPARAR = 'Sesión (sin separar hablantes)';

/** Parámetros de la unión (ms). */
export const AJUSTE_HABLANTES = {
  /** El tile de Meet se ilumina con algo de retraso respecto del audio: margen al buscar intervalo. */
  toleranciaTileMs: 600,
  /** Silencio que corta un tramo aunque siga el mismo hablante. */
  cortePorSilencioMs: 4_000,
  /** Largo máximo de un tramo (para que los [mm:ss] sirvan de referencia). */
  maxTramoMs: 60_000,
  /** Palabras iguales a menos de esto en el solapamiento se consideran la misma (online, 3 s). */
  duplicadoMs: 700,
  /** Una palabra ambigua hereda el hablante vecino solo si está a menos de esto. */
  continuidadMs: 1_500,
} as const;

// ─── Utilidades públicas ─────────────────────────────────────────────────────

/** ms → 'mm:ss' (o 'h:mm:ss' desde 1 hora). */
export function formatearTiempo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const dos = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${dos(m)}:${dos(ss)}` : `${dos(m)}:${dos(ss)}`;
}

/** Texto legible: "[mm:ss] Hablante: texto" por línea (para la vista y para el prompt de P3). */
export function tramosATexto(tramos: TramoTranscrito[]): string {
  return tramos.map((t) => `[${formatearTiempo(t.inicio_ms)}] ${t.hablante}: ${t.texto}`).join('\n');
}

export function claveHablante(indiceSegmento: number, etiqueta: string): string {
  return indiceSegmento === 0 ? etiqueta : `${indiceSegmento + 1}-${etiqueta}`;
}

function nombrePorDefecto(clave: string): string {
  const m = /^(\d+)-(.+)$/.exec(clave);
  return m ? `Hablante ${m[2]} (parte ${m[1]})` : `Hablante ${clave}`;
}

/** Valida/normaliza lo que manda el bot. Lanza con un mensaje en español si no calza el formato. */
export function validarLineaHablantes(x: unknown): LineaHablante[] {
  if (!Array.isArray(x)) throw new Error('linea_hablantes debe ser una lista');
  if (x.length > 50_000) throw new Error('linea_hablantes demasiado larga');
  return x.map((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(o.t_ms) || (o.t_ms as number) < 0) throw new Error(`linea_hablantes[${i}].t_ms inválido`);
    if (typeof o.nombre !== 'string' || !o.nombre.trim()) throw new Error(`linea_hablantes[${i}].nombre vacío`);
    if (typeof o.on !== 'boolean') throw new Error(`linea_hablantes[${i}].on debe ser booleano`);
    return { t_ms: o.t_ms as number, nombre: o.nombre.trim().slice(0, 80), on: o.on };
  });
}

// ─── Intervalos de la línea de hablantes ─────────────────────────────────────

export interface Intervalo { nombre: string; desde: number; hasta: number }

export function intervalosDesdeLinea(linea: LineaHablante[] | null | undefined, finMs = Number.POSITIVE_INFINITY): Intervalo[] {
  if (!linea?.length) return [];
  const orden = [...linea]
    .map((e, i) => ({ ...e, nombre: e.nombre.trim().slice(0, 80), i }))
    .filter((e) => e.nombre && e.nombre !== BOT_NOMBRE)
    .sort((a, b) => a.t_ms - b.t_ms || (a.on === b.on ? a.i - b.i : a.on ? 1 : -1)); // off antes que on en el mismo ms
  const abiertos = new Map<string, number>();
  const out: Intervalo[] = [];
  for (const e of orden) {
    if (e.on) { if (!abiertos.has(e.nombre)) abiertos.set(e.nombre, e.t_ms); }
    else {
      const d = abiertos.get(e.nombre);
      if (d !== undefined) { out.push({ nombre: e.nombre, desde: d, hasta: Math.max(d, e.t_ms) }); abiertos.delete(e.nombre); }
    }
  }
  for (const [nombre, d] of abiertos) out.push({ nombre, desde: d, hasta: Math.max(d, finMs) });
  return out.sort((a, b) => a.desde - b.desde);
}

const solape = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Candidatos para una palabra [ini, fin]: quienes tenían el tile iluminado. Si nadie, se amplía con la
 * tolerancia (retraso del tile) y se toma el más cercano.
 */
function candidatos(ini: number, fin: number, iv: Intervalo[], tol: number): string[] {
  const largo = Math.max(1, fin - ini);
  const directos = new Map<string, number>();
  for (const x of iv) {
    const s = solape(ini, ini + largo, x.desde, x.hasta);
    if (s > 0) directos.set(x.nombre, Math.max(directos.get(x.nombre) ?? 0, s));
  }
  if (directos.size) return [...directos.keys()];
  let mejor: string | null = null, dist = Number.POSITIVE_INFINITY;
  for (const x of iv) {
    const d = x.hasta < ini ? ini - x.hasta : x.desde > fin ? x.desde - fin : 0;
    if (d <= tol && d < dist) { dist = d; mejor = x.nombre; }
  }
  return mejor ? [mejor] : [];
}

// ─── Unión de segmentos ──────────────────────────────────────────────────────

interface PalabraAbs { text: string; start: number; end: number; clave: string | null; seg: number }

const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

/** Duración del segmento en ms (audio_duration en segundos, o la última palabra). */
function duracionSegmento(r: ResultadoTranscripcion): number {
  const ultima = r.words?.length ? r.words[r.words.length - 1].end : 0;
  const ultU = r.utterances?.length ? r.utterances[r.utterances.length - 1].end : 0;
  return Math.max(typeof r.audio_duration === 'number' ? r.audio_duration * 1000 : 0, ultima, ultU);
}

/** Palabras del segmento; si AssemblyAI no trajo words pero sí utterances, se usan como "palabras" largas. */
function palabrasDe(r: ResultadoTranscripcion): PalabraAAI[] {
  if (r.words?.length) return r.words;
  return (r.utterances ?? []).map((u) => ({ text: u.text, start: u.start, end: u.end, speaker: u.speaker || null }));
}

/**
 * Desfase efectivo de cada segmento.
 *  - Online: se confía en offset_ms del bot (los segmentos se solapan 3 s a propósito).
 *  - Presencial: no hay solapamiento. Si offset_ms no avanza (p. ej. 0 en todos), se usa el fin de una
 *    pausa registrada posterior al segmento anterior; si no hay, el fin del segmento anterior (contiguo).
 */
function desfases(
  origen: 'presencial' | 'online',
  segs: { offset_ms: number; resultado: ResultadoTranscripcion }[],
  pausas: { desde_ms: number; hasta_ms: number }[],
): number[] {
  const out: number[] = [];
  let finPrevio = 0;
  const ps = [...(pausas ?? [])].filter((p) => Number.isFinite(p.desde_ms) && Number.isFinite(p.hasta_ms)).sort((a, b) => a.desde_ms - b.desde_ms);
  segs.forEach((s, i) => {
    let off = Number.isFinite(s.offset_ms) && s.offset_ms >= 0 ? s.offset_ms : 0;
    if (origen === 'presencial' && i > 0 && off < finPrevio) {
      const pausa = ps.find((p) => p.hasta_ms >= finPrevio && p.desde_ms >= finPrevio - 1_000);
      off = pausa ? pausa.hasta_ms : finPrevio;
    }
    out.push(off);
    finPrevio = Math.max(finPrevio, off + duracionSegmento(s.resultado));
  });
  return out;
}

/** Une las palabras de todos los segmentos en el reloj de la sesión, sin duplicar el solapamiento. */
export function unirPalabras(
  origen: 'presencial' | 'online',
  segmentos: { offset_ms: number; resultado: ResultadoTranscripcion }[],
  pausas: { desde_ms: number; hasta_ms: number }[] = [],
): PalabraAbs[] {
  const segs = segmentos.map((s, i) => ({ ...s, i })).sort((a, b) => a.offset_ms - b.offset_ms || a.i - b.i);
  const offs = desfases(origen, segs, pausas);
  let out: PalabraAbs[] = [];
  segs.forEach((s, k) => {
    const off = offs[k];
    const nuevas: PalabraAbs[] = palabrasDe(s.resultado)
      .map((w) => ({ text: w.text, start: off + w.start, end: off + w.end, clave: w.speaker ? claveHablante(k, w.speaker) : null, seg: k }))
      .filter((w) => w.text.trim().length > 0);
    if (!out.length || !nuevas.length) { out = out.concat(nuevas); return; }
    const finPrevio = out[out.length - 1].end;
    if (off >= finPrevio) { out = out.concat(nuevas); return; }
    // Solapamiento [off, finPrevio]: se corta en el punto medio; lo anterior lo aporta el segmento previo
    // y lo posterior el nuevo. Además se descarta una palabra nueva que repite (mismo texto, ±700 ms) a
    // una que ya quedó.
    const corte = (off + finPrevio) / 2;
    const previas = out.filter((w) => w.start < corte);
    const posteriores = nuevas.filter((w) => w.start >= corte);
    const cola = previas.filter((w) => w.start >= off - AJUSTE_HABLANTES.duplicadoMs);
    const sinDuplicar = posteriores.filter((w) =>
      !cola.some((p) => norm(p.text) === norm(w.text) && Math.abs(p.start - w.start) <= AJUSTE_HABLANTES.duplicadoMs));
    out = previas.concat(sinDuplicar);
  });
  return out.sort((a, b) => a.start - b.start);
}

// ─── Asignación de hablantes ─────────────────────────────────────────────────

function asignarOnline(palabras: PalabraAbs[], iv: Intervalo[]): string[] {
  const tol = AJUSTE_HABLANTES.toleranciaTileMs;
  const cands = palabras.map((w) => candidatos(w.start, w.end, iv, tol));
  const res: (string | null)[] = cands.map((c) => (c.length === 1 ? c[0] : null));
  // Ambiguas (dos tiles a la vez): continuidad con la palabra anterior; si no, con la siguiente; si no,
  // queda no identificado. Sin candidato: no identificado.
  for (let i = 0; i < res.length; i++) {
    if (res[i] !== null || cands[i].length < 2) continue;
    const cerca = (k: number) => Math.abs(palabras[k].start - palabras[i].start) <= AJUSTE_HABLANTES.continuidadMs
      || Math.abs(palabras[i].start - palabras[k].end) <= AJUSTE_HABLANTES.continuidadMs;
    const prev = i > 0 && cerca(i - 1) ? res[i - 1] : null;
    if (prev && prev !== HABLANTE_NO_IDENTIFICADO && cands[i].includes(prev)) { res[i] = prev; continue; }
    let j = i + 1;
    while (j < res.length && cands[j].length >= 2 && res[j] === null) j++;
    const sig = j < res.length && cands[j].length === 1 && cerca(j) ? cands[j][0] : null;
    if (sig && cands[i].includes(sig)) res[i] = sig;
  }
  return res.map((r) => r ?? HABLANTE_NO_IDENTIFICADO);
}

/** Parámetros para decidir que un recuadro de Meet lo comparten 2+ personas (pareja online). */
export const AJUSTE_RECUADRO = {
  /** Cada voz debe tener al menos esta fracción de las palabras del recuadro… */
  fraccionMinima: 0.15,
  /** …y al menos estas palabras (evita separar por un error puntual de la diarización). */
  palabrasMinimas: 8,
  /** Una palabra sin recuadro hereda el de su voz si esa voz está ≥ esta fracción en un recuadro. */
  dominio: 0.8,
} as const;

/** Etiqueta de una voz dentro de un recuadro compartido: "Javiera y Diego · Hablante A (parte 2)". */
export function etiquetaRecuadroCompartido(recuadro: string, clave: string): string {
  return `${recuadro} · ${nombrePorDefecto(clave)}`;
}

/**
 * Pareja online (17 oct 2026): los dos suelen estar frente al mismo computador → un solo recuadro en Meet.
 * La línea del bot dice "habla ese recuadro" pero no quién de los dos; la diarización de AssemblyAI sí
 * separa voces (A/B/C, por segmento). Regla: el recuadro de Vale (una sola voz) queda con su nombre; un
 * recuadro con 2+ voces significativas se separa en "Recuadro · Hablante A/B". Las palabras sin recuadro
 * claro heredan el de su voz cuando esa voz está casi siempre (≥ 80 %) en un mismo recuadro.
 * Función pura; recibe nombres de recuadro (antes de aplicar mapa_hablantes) y devuelve etiquetas.
 */
export function separarRecuadroCompartido(
  palabras: { clave: string | null }[],
  porRecuadro: string[],
): string[] {
  const conteo = new Map<string, Map<string, number>>(); // recuadro → voz → palabras
  const vozEn = new Map<string, Map<string, number>>();  // voz → recuadro → palabras
  palabras.forEach((w, i) => {
    const r = porRecuadro[i];
    if (!w.clave || r === HABLANTE_NO_IDENTIFICADO) return;
    const m = conteo.get(r) ?? new Map<string, number>(); m.set(w.clave, (m.get(w.clave) ?? 0) + 1); conteo.set(r, m);
    const v = vozEn.get(w.clave) ?? new Map<string, number>(); v.set(r, (v.get(r) ?? 0) + 1); vozEn.set(w.clave, v);
  });
  const compartidos = new Map<string, Set<string>>(); // recuadro → voces significativas
  for (const [r, m] of conteo) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const voces = [...m].filter(([, n]) => n >= AJUSTE_RECUADRO.palabrasMinimas && n / total >= AJUSTE_RECUADRO.fraccionMinima).map(([c]) => c);
    if (voces.length >= 2) compartidos.set(r, new Set(voces));
  }
  const recuadroDeVoz = (c: string): string | null => {
    const v = vozEn.get(c);
    if (!v) return null;
    const total = [...v.values()].reduce((a, b) => a + b, 0);
    const [mejor, n] = [...v].sort((a, b) => b[1] - a[1])[0];
    return n / total >= AJUSTE_RECUADRO.dominio ? mejor : null;
  };
  return palabras.map((w, i) => {
    let r = porRecuadro[i];
    if (r === HABLANTE_NO_IDENTIFICADO && w.clave) r = recuadroDeVoz(w.clave) ?? r;
    const voces = compartidos.get(r);
    return voces && w.clave && voces.has(w.clave) ? etiquetaRecuadroCompartido(r, w.clave) : r;
  });
}

function nombreFinal(clave: string, mapa: Record<string, string> | null | undefined, porDefecto: (c: string) => string): string {
  const m = mapa?.[clave];
  return typeof m === 'string' && m.trim() ? m.trim().slice(0, 80) : porDefecto(clave);
}

/** Agrupa palabras consecutivas del mismo hablante en tramos (cortando por silencio largo o largo máximo). */
function agrupar(palabras: PalabraAbs[], hablantes: string[]): TramoTranscrito[] {
  const out: TramoTranscrito[] = [];
  let actual: { inicio_ms: number; fin_ms: number; hablante: string; textos: string[] } | null = null;
  palabras.forEach((w, i) => {
    const h = hablantes[i];
    const cortar = !actual || actual.hablante !== h
      || w.start - actual.fin_ms > AJUSTE_HABLANTES.cortePorSilencioMs
      || (w.start - actual.inicio_ms > AJUSTE_HABLANTES.maxTramoMs && /[.?!…]$/.test(actual.textos[actual.textos.length - 1]))
      || w.start - actual.inicio_ms > AJUSTE_HABLANTES.maxTramoMs * 2;
    if (cortar) {
      if (actual) out.push({ inicio_ms: actual.inicio_ms, fin_ms: actual.fin_ms, hablante: actual.hablante, texto: actual.textos.join(' ') });
      actual = { inicio_ms: w.start, fin_ms: w.end, hablante: h, textos: [w.text.trim()] };
    } else {
      actual!.textos.push(w.text.trim());
      actual!.fin_ms = Math.max(actual!.fin_ms, w.end);
    }
  });
  if (actual) {
    const a = actual as { inicio_ms: number; fin_ms: number; hablante: string; textos: string[] };
    out.push({ inicio_ms: a.inicio_ms, fin_ms: a.fin_ms, hablante: a.hablante, texto: a.textos.join(' ') });
  }
  return out;
}

// ─── Huecos de la grabación (81-revision-etica-clinica H13) ───────────────────
// En presencial, cada pausa o interrupción (llamada, pantalla bloqueada, micrófono tomado) cierra el
// segmento y la continuación abre otro. Las pausas voluntarias ya quedan en grabaciones.pausas y se
// muestran como "Grabación pausada a pedido"; las interrupciones no. Para que nadie (ni el resumen)
// lea como continuo algo que no lo fue, cada hueco entre segmentos que NO coincide con una pausa
// registrada se marca en la transcripción con un tramo sin hablante:
//   "[pausa / interrupción mm:ss–mm:ss]"

/** Hueco mínimo entre segmentos para marcarlo (evita marcar el corte técnico entre archivos). */
export const HUECO_MINIMO_MS = 5_000;
/** Prefijo de los tramos-marca (sin hablante). */
export const PREFIJO_HUECO = '[pausa / interrupción';

export function textoHueco(desdeMs: number, hastaMs: number): string {
  return `${PREFIJO_HUECO} ${formatearTiempo(desdeMs)}–${formatearTiempo(hastaMs)}]`;
}

export function esTramoHueco(t: Pick<TramoTranscrito, 'hablante' | 'texto'>): boolean {
  return !t.hablante && t.texto.startsWith(PREFIJO_HUECO);
}

/** Huecos entre segmentos presenciales que no son una pausa registrada (función pura). */
export function huecosSinPausa(
  origen: 'presencial' | 'online',
  segmentos: { offset_ms: number; resultado: ResultadoTranscripcion }[],
  pausas: { desde_ms: number; hasta_ms: number }[] = [],
): { desde_ms: number; hasta_ms: number }[] {
  if (origen !== 'presencial' || segmentos.length < 2) return [];
  const segs = segmentos.map((s, i) => ({ ...s, i })).sort((a, b) => a.offset_ms - b.offset_ms || a.i - b.i);
  const offs = desfases(origen, segs, pausas);
  const ps = (pausas ?? []).filter((p) => Number.isFinite(p.desde_ms) && Number.isFinite(p.hasta_ms));
  const out: { desde_ms: number; hasta_ms: number }[] = [];
  for (let k = 1; k < segs.length; k++) {
    const desde = offs[k - 1] + duracionSegmento(segs[k - 1].resultado);
    const hasta = offs[k];
    if (hasta - desde < HUECO_MINIMO_MS) continue;
    const esPausa = ps.some((p) => p.desde_ms <= hasta && p.hasta_ms >= desde);
    if (!esPausa) out.push({ desde_ms: Math.round(desde), hasta_ms: Math.round(hasta) });
  }
  return out;
}

/** Implementación de UnirTranscripcion (contrato de tipos.ts). */
export const unirTranscripcion: UnirTranscripcion = ({ grabacion, segmentos }) => {
  const ok = segmentos.filter((s) => s.resultado.status === 'completed');
  if (ok.length !== segmentos.length) throw new Error('unirTranscripcion: hay segmentos sin transcripción completa');
  const palabras = unirPalabras(grabacion.origen, ok, grabacion.pausas ?? []);
  if (!palabras.length) return [];
  const mapa = grabacion.mapa_hablantes;

  let hablantes: string[];
  const linea = grabacion.linea_hablantes;
  if (grabacion.origen === 'online' && linea?.length) {
    const iv = intervalosDesdeLinea(linea, palabras[palabras.length - 1].end + 1);
    const porRecuadro = asignarOnline(palabras, iv);
    // Pareja online con diarización: si un recuadro de Meet tiene 2+ voces (la pareja en un mismo
    // dispositivo), se separa por la etiqueta de AssemblyAI. Sin diarización, no cambia nada.
    const conVoces = palabras.some((w) => w.clave) ? separarRecuadroCompartido(palabras, porRecuadro) : porRecuadro;
    hablantes = conVoces.map((n) => (n === HABLANTE_NO_IDENTIFICADO ? n : nombreFinal(n, mapa, (c) => c)));
  } else if (palabras.some((w) => w.clave)) {
    // Diarización de AssemblyAI (pareja presencial). Una palabra sin etiqueta hereda la anterior.
    let previa: string | null = null;
    hablantes = palabras.map((w) => {
      const c = w.clave ?? previa;
      previa = c;
      return c ? nombreFinal(c, mapa, nombrePorDefecto) : HABLANTE_NO_IDENTIFICADO;
    });
  } else {
    const n = grabacion.origen === 'online' ? HABLANTE_NO_IDENTIFICADO : HABLANTE_SIN_SEPARAR;
    hablantes = palabras.map(() => nombreFinal(n, mapa, (c) => c));
  }
  return agrupar(palabras, hablantes);
};

/** Arma el objeto en claro que P6 comprime y cifra (TranscripcionClara v1). */
export function armarTranscripcionClara(params: {
  grabacion: Parameters<UnirTranscripcion>[0]['grabacion'] & Pick<Grabacion, 'modelo'>;
  segmentos: { offset_ms: number; resultado: ResultadoTranscripcion }[];
  modelo?: ModeloTranscripcion;
}): TranscripcionClara {
  const voz = unirTranscripcion({ grabacion: params.grabacion, segmentos: params.segmentos });
  // H13: huecos (interrupciones) como tramos-marca sin hablante, solo si hubo voz.
  const huecos = voz.length
    ? huecosSinPausa(params.grabacion.origen, params.segmentos.filter((s) => s.resultado.status === 'completed'), params.grabacion.pausas ?? [])
    : [];
  const tramos = [...voz, ...huecos.map((h) => ({ inicio_ms: h.desde_ms, fin_ms: h.hasta_ms, hablante: '', texto: textoHueco(h.desde_ms, h.hasta_ms) }))]
    .sort((a, b) => a.inicio_ms - b.inicio_ms);
  const fin = Math.max(
    0,
    ...params.segmentos.map((s) => s.offset_ms + (typeof s.resultado.audio_duration === 'number' ? s.resultado.audio_duration * 1000 : 0)),
    ...tramos.map((t) => t.fin_ms),
  );
  return {
    v: 1,
    idioma: 'es',
    modelo: params.modelo ?? params.grabacion.modelo,
    duracion_s: Math.round(fin / 1000),
    hablantes: [...new Set(tramos.map((t) => t.hablante).filter(Boolean))],
    segmentos: tramos,
  };
}
