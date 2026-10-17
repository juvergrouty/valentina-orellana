// Notas clínicas de la ficha (pestaña "Notas clínicas"): grabaciones, resúmenes IA, "Para revisar hoy" e
// historial por sesión. Movido desde pacientes/[id].astro (17 oct 2026) para que la ficha y la carga
// bajo demanda del historial (pacientes/[id]/historial.astro) usen exactamente la misma lógica:
//   • la ficha trae SOLO la sesión más reciente (y "Para revisar hoy"); el resto del historial se pide
//     con "Ver historial" → el HTML inicial no trae los resúmenes de todas las fechas;
//   • cada carga que muestra resúmenes registra su acceso (`ver_resumen`) ANTES de descifrar (H6/H7):
//     si la bitácora falla, no se muestran.
// El resumen es un ANEXO rotulado, separado de la nota de evolución: nunca se mezclan (decisión B/F).
import type { AstroCookies } from 'astro';
import { supabase } from '../supabase';
import { todayCL } from '../dateUtils';
import {
  armarHistorial, bloqueParaRevisarHoy, estadoVisible, resumenAHtml, resumenATexto, sePuedeReintentar, textoProblema,
  type EntradaHistorial,
} from './panel';
import { accesoClinicoCookies, type ResultadoAcceso } from './acceso';
import { avisoAnexoResumen } from './resumen';
import { conContenidoClaro } from './resumenCifrado';
import { AVISO_FALTA_0020, consultarResumenes } from './archivo';
import { auditarObligatorio } from './auditoria';

export type GrabFicha = {
  id: string; booking_id: string | null; origen: 'presencial' | 'online'; tipo: 'individual' | 'pareja' | 'sin_tipo';
  estado: string; estado_antes_error: string | null; session_date: string; inicio_at: string | null;
  duracion_seg: number | null; nota_sistema: string | null; created_at: string; excluir_ia_at?: string | null;
};
export type ResFicha = {
  id: string; grabacion_id: string; version: number; autor: 'ia' | 'vale'; estado: string; rotulo: string | null; contenido: string | null;
  contenido_cifrado?: unknown; modelo?: string | null; listo_at: string | null; created_at: string;
  archivo_r2_key?: string | null; archivo_b2_key?: string | null; archivado_at?: string | null;
};

const OCULTAS_EN_FICHA = new Set(['creada', 'cancelada', 'sin_consentimiento', 'bot_no_admitido']);

export interface EntradaNotasFicha {
  patientId: string;
  notas: any[];
  reservas: any[];
  cookies: AstroCookies;
  request: Request;
  clientAddress: string | null;
  /** Se descifran y muestran resúmenes (pestaña Notas o historial). En las otras pestañas solo se cuentan. */
  descifrar: boolean;
  /** Etiqueta de la bitácora: 'ficha', 'ficha_historial', 'ficha_info'… */
  vista: string;
  /** Solo `astro dev` (?demo=ia). */
  demo?: { grabaciones: GrabFicha[]; resumenes: ResFicha[]; archivados: Record<string, string>; falta0020: boolean } | null;
}

export async function cargarNotasFicha(e: EntradaNotasFicha) {
  const id = e.patientId;
  let grabaciones: GrabFicha[] = [];
  let resumenes: ResFicha[] = [];
  let transcritas = new Set<string>();
  let acceso: ResultadoAcceso = { ok: true };
  let bloqueadas = false; // hay grabaciones, pero esta sesión no está confirmada con passkey
  /** 86-revisión M2: aviso arriba de las sesiones si falta 0020 o no se pudieron leer los resúmenes. */
  let avisoBase: string | null = null;
  let avisoResumenes: string | null = null;
  const demoArchivados = e.demo?.archivados ?? {};

  if (e.demo) {
    grabaciones = e.demo.grabaciones;
    resumenes = e.demo.resumenes;
    transcritas = new Set(grabaciones.map((g) => g.id));
    if (e.demo.falta0020) avisoBase = AVISO_FALTA_0020;
  } else if (!(acceso = await accesoClinicoCookies(e.cookies)).ok) {
    // Sin sesión con passkey no se lee ningún contenido (revisión de seguridad 16 oct, A1).
    try {
      const { count } = await supabase.from('grabaciones').select('id', { count: 'exact', head: true }).eq('patient_id', id);
      bloqueadas = (count ?? 0) > 0;
    } catch { /* sin la migración: no hay nada que avisar */ }
  } else {
    try {
      const { data: gs, error: eg } = await supabase.from('grabaciones')
        .select('id, booking_id, origen, tipo, estado, estado_antes_error, session_date, inicio_at, duracion_seg, nota_sistema, created_at, excluir_ia_at')
        .eq('patient_id', id).order('session_date', { ascending: false }).order('created_at', { ascending: false }).limit(500);
      if (!eg && gs?.length) {
        grabaciones = (gs as GrabFicha[]).filter((g) => !OCULTAS_EN_FICHA.has(g.estado));
        const ids = grabaciones.map((g) => g.id);
        if (ids.length) {
          const [{ data: rs, error: er, falta0020 }, { data: ts }] = await Promise.all([
            consultarResumenes((cols) => supabase.from('resumenes_ia').select(`id, grabacion_id, version, autor, estado, rotulo, contenido, contenido_cifrado, modelo, listo_at, created_at${cols}`)
              .in('grabacion_id', ids).is('oculto_at', null).order('version', { ascending: false })),
            supabase.from('transcripciones').select('grabacion_id').in('grabacion_id', ids).is('deleted_at', null),
          ]);
          resumenes = (rs ?? []) as ResFicha[];
          if (er) avisoBase = 'No se pudieron leer los resúmenes automáticos de esta ficha en este momento. Están guardados; recarga la página en unos minutos.';
          else if (falta0020) avisoBase = AVISO_FALTA_0020;
          transcritas = new Set((ts ?? []).map((t: { grabacion_id: string }) => t.grabacion_id));
        }
      }
    } catch (err) {
      console.warn('[ficha/transcriptor]', err instanceof Error ? err.message : err);
    }
  }

  // H6 + H7: los resúmenes en la base (a lo más los de las últimas 4 sesiones) se descifran después de
  // registrar el acceso. Los archivados se traen recién con "Ver más" (otra fila de bitácora).
  const enBase = (r: ResFicha) => r.estado === 'listo' && !r.archivado_at && (r.contenido || r.contenido_cifrado);
  if (!e.demo && resumenes.some(enBase)) {
    let registrado = e.descifrar;
    if (e.descifrar) {
      try {
        await auditarObligatorio('vale', 'ver_resumen', {
          patientId: id, request: e.request, clientAddress: e.clientAddress,
          detalle: { resumenes: resumenes.filter(enBase).length, vista: e.vista },
        });
      } catch {
        registrado = false;
        avisoResumenes = 'No se pudo registrar el acceso en la bitácora. Por seguridad, los resúmenes automáticos no se muestran. Intenta de nuevo en un momento.';
      }
    }
    if (registrado) {
      const r = await conContenidoClaro(resumenes.filter(enBase));
      const claro = new Map(r.filas.map((f) => [f.id, f.contenido]));
      // Un resumen listo que no se pudo abrir queda con texto vacío: la tarjeta muestra el aviso.
      resumenes = resumenes.map((x) => (enBase(x) ? { ...x, contenido: claro.get(x.id) ?? '' } : x));
      if (r.fallidas) avisoResumenes = 'Algún resumen cifrado no se pudo abrir en este momento. Está guardado a salvo; intenta de nuevo en unos minutos.';
    } else {
      // Sin descifrar (otras pestañas, o bitácora caída): nunca texto en claro ni cifrado hacia la página.
      resumenes = resumenes.map((r) => ({ ...r, contenido: r.estado === 'listo' ? '' : null, contenido_cifrado: undefined }));
    }
  }

  // Por grabación: versión vigente (la de número más alto que esté lista), si hay otra en camino
  // y si el último intento de la IA falló.
  const tarjetas = grabaciones.map((g) => {
    const versiones = resumenes.filter((r) => r.grabacion_id === g.id).sort((a, b) => b.version - a.version);
    const vigente = versiones.find((r) => r.estado === 'listo' && (r.contenido != null || r.archivado_at)) ?? null;
    const archivado = !!vigente?.archivado_at;
    const generando = versiones.some((r) => (r.estado === 'pendiente' || r.estado === 'en_batch') && (!vigente || r.version > vigente.version));
    return {
      g, vigente, generando, archivado,
      estado: estadoVisible(g.estado),
      contenido: !archivado ? vigente?.contenido ?? null : null,
      problema: textoProblema(g as never),
      reintentable: sePuedeReintentar(g as never),
      transcrita: transcritas.has(g.id),
      html: vigente?.contenido && !archivado ? resumenAHtml(vigente.contenido, (s) => `/admin/pacientes/${id}/sesion/${g.id}?t=${s}`) : '',
      texto: vigente?.contenido && !archivado ? resumenATexto(vigente.contenido) : '',
      aviso: vigente ? avisoAnexoResumen(vigente) : '',
      excluida: !!g.excluir_ia_at,
      demoHtml: archivado && vigente ? (demoArchivados[vigente.id] ? resumenAHtml(demoArchivados[vigente.id]) : '') : '',
    };
  });
  const porBooking = new Map(tarjetas.filter((t) => t.g.booking_id).map((t) => [t.g.booking_id as string, t]));
  // Sesiones que la IA puede leer para responder (con transcripción o con resumen listo). H5.
  const consultables = tarjetas.filter((t) => (t.transcrita || t.vigente) && !t.excluida);
  // "Para revisar hoy" (decisión B): lo que quedó para esta sesión.
  const paraHoy = e.descifrar ? bloqueParaRevisarHoy(tarjetas) : null;
  const enlaceHoy = (s: number) => `/admin/pacientes/${id}/sesion/${paraHoy?.grabacionId}?t=${s}`;
  const paraHoyCols = paraHoy ? [
    { titulo: 'Para trabajar en esta sesión', html: paraHoy.proxima ? resumenAHtml(paraHoy.proxima, enlaceHoy) : '' },
    { titulo: 'Tareas que quedaron', html: paraHoy.tareas ? resumenAHtml(paraHoy.tareas, enlaceHoy) : '' },
  ].filter((c) => c.html) : [];
  // Historial por sesión (estilo Encuadrado, decisión B): reserva + nota de evolución + resumen IA.
  const historial = armarHistorial({ notas: e.notas, tarjetas, reservas: e.reservas, hoy: todayCL() });
  return { tarjetas, porBooking, consultables, paraHoy, paraHoyCols, historial, avisoBase, avisoResumenes, bloqueadas, acceso };
}

export type NotasFicha = Awaited<ReturnType<typeof cargarNotasFicha>>;
export type TarjetaFicha = NotasFicha['tarjetas'][number];
export type EntradaFicha = EntradaHistorial<any, TarjetaFicha>;

/** Cuántas entradas del historial trae la ficha de entrada (el resto, con "Ver historial"). */
export const ENTRADAS_INICIALES = 1;
