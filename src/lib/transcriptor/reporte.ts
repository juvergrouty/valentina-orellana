// Transcriptor IA — reporte mensual (paquete P8, 50-arquitectura §6).
// Arma un resumen SIN contenido clínico (solo conteos, costos y tiempos; ni ids, ni nombres, ni
// texto) y lo guarda en transcriptor_reportes (0014) para que Claude lo revise cada mes con una
// Tarea Programada nativa (deja notas_revision / revisado_por_claude_at; esos campos no se pisan).
import type { EstadoGrabacion, Origen, TipoSesion } from './tipos';
import type { AlertaTipo } from './alertas';
import { calcularGastoUsd, IVA, mesChile, usdAClpConIva } from './salud';

export interface CrudoReporte {
  mes: string; // 'YYYY-MM'
  grabaciones: { id: string; estado: EstadoGrabacion; origen: Origen; tipo: TipoSesion; modelo: string; diarizacion: boolean; fin_at: string | null; intentos: number }[];
  segmentos: { grabacion_id: string; aai_audio_seg: number | null }[];
  resumenes: { grabacion_id: string; estado: string; autor: string; costo_usd: number | null; listo_at: string | null; intentos: number }[];
  preguntas: { costo_usd: number | null; error: string | null }[];
  alertas: { tipo: AlertaTipo; veces: number; resuelta_por: string | null }[];
  reintentosManuales: number;
  /** Acciones que Vale tocó en los avisos (bitácora 'alerta', resultado ok). */
  accionesAvisos?: number;
  usdClp: number;
  presupuestoClp: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const contar = <T extends string>(xs: T[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});

function percentil(ordenados: number[], p: number): number | null {
  if (!ordenados.length) return null;
  const i = Math.min(ordenados.length - 1, Math.max(0, Math.ceil((p / 100) * ordenados.length) - 1));
  return ordenados[i];
}

/** Agrega los datos crudos del mes (función pura, con pruebas). */
export function armarReporte(c: CrudoReporte): Record<string, unknown> {
  const porId = new Map(c.grabaciones.map((g) => [g.id, g]));

  // Audio por modelo (solo segmentos de grabaciones del mes).
  const horasPorModelo: Record<string, number> = {};
  const audioCosto: { seg: number; modelo: string; diarizacion: boolean }[] = [];
  for (const s of c.segmentos) {
    const g = porId.get(s.grabacion_id);
    const seg = Number(s.aai_audio_seg) || 0;
    if (!g || seg <= 0) continue;
    horasPorModelo[g.modelo] = (horasPorModelo[g.modelo] ?? 0) + seg / 3600;
    audioCosto.push({ seg, modelo: g.modelo, diarizacion: g.diarizacion });
  }
  const resIa = c.resumenes.filter((r) => r.autor === 'ia');
  const usdResumenes = resIa.reduce((a, r) => a + (Number(r.costo_usd) || 0), 0);
  const usdPreguntas = c.preguntas.reduce((a, p) => a + (Number(p.costo_usd) || 0), 0);
  const gasto = calcularGastoUsd({ audio: audioCosto, usdResumenes, usdPreguntas });
  const clp = (usd: number) => Math.round(usdAClpConIva(usd, c.usdClp));
  const listas = c.grabaciones.filter((g) => g.estado === 'lista').length;

  // Tiempo fin de la sesión → primer resumen listo (minutos).
  const primerListo = new Map<string, number>();
  for (const r of resIa) {
    const t = r.estado === 'listo' && r.listo_at ? Date.parse(r.listo_at) : NaN;
    if (Number.isFinite(t) && (!primerListo.has(r.grabacion_id) || t < primerListo.get(r.grabacion_id)!)) primerListo.set(r.grabacion_id, t);
  }
  const minutos = c.grabaciones
    .map((g) => (g.fin_at && primerListo.has(g.id) ? (primerListo.get(g.id)! - Date.parse(g.fin_at)) / 60_000 : NaN))
    .filter((m) => Number.isFinite(m) && m >= 0)
    .sort((a, b) => a - b);
  const media = minutos.length ? minutos.reduce((a, b) => a + b, 0) / minutos.length : null;

  const totalClp = clp(gasto.total);
  return {
    mes: c.mes,
    sin_contenido_clinico: true,
    sesiones: {
      total: c.grabaciones.length,
      listas,
      por_estado: contar(c.grabaciones.map((g) => g.estado)),
      por_origen: contar(c.grabaciones.map((g) => g.origen)),
      por_tipo: contar(c.grabaciones.map((g) => g.tipo)),
    },
    audio: {
      horas_total: r2(Object.values(horasPorModelo).reduce((a, b) => a + b, 0)),
      horas_por_modelo: Object.fromEntries(Object.entries(horasPorModelo).map(([k, v]) => [k, r2(v)])),
    },
    costos_usd: { assemblyai: r2(gasto.assemblyai), anthropic_resumenes: r2(usdResumenes), anthropic_preguntas: r2(usdPreguntas), total: r2(gasto.total) },
    costos_clp_con_iva: {
      assemblyai: clp(gasto.assemblyai), anthropic: clp(gasto.anthropic), total: totalClp,
      por_sesion_lista: listas ? Math.round(totalClp / listas) : null,
      usd_clp: c.usdClp, iva: IVA,
      nota: 'No incluye Fly.io (bot), R2 ni B2: revisar sus facturas aparte.',
    },
    presupuesto: { clp: c.presupuestoClp, uso_pct: c.presupuestoClp > 0 ? Math.round((totalClp / c.presupuestoClp) * 100) : null },
    fallas: {
      alertas_total: c.alertas.length,
      alertas_por_tipo: contar(c.alertas.map((a) => a.tipo)),
      repeticiones_total: c.alertas.reduce((a, x) => a + (x.veces || 1), 0),
      // Decisión A (16 oct noche): no existe el cierre manual; todo aviso cerrado lo cerró el
      // sistema al comprobar que el problema se arregló (con o sin una acción de Vale).
      resueltas: c.alertas.filter((a) => !!a.resuelta_por).length,
      acciones_desde_avisos: c.accionesAvisos ?? 0,
      abiertas: c.alertas.filter((a) => !a.resuelta_por).length,
      reintentos_manuales: c.reintentosManuales,
      grabaciones_en_error: c.grabaciones.filter((g) => g.estado === 'error').length,
      grabaciones_con_reintentos: c.grabaciones.filter((g) => g.intentos > 0).length,
      resumenes_con_error: resIa.filter((r) => r.estado === 'error').length,
      preguntas_con_error: c.preguntas.filter((p) => p.error).length,
    },
    tiempos: {
      fin_sesion_a_resumen_min: {
        n: minutos.length,
        media: media === null ? null : Math.round(media),
        p50: percentil(minutos, 50) === null ? null : Math.round(percentil(minutos, 50)!),
        p90: percentil(minutos, 90) === null ? null : Math.round(percentil(minutos, 90)!),
        max: minutos.length ? Math.round(minutos[minutos.length - 1]) : null,
      },
      resumen_en_menos_de_2h_pct: minutos.length ? Math.round((minutos.filter((m) => m < 120).length / minutos.length) * 100) : null,
    },
    preguntas: { total: c.preguntas.length },
  };
}

/** Mes anterior (Chile) a `ahora`, como 'YYYY-MM'. */
export const mesAnterior = (ahora: Date) => mesChile(ahora, -1).etiqueta;

/** Lee el mes de Supabase, arma y guarda el reporte (upsert por mes; no toca la revisión de Claude). */
export async function generarReporteMensual(mes: string): Promise<Record<string, unknown>> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new Error('mes inválido (YYYY-MM)');
  const { supabase: db } = await import('../supabase');
  const [y, m] = mes.split('-').map(Number);
  const rango = mesChile(new Date(Date.UTC(y, m - 1, 15, 12)));
  const desde = rango.desde.toISOString(), hasta = rango.hasta.toISOString();
  const leer = async <T>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>, que: string): Promise<T[]> => {
    const { data, error } = await q;
    if (error) throw new Error(`reporte ${que}: ${error.message}`);
    return (data ?? []) as T[];
  };

  const grabaciones = await leer<CrudoReporte['grabaciones'][number]>(
    db.from('grabaciones').select('id, estado, origen, tipo, modelo, diarizacion, fin_at, intentos').gte('created_at', desde).lt('created_at', hasta).limit(5000), 'grabaciones');
  const ids = grabaciones.map((g) => g.id);
  const trozos = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
  const segmentos: CrudoReporte['segmentos'] = [];
  const resumenes: CrudoReporte['resumenes'] = [];
  for (const parte of trozos(ids, 150)) {
    segmentos.push(...await leer<CrudoReporte['segmentos'][number]>(db.from('grabacion_segmentos').select('grabacion_id, aai_audio_seg').in('grabacion_id', parte), 'segmentos'));
    resumenes.push(...await leer<CrudoReporte['resumenes'][number]>(db.from('resumenes_ia').select('grabacion_id, estado, autor, costo_usd, listo_at, intentos').in('grabacion_id', parte), 'resúmenes'));
  }
  const [preguntas, alertas, reintentos, accionesAvisos, ajustes] = await Promise.all([
    leer<CrudoReporte['preguntas'][number]>(db.from('preguntas_ia').select('costo_usd, error').gte('created_at', desde).lt('created_at', hasta).limit(5000), 'preguntas'),
    leer<CrudoReporte['alertas'][number]>(db.from('transcriptor_alertas').select('tipo, veces, resuelta_por').gte('creada_at', desde).lt('creada_at', hasta).limit(5000), 'alertas')
      .catch(() => [] as CrudoReporte['alertas']), // 0017 sin aplicar
    db.from('transcriptor_auditoria').select('id', { count: 'exact', head: true }).eq('accion', 'reintentar').eq('actor', 'vale').eq('resultado', 'ok').gte('at', desde).lt('at', hasta),
    db.from('transcriptor_auditoria').select('id', { count: 'exact', head: true }).eq('accion', 'alerta').eq('actor', 'vale').eq('resultado', 'ok').gte('at', desde).lt('at', hasta),
    leer<{ key: string; value: string }>(db.from('settings').select('key, value').in('key', ['transcriptor_usd_clp', 'transcriptor_presupuesto_clp']), 'ajustes'),
  ]);
  const aj = new Map(ajustes.map((a) => [a.key, Number(a.value)]));
  const datos = armarReporte({
    mes, grabaciones, segmentos, resumenes, preguntas, alertas,
    reintentosManuales: reintentos.count ?? 0,
    accionesAvisos: accionesAvisos.count ?? 0,
    usdClp: aj.get('transcriptor_usd_clp') || 950,
    presupuestoClp: aj.get('transcriptor_presupuesto_clp') || 35000,
  });
  const { error } = await db.from('transcriptor_reportes')
    .upsert({ mes: `${mes}-01`, generado_at: new Date().toISOString(), datos }, { onConflict: 'mes' });
  if (error) throw new Error(`reporte guardar: ${error.message}`);
  return datos;
}

/** El cron diario lo llama: genera el reporte del mes anterior si todavía no existe. */
export async function reporteDelMesAnteriorSiFalta(ahora = new Date()): Promise<{ mes: string; generado: boolean }> {
  const mes = mesAnterior(ahora);
  const { supabase: db } = await import('../supabase');
  const { data, error } = await db.from('transcriptor_reportes').select('mes').eq('mes', `${mes}-01`).maybeSingle();
  if (error) throw new Error(`reporte: ${error.message}`);
  if (data) return { mes, generado: false };
  await generarReporteMensual(mes);
  return { mes, generado: true };
}
