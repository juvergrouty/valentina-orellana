// Solo para pruebas (node:test): Supabase en memoria con el subconjunto de supabase-js que usan
// el orquestador y los módulos que llama (estados, assemblyai, resumen, consentimiento, bot,
// auditoria). Imita lo que importa de 0014/0016: defaults, índices únicos (error 23505),
// updated_at automático, resúmenes 'listo' que no se pisan y bitácora solo-inserción.
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export type Fila = Record<string, any>;
type Err = { message: string; code?: string } | null;
interface Resp { data: any; error: Err; count?: number | null }

interface Unico { cols: string[]; si?: (f: Fila) => boolean }

const UNICOS: Record<string, Unico[]> = {
  grabaciones: [{ cols: ['google_event_id'], si: (f) => f.google_event_id != null && f.origen === 'online' }],
  grabacion_segmentos: [{ cols: ['grabacion_id', 'seq'] }, { cols: ['aai_transcript_id'], si: (f) => f.aai_transcript_id != null }],
  transcripciones: [{ cols: ['grabacion_id'] }],
  resumenes_ia: [{ cols: ['grabacion_id', 'version'] }],
  transcriptor_webhooks: [{ cols: ['proveedor', 'evento_id'] }],
  settings: [{ cols: ['key'] }],
  // Añadido por t-n-pareja: únicos de 0019 (consent_avisos.consent_id) y 0021 (consent_anexos).
  consent_avisos: [{ cols: ['consent_id'] }],
  consent_anexos: [{ cols: ['consent_id', 'tipo'] }],
};

function defaults(t: string, ahora: string): Fila {
  const base: Fila = { id: randomUUID(), created_at: ahora };
  switch (t) {
    case 'grabaciones': return { ...base, updated_at: ahora, estado: 'creada', tipo: 'sin_tipo', lugar_con_ruido: false, diarizacion: false, consent_ids: [], pausas: [], intentos: 0, creada_por: 'vale', tomada_en: null, proximo_intento_at: null, mapa_hablantes: null, linea_hablantes: null, bot_machine_id: null, inicio_at: null, nota_sistema: null, ultimo_error: null, estado_antes_error: null, duracion_seg: null };
    case 'grabacion_segmentos': return { ...base, offset_ms: 0, aai_errores: 0, aai_transcript_id: null, aai_estado: null, subido_at: null, audio_borrado_at: null, aai_borrado_at: null };
    case 'resumenes_ia': return { ...base, version: 1, autor: 'ia', estado: 'pendiente', intentos: 0, modo: 'directo', rotulo: 'Resumen automático (IA) — no revisado', oculto_at: null };
    case 'transcripciones': return { ...base, deleted_at: null };
    case 'transcriptor_webhooks': return { id: Math.floor(Math.random() * 1e9), recibido_at: ahora, procesado_at: null };
    case 'transcriptor_auditoria': return { id: Math.floor(Math.random() * 1e9), at: ahora, resultado: 'ok' };
    case 'settings': return {};
    default: return base;
  }
}

const val = (f: Fila, k: string) => (f[k] === undefined ? null : f[k]);
function cmp(a: any, b: any): number {
  if (a == null || b == null) return NaN;
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export class SupabaseMemoria {
  tablas: Record<string, Fila[]> = {};
  /** Reloj de la base (created_at/updated_at). */
  ahora: () => Date = () => new Date();
  tabla(t: string): Fila[] { return (this.tablas[t] ??= []); }
  from(t: string) { return new Consulta(this, t); }
  get cliente(): SupabaseClient { return this as unknown as SupabaseClient; }

  violaUnico(t: string, f: Fila, ignorar?: Fila): boolean {
    for (const u of UNICOS[t] ?? []) {
      if (u.si && !u.si(f)) continue;
      if (this.tabla(t).some((o) => o !== ignorar && (!u.si || u.si(o)) && u.cols.every((c) => val(o, c) === val(f, c)))) return true;
    }
    return false;
  }
}

class Consulta implements PromiseLike<Resp> {
  private filtros: ((f: Fila) => boolean)[] = [];
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private valores: Fila | Fila[] = {};
  private devolver = false;
  private unica: 'no' | 'maybe' | 'single' = 'no';
  private cuenta = false;
  private cabeza = false;
  private conflicto: string[] = [];
  private ignorarDuplicados = false;
  private orden: { col: string; asc: boolean }[] = [];
  private tope: number | null = null;

  constructor(private db: SupabaseMemoria, private t: string) {}

  select(_c?: string, o?: { count?: string; head?: boolean }) {
    if (this.op !== 'select') this.devolver = true;
    if (o?.count) this.cuenta = true;
    if (o?.head) this.cabeza = true;
    return this;
  }
  insert(v: Fila | Fila[]) { this.op = 'insert'; this.valores = v; return this; }
  update(v: Fila) { this.op = 'update'; this.valores = v; return this; }
  upsert(v: Fila | Fila[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = 'upsert'; this.valores = v; this.conflicto = (o?.onConflict ?? 'id').split(',').map((x) => x.trim()); this.ignorarDuplicados = !!o?.ignoreDuplicates; return this;
  }
  delete() { this.op = 'delete'; return this; }

  eq(k: string, v: unknown) { this.filtros.push((f) => val(f, k) === v); return this; }
  neq(k: string, v: unknown) { this.filtros.push((f) => val(f, k) !== v); return this; }
  /** ilike sin comodines (igualdad sin mayúsculas; los \% \_ escapados se tratan como literales). Añadido por t-fix-logica. */
  ilike(k: string, v: string) {
    const objetivo = v.replace(/\\([\\%_])/g, '$1').toLowerCase();
    this.filtros.push((f) => String(val(f, k) ?? '').toLowerCase() === objetivo);
    return this;
  }
  in(k: string, v: unknown[]) { this.filtros.push((f) => v.includes(val(f, k))); return this; }
  is(k: string, v: null | boolean) { this.filtros.push((f) => val(f, k) === v); return this; }
  not(k: string, op: string, v: unknown) {
    if (op === 'is' && v === null) this.filtros.push((f) => val(f, k) !== null);
    else this.filtros.push((f) => val(f, k) !== v);
    return this;
  }
  lt(k: string, v: unknown) { this.filtros.push((f) => cmp(val(f, k), v) < 0); return this; }
  lte(k: string, v: unknown) { this.filtros.push((f) => cmp(val(f, k), v) <= 0); return this; }
  gt(k: string, v: unknown) { this.filtros.push((f) => cmp(val(f, k), v) > 0); return this; }
  gte(k: string, v: unknown) { this.filtros.push((f) => cmp(val(f, k), v) >= 0); return this; }
  /** Solo la forma 'col.op.valor,col.op.valor' (is/eq/lt/lte/gt/gte). */
  or(expr: string) {
    const partes = expr.split(',').map((p) => {
      const i = p.indexOf('.'); const j = p.indexOf('.', i + 1);
      return { col: p.slice(0, i), op: p.slice(i + 1, j), v: p.slice(j + 1) };
    });
    this.filtros.push((f) => partes.some(({ col, op, v }) => {
      const x = val(f, col);
      if (op === 'is') return v === 'null' ? x === null : String(x) === v;
      if (op === 'eq') return String(x) === v;
      const c = cmp(x, v);
      return op === 'lt' ? c < 0 : op === 'lte' ? c <= 0 : op === 'gt' ? c > 0 : op === 'gte' ? c >= 0 : false;
    }));
    return this;
  }
  order(col: string, o?: { ascending?: boolean }) { this.orden.push({ col, asc: o?.ascending !== false }); return this; }
  limit(n: number) { this.tope = n; return this; }
  maybeSingle() { this.unica = 'maybe'; return this; }
  single() { this.unica = 'single'; return this; }

  then<A = Resp, B = never>(ok?: ((v: Resp) => A | PromiseLike<A>) | null, mal?: ((e: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return Promise.resolve().then(() => this.ejecutar()).then(ok, mal);
  }

  private salida(filas: Fila[]): Resp {
    let out = filas.map((f) => structuredClone(f));
    for (const o of [...this.orden].reverse()) out.sort((a, b) => (cmp(val(a, o.col), val(b, o.col)) || 0) * (o.asc ? 1 : -1));
    if (this.tope != null) out = out.slice(0, this.tope);
    if (this.cuenta && this.cabeza) return { data: null, error: null, count: filas.length };
    if (this.unica === 'maybe') {
      if (out.length > 1) return { data: null, error: { message: 'más de una fila', code: 'PGRST116' } };
      return { data: out[0] ?? null, error: null, count: this.cuenta ? filas.length : null };
    }
    if (this.unica === 'single') {
      if (out.length !== 1) return { data: null, error: { message: 'se esperaba una fila', code: 'PGRST116' } };
      return { data: out[0], error: null };
    }
    return { data: out, error: null, count: this.cuenta ? filas.length : null };
  }

  private ejecutar(): Resp {
    const filas = this.db.tabla(this.t);
    const ahora = this.db.ahora().toISOString();
    const coincide = () => filas.filter((f) => this.filtros.every((g) => g(f)));
    const dup = { message: 'duplicate key value violates unique constraint', code: '23505' };

    if (this.op === 'insert' || this.op === 'upsert') {
      const lista = Array.isArray(this.valores) ? this.valores : [this.valores];
      const hechas: Fila[] = [];
      for (const v of lista) {
        if (this.op === 'upsert') {
          const previa = filas.find((f) => this.conflicto.every((k) => val(f, k) === val(v, k)));
          if (previa) {
            if (!this.ignorarDuplicados) { Object.assign(previa, structuredClone(v)); hechas.push(previa); }
            continue;
          }
        }
        const nueva = { ...defaults(this.t, ahora), ...structuredClone(v) };
        if (this.db.violaUnico(this.t, nueva)) return { data: null, error: dup };
        filas.push(nueva);
        hechas.push(nueva);
      }
      return this.devolver ? this.salida(hechas) : { data: null, error: null };
    }
    if (this.op === 'delete') {
      if (this.t === 'transcriptor_auditoria' || this.t === 'resumenes_ia') return { data: null, error: { message: `${this.t} no se borra` } };
      const fuera = coincide();
      this.db.tablas[this.t] = filas.filter((f) => !fuera.includes(f));
      return this.devolver ? this.salida(fuera) : { data: null, error: null };
    }
    if (this.op === 'update') {
      if (this.t === 'transcriptor_auditoria') return { data: null, error: { message: 'transcriptor_auditoria es solo de inserción' } };
      const cambios = this.valores as Fila;
      const afectadas = coincide();
      for (const f of afectadas) {
        // 0020 (añadido por t-n-ficha): archivar vacía contenido/contenido_cifrado en la misma
        // actualización que marca archivado_at con sus dos copias; un archivado no cambia su archivo.
        const archivando = this.t === 'resumenes_ia' && !f.archivado_at && !!cambios.archivado_at
          && !!(cambios.archivo_r2_key ?? f.archivo_r2_key) && !!cambios.archivo_b2_key && cambios.contenido === null && cambios.contenido_cifrado === null;
        if (this.t === 'resumenes_ia' && f.archivado_at
          && ['archivado_at', 'archivo_r2_key', 'archivo_b2_key', 'archivo_sha256', 'contenido', 'contenido_cifrado'].some((k) => k in cambios && cambios[k] !== f[k])) {
          return { data: null, error: { message: 'un resumen archivado no cambia su archivo' } };
        }
        if (this.t === 'resumenes_ia' && f.estado === 'listo'
          && ['contenido', 'contenido_cifrado', 'estado', 'grabacion_id', 'version', 'autor', 'modelo', 'rotulo'].some((k) => k in cambios && cambios[k] !== f[k] && !(archivando && (k === 'contenido' || k === 'contenido_cifrado')))) {
          return { data: null, error: { message: 'un resumen listo no se modifica: crear una nueva versión' } };
        }
        const nueva = { ...f, ...structuredClone(cambios) };
        if (this.db.violaUnico(this.t, nueva, f)) return { data: null, error: dup };
      }
      for (const f of afectadas) {
        Object.assign(f, structuredClone(cambios));
        if (this.t === 'grabaciones') f.updated_at = ahora;
      }
      return this.devolver ? this.salida(afectadas) : { data: null, error: null, count: this.cuenta ? afectadas.length : null };
    }
    return this.salida(coincide());
  }
}
