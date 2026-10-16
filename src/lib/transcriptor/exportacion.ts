// Exportación legal "Descargar ficha completa" (02-decisiones-16oct-noche, B): TODO lo de un paciente,
// ordenado por fecha y estructurado, para la normativa (ficha clínica, 15 años) o un juicio:
//   • datos de la ficha;
//   • consentimientos: texto EXACTO firmado (text_snapshot) + verificación de su huella SHA-256,
//     autorizaciones, retiros, y anexos (avisos de cambio de consentimiento, consent_avisos);
//   • notas de evolución de Vale (incluidas las archivadas, marcadas como tales);
//   • todos los resúmenes automáticos (IA), todas las versiones (los archivados se traen de R2/B2);
//   • todas las transcripciones completas con hablantes y minutos (descifradas en memoria desde R2/B2);
//   • la bitácora de accesos del transcriptor (incluye este mismo pedido de exportación).
// Salida: un PDF legible (pdf.ts) y un JSON de datos, juntos en un ZIP (zip.ts), o cada uno por separado.
// Todo se arma en memoria: no se escribe en disco, no se guarda en Supabase ni en R2 (sin copias en el
// servidor). Quien llama (endpoint) exige passkey y registra la bitácora ANTES de leer contenido.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TranscripcionClara } from './tipos';
import { consultarResumenes, conTextoResumen, type AlmArchivo, type FilaArchivo, type OpcionesLectura } from './archivo';
import { lineasTranscripcion, resumenATexto } from './panel';
import { avisoAnexoResumen } from './resumen';
import { generarPdf, type BloquePdf } from './pdf';
import { crearZip } from './zip';
import { createHash } from 'node:crypto';

export type FormatoExportacion = 'zip' | 'pdf' | 'json';
export const FORMATOS: readonly FormatoExportacion[] = ['zip', 'pdf', 'json'];
/** Vercel corta respuestas de más de 4,5 MB: se deja margen. */
export const TOPE_RESPUESTA_BYTES = 4_400_000;
export const VERSION_EXPORTACION = 'ficha-2026-10-16.1';

export interface DepsExportacion {
  db: SupabaseClient;
  leerTranscripcion: (r2Key: string) => Promise<TranscripcionClara>;
  alm?: AlmArchivo;
  cif?: OpcionesLectura['cif'];
  ahora?: () => Date;
}

export interface OpcionesExportacion {
  /** Solo un año calendario (para fichas muy largas que no caben en 4,5 MB). Consentimientos y datos van siempre completos. */
  anio?: number | null;
}

const TZ = 'America/Santiago';
export function fechaHoraCL(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.toLocaleString('es-CL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })} (hora de Chile)`;
}
export function fechaCL(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : (ymd ?? '—');
}
const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

/** HTML de un correo → texto legible para el PDF (el HTML exacto va en el JSON). */
export function textoDeHtml(html: string): string {
  return (html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── Datos ───────────────────────────────────────────────────────────────────

export interface LineaExportada { inicio: string; inicio_ms: number; fin_ms: number | null; hablante: string | null; texto: string; tipo: 'tramo' | 'pausa' }
export interface SesionExportada {
  grabacion_id: string;
  fecha: string;
  inicio_at: string | null;
  origen: string;
  tipo: string;
  duracion_seg: number | null;
  estado: string;
  consent_ids: string[];
  excluida_de_ia: { at: string; motivo: string | null } | null;
  resumenes: { id: string; version: number; autor: string; estado: string; rotulo: string | null; aviso: string; modelo: string | null; prompt_version: string | null; listo_at: string | null; oculto_at: string | null; archivado_at: string | null; contenido: string | null; error_lectura?: boolean }[];
  transcripcion: { id: string; modelo: string | null; idioma: string | null; duracion_s: number | null; palabras: number | null; sha256_cifrado: string | null; copia_b2: boolean; lineas: LineaExportada[] } | null;
  transcripcion_error: string | null;
}
export interface FichaExportada {
  version: string;
  generado_at: string;
  alcance: { anio: number | null };
  paciente: Record<string, unknown>;
  consentimientos: Record<string, unknown>[];
  anexos_consentimiento: Record<string, unknown>[];
  notas: { id: string; fecha: string; tipo: string | null; contenido: string; creada_at: string | null; archivada_at: string | null }[];
  sesiones_agendadas: { fecha: string; hora: string | null; tipo: string | null; estado: string | null; titulo: string | null }[];
  sesiones_grabadas: SesionExportada[];
  bitacora: { at: string; actor: string; accion: string; resultado: string; grabacion_id: string | null; ip: string | null; dispositivo: string | null; detalle: unknown }[];
  avisos: string[];
}

const enAnio = (fecha: string | null | undefined, anio: number | null | undefined) => !anio || String(fecha ?? '').startsWith(`${anio}-`);

export async function recopilarFicha(patientId: string, deps: DepsExportacion, op: OpcionesExportacion = {}): Promise<FichaExportada> {
  const { db } = deps;
  const anio = op.anio ?? null;
  const avisos: string[] = [];
  const err = (que: string, e: { code?: string; message?: string } | null) => { if (e) throw new Error(`${que}: ${e.code ?? e.message ?? 'error'}`); };

  const { data: p, error: ep } = await db.from('patients').select('*').eq('id', patientId).maybeSingle();
  err('patients', ep);
  if (!p) throw new Error('paciente no encontrado');
  const paciente: Record<string, unknown> = {};
  for (const k of ['id', 'name', 'rut', 'sin_rut', 'doc_tipo', 'doc_numero', 'doc_pais', 'birthdate', 'email', 'phone', 'address', 'comuna', 'emergency_name', 'emergency_phone', 'notes', 'active', 'created_at']) {
    if ((p as Record<string, unknown>)[k] !== undefined) paciente[k] = (p as Record<string, unknown>)[k];
  }

  const [{ data: cs, error: ec }, { data: ns, error: en }, { data: gs, error: eg }] = await Promise.all([
    db.from('consents').select('*').eq('patient_id', patientId).order('created_at', { ascending: true }),
    db.from('session_notes').select('*').eq('patient_id', patientId).order('session_date', { ascending: true }),
    db.from('grabaciones').select('id, booking_id, origen, tipo, estado, session_date, inicio_at, duracion_seg, pausas, mapa_hablantes, consent_ids, excluir_ia_at, excluir_ia_motivo, created_at')
      .eq('patient_id', patientId).order('session_date', { ascending: true }).limit(2000),
  ]);
  err('consents', ec); err('session_notes', en); err('grabaciones', eg);

  const consentimientos: Record<string, unknown>[] = ((cs ?? []) as Record<string, unknown>[]).map((c) => {
    const texto = typeof c.text_snapshot === 'string' ? c.text_snapshot : null;
    const { token: _t, ...resto } = c; // el token del link no es parte de la constancia
    return { ...resto, texto_firmado: texto, verificacion_texto: texto && c.text_sha256 ? (sha256(texto) === c.text_sha256 ? 'integro' : 'NO_COINCIDE') : 'sin_texto' };
  });
  for (const c of consentimientos) delete (c as Record<string, unknown>).text_snapshot;
  let anexos: Record<string, unknown>[] = [];
  const cids = consentimientos.map((c) => c.id as string).filter(Boolean);
  if (cids.length) {
    const { data: av, error: ea } = await db.from('consent_avisos').select('*').in('consent_id', cids).order('mostrado_at', { ascending: true });
    if (ea) avisos.push('No se pudieron leer los anexos de aviso de cambio de consentimiento (consent_avisos).');
    anexos = ((av ?? []) as Record<string, unknown>[]).map((a) => ({ ...a, tipo: 'aviso_cambio_consentimiento' }));
    // 0021 (decisión E): copia fiel del correo de aviso, guardada como anexo del consentimiento.
    const { data: ax, error: ex } = await db.from('consent_anexos').select('*').in('consent_id', cids).order('enviado_at', { ascending: true });
    if (ex && ex.code !== '42P01') avisos.push('No se pudieron leer los anexos de consentimiento (consent_anexos).');
    for (const a of (ax ?? []) as Record<string, unknown>[]) {
      const html = typeof a.html === 'string' ? a.html : '';
      anexos.push({
        ...a, tipo: 'copia_correo_aviso', tipo_anexo: a.tipo,
        texto_correo: textoDeHtml(html),
        verificacion_html: html && a.html_sha256 ? (sha256(html) === a.html_sha256 ? 'integro' : 'NO_COINCIDE') : 'sin_html',
      });
    }
  }

  const notas = ((ns ?? []) as Record<string, unknown>[])
    .filter((n) => enAnio(n.session_date as string, anio))
    .map((n) => ({
      id: String(n.id), fecha: String(n.session_date ?? ''), tipo: (n.session_type as string) ?? null, contenido: String(n.content ?? ''),
      creada_at: (n.created_at as string) ?? null, archivada_at: (n.deleted_at as string) ?? null,
    }));

  let agendadas: FichaExportada['sesiones_agendadas'] = [];
  if (p.email) {
    const { data: bs } = await db.from('bookings').select('session_date, session_time, session_type, status, custom_title').ilike('patient_email', String(p.email).trim().replace(/[\\%_]/g, (m) => `\\${m}`)).order('session_date', { ascending: true }); // B5: sin distinguir mayúsculas (como pareja.ts)
    agendadas = ((bs ?? []) as Record<string, unknown>[])
      .filter((b) => b.session_date !== '2099-12-31' && enAnio(b.session_date as string, anio))
      .map((b) => ({ fecha: String(b.session_date), hora: b.session_time ? String(b.session_time).slice(0, 5) : null, tipo: (b.session_type as string) ?? null, estado: (b.status as string) ?? null, titulo: (b.custom_title as string) ?? null }));
  }

  type G = { id: string; origen: string; tipo: string; estado: string; session_date: string; inicio_at: string | null; duracion_seg: number | null; pausas: { desde_ms: number; hasta_ms: number }[] | null; mapa_hablantes: Record<string, string> | null; consent_ids: string[] | null; excluir_ia_at: string | null; excluir_ia_motivo: string | null };
  const grabaciones = ((gs ?? []) as G[]).filter((g) => enAnio(g.session_date, anio));
  const ids = grabaciones.map((g) => g.id);
  const [{ data: rs, error: er }, { data: ts, error: et }] = ids.length
    ? await Promise.all([
      // 86-revisión M2: sin 0020 se exporta igual (todo sigue en la base) en vez de fallar con 502.
      consultarResumenes((cols) => db.from('resumenes_ia').select(`id, grabacion_id, version, autor, estado, rotulo, modelo, prompt_version, listo_at, oculto_at, contenido, contenido_cifrado${cols}`).in('grabacion_id', ids).order('version', { ascending: true })),
      db.from('transcripciones').select('id, grabacion_id, r2_key, b2_key, modelo, idioma, duracion_s, palabras, sha256_cifrado, deleted_at').in('grabacion_id', ids),
    ])
    : [{ data: [], error: null }, { data: [], error: null }];
  err('resumenes_ia', er); err('transcripciones', et);
  const { filas: resumenes, fallidas } = await conTextoResumen((rs ?? []) as (FilaArchivo & Record<string, unknown>)[], { alm: deps.alm, cif: deps.cif });
  if (fallidas) avisos.push(`${fallidas} resumen(es) no se pudieron abrir en este momento (están guardados cifrados; volver a exportar más tarde).`);

  const sesiones: SesionExportada[] = [];
  for (const g of grabaciones) {
    const tr = ((ts ?? []) as Record<string, unknown>[]).find((t) => t.grabacion_id === g.id && !t.deleted_at);
    let transcripcion: SesionExportada['transcripcion'] = null;
    let trError: string | null = null;
    if (tr) {
      try {
        const clara = await deps.leerTranscripcion(String(tr.r2_key));
        const lineas = lineasTranscripcion(clara.segmentos, g.pausas ?? [], g.mapa_hablantes);
        const finPorMs = new Map(clara.segmentos.map((s) => [s.inicio_ms, s.fin_ms]));
        transcripcion = {
          id: String(tr.id), modelo: (tr.modelo as string) ?? null, idioma: (tr.idioma as string) ?? null, duracion_s: (tr.duracion_s as number) ?? null,
          palabras: (tr.palabras as number) ?? null, sha256_cifrado: (tr.sha256_cifrado as string) ?? null, copia_b2: !!tr.b2_key,
          lineas: lineas.map((l) => ({ inicio: l.marca, inicio_ms: l.ms, fin_ms: l.tipo === 'tramo' ? finPorMs.get(l.ms) ?? null : null, hablante: l.hablante ?? null, texto: l.texto, tipo: l.tipo })),
        };
      } catch {
        trError = 'No se pudo abrir la transcripción cifrada en este momento (está guardada; volver a exportar más tarde).';
        avisos.push(`Sesión del ${fechaCL(g.session_date)}: ${trError}`);
      }
    }
    sesiones.push({
      grabacion_id: g.id, fecha: g.session_date, inicio_at: g.inicio_at, origen: g.origen, tipo: g.tipo, duracion_seg: g.duracion_seg, estado: g.estado,
      consent_ids: g.consent_ids ?? [], excluida_de_ia: g.excluir_ia_at ? { at: g.excluir_ia_at, motivo: g.excluir_ia_motivo } : null,
      resumenes: resumenes.filter((r) => r.grabacion_id === g.id).map((r) => {
        const x = r as FilaArchivo & Record<string, unknown> & { contenido: string | null };
        return {
          id: x.id, version: Number(x.version), autor: String(x.autor), estado: String(x.estado), rotulo: (x.rotulo as string) ?? null,
          aviso: avisoAnexoResumen({ modelo: x.modelo as string, listo_at: x.listo_at as string, autor: x.autor as string }),
          modelo: (x.modelo as string) ?? null, prompt_version: (x.prompt_version as string) ?? null, listo_at: (x.listo_at as string) ?? null,
          oculto_at: (x.oculto_at as string) ?? null, archivado_at: x.archivado_at ?? null, contenido: x.contenido,
          ...(x.estado === 'listo' && x.contenido == null ? { error_lectura: true } : {}),
        };
      }),
      transcripcion, transcripcion_error: trError,
    });
  }

  // Bitácora de accesos: por paciente y por sus grabaciones (sin contenido clínico por diseño).
  const [{ data: b1, error: eb1 }, { data: b2, error: eb2 }] = await Promise.all([
    db.from('transcriptor_auditoria').select('*').eq('patient_id', patientId).order('at', { ascending: true }).limit(20000),
    ids.length ? db.from('transcriptor_auditoria').select('*').in('grabacion_id', ids).order('at', { ascending: true }).limit(20000) : Promise.resolve({ data: [], error: null }),
  ]);
  err('transcriptor_auditoria', eb1 ?? eb2);
  const vistas = new Set<unknown>();
  const bitacora = [...(b1 ?? []), ...(b2 ?? [])]
    .filter((a: Record<string, unknown>) => (vistas.has(a.id) ? false : (vistas.add(a.id), true)))
    .filter((a: Record<string, unknown>) => !anio || String(a.at ?? '').startsWith(`${anio}-`) || a.accion === 'exportar')
    .sort((a: Record<string, unknown>, b: Record<string, unknown>) => String(a.at).localeCompare(String(b.at)))
    .map((a: Record<string, unknown>) => ({
      at: String(a.at), actor: String(a.actor), accion: String(a.accion), resultado: String(a.resultado ?? 'ok'), grabacion_id: (a.grabacion_id as string) ?? null,
      ip: (a.ip as string) ?? null, dispositivo: (a.user_agent as string) ?? null, detalle: a.detalle ?? null,
    }));

  return {
    version: VERSION_EXPORTACION,
    generado_at: (deps.ahora ?? (() => new Date()))().toISOString(),
    alcance: { anio },
    paciente,
    consentimientos,
    anexos_consentimiento: anexos,
    notas,
    sesiones_agendadas: agendadas,
    sesiones_grabadas: sesiones,
    bitacora,
    avisos,
  };
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

const ETIQUETA_TIPO: Record<string, string> = {
  online: 'Individual online', presencial: 'Individual presencial', 'pareja-online': 'Pareja online', 'pareja-presencial': 'Pareja presencial',
};
const AUTORIZACIONES: [string, string][] = [['accept_treatment', 'Atención y tratamiento de datos'], ['accept_recording', 'Grabación y transcripción de sesiones'], ['accept_case_review', 'Revisión anónima de casos']];

/** Bloques del PDF: secciones fijas y, en el historial, todo ordenado por fecha. */
export function documentoPdf(f: FichaExportada): BloquePdf[] {
  const B: BloquePdf[] = [];
  const h2 = (t: string) => B.push({ tipo: 'h2', texto: t });
  const h3 = (t: string) => B.push({ tipo: 'h3', texto: t });
  const par = (t: string, sangria = 0) => B.push({ tipo: 'parrafo', texto: t, sangria });
  const meta = (t: string, sangria = 0) => B.push({ tipo: 'meta', texto: t, sangria });
  const pac = f.paciente;

  B.push({ tipo: 'titulo', texto: 'Ficha clínica completa' });
  par(String(pac.name ?? ''));
  meta(`Exportada el ${fechaHoraCL(f.generado_at)} · ${f.alcance.anio ? `Solo el año ${f.alcance.anio} (consentimientos completos)` : 'Todo el historial'} · formato ${f.version}`);
  meta('Documento confidencial: datos sensibles de salud (Ley 21.719 y Ley 20.584). Responsable: Ps. Valentina Orellana.');
  meta('Contenido: 1. Datos de la ficha · 2. Consentimientos y anexos · 3. Historial por fecha (notas de evolución, resúmenes automáticos y transcripciones completas) · 4. Bitácora de accesos.');
  if (f.avisos.length) { h3('Avisos de esta exportación'); for (const a of f.avisos) par(`• ${a}`); }

  h2('1. Datos de la ficha');
  const campos: [string, string][] = [
    ['name', 'Nombre'], ['rut', 'RUT'], ['doc_tipo', 'Documento'], ['doc_numero', 'Número de documento'], ['doc_pais', 'País del documento'],
    ['birthdate', 'Fecha de nacimiento'], ['email', 'Correo'], ['phone', 'Teléfono'], ['address', 'Dirección'], ['comuna', 'Comuna'],
    ['emergency_name', 'Contacto de emergencia'], ['emergency_phone', 'Teléfono de emergencia'], ['created_at', 'Ficha creada'],
  ];
  for (const [k, et] of campos) if (pac[k]) par(`${et}: ${k === 'created_at' ? fechaHoraCL(String(pac[k])) : k === 'birthdate' ? fechaCL(String(pac[k])) : String(pac[k])}`);
  if (pac.notes) { h3('Notas generales'); par(String(pac.notes)); }

  h2('2. Consentimientos y anexos');
  if (!f.consentimientos.length) par('No hay consentimientos registrados.');
  const firmados = [...f.consentimientos].sort((a, b) => String(a.signed_at ?? a.created_at).localeCompare(String(b.signed_at ?? b.created_at)));
  for (const c of firmados) {
    h3(`${c.signed_at ? `Firmado el ${fechaHoraCL(String(c.signed_at))}` : `Enviado sin firmar (${fechaHoraCL(String(c.sent_at ?? c.created_at))})`} · ${String(c.signer_name ?? 'sin nombre')}`);
    meta(`Versión ${c.version ?? '—'} · RUT ${c.signer_rut ?? '—'} · correo ${c.signer_email ?? '—'} · IP ${c.ip ?? '—'} · id ${c.id}`);
    if (c.user_agent) meta(`Dispositivo: ${c.user_agent}`);
    meta(`Huella SHA-256 del texto: ${c.text_sha256 ?? '—'} · verificación: ${c.verificacion_texto === 'integro' ? 'íntegro (coincide con lo firmado)' : c.verificacion_texto === 'NO_COINCIDE' ? 'NO COINCIDE con la huella guardada al firmar' : 'sin texto guardado'}`);
    for (const [k, et] of AUTORIZACIONES) if (k in c) par(`${et}: ${c[k] ? 'sí autoriza' : 'no autoriza'}`, 8);
    if (c.recording_revoked_at) par(`Retiro solo de la grabación: ${fechaHoraCL(String(c.recording_revoked_at))}${c.recording_revoked_via ? ` (por ${c.recording_revoked_via})` : ''}${c.recording_revoked_note ? ` — ${c.recording_revoked_note}` : ''}`, 8);
    if (c.revoked_at) par(`Retiro del consentimiento: ${fechaHoraCL(String(c.revoked_at))}${c.revoked_note ? ` — ${c.revoked_note}` : ''}`, 8);
    if (c.texto_firmado) { meta('Texto exacto aceptado:'); B.push({ tipo: 'mono', texto: String(c.texto_firmado), sangria: 8 }); }
    for (const a of f.anexos_consentimiento.filter((x) => x.consent_id === c.id)) {
      if (a.tipo === 'copia_correo_aviso') {
        par(`Anexo: copia fiel del correo "${a.asunto ?? ''}" enviado a ${a.destinatario ?? '—'} el ${fechaHoraCL(String(a.enviado_at))}`, 8);
        meta(`Huella SHA-256 del correo: ${a.html_sha256 ?? '—'} · verificación: ${a.verificacion_html === 'integro' ? 'íntegro' : a.verificacion_html === 'NO_COINCIDE' ? 'NO COINCIDE' : 'sin copia'}`, 8);
        if (a.texto_correo) B.push({ tipo: 'mono', texto: String(a.texto_correo), sangria: 16 });
      } else {
        par(`Anexo: aviso de cambio de consentimiento mostrado el ${fechaHoraCL(String(a.mostrado_at))} por ${a.canal ?? '—'} (texto ${a.texto_version ?? '—'}).`, 8);
      }
    }
    B.push({ tipo: 'separador' });
  }

  h2('3. Historial por fecha');
  meta('Por cada fecha: la sesión agendada, la nota de evolución de la psicóloga, el resumen automático (IA, anexo no revisado) y la transcripción completa. Los resúmenes automáticos nunca reemplazan la nota de evolución.');
  const fechas = [...new Set([...f.notas.map((n) => n.fecha), ...f.sesiones_grabadas.map((s) => s.fecha), ...f.sesiones_agendadas.map((s) => s.fecha)])].filter(Boolean).sort();
  if (!fechas.length) par('No hay sesiones, notas ni grabaciones en este período.');
  for (const fecha of fechas) {
    h3(fechaCL(fecha));
    for (const a of f.sesiones_agendadas.filter((s) => s.fecha === fecha)) meta(`Sesión agendada${a.hora ? ` ${a.hora}` : ''} · ${a.titulo || ETIQUETA_TIPO[a.tipo ?? ''] || a.tipo || '—'} · ${a.estado ?? '—'}`);
    for (const n of f.notas.filter((x) => x.fecha === fecha)) {
      par(`Nota de evolución${n.tipo ? ` (${ETIQUETA_TIPO[n.tipo] ?? n.tipo})` : ''}${n.archivada_at ? ` — archivada el ${fechaHoraCL(n.archivada_at)} (se conserva)` : ''}`);
      B.push({ tipo: 'mono', texto: n.contenido, sangria: 10 });
    }
    for (const s of f.sesiones_grabadas.filter((x) => x.fecha === fecha)) {
      meta(`Sesión grabada · ${s.tipo === 'pareja' ? 'pareja' : s.tipo === 'individual' ? 'individual' : 'sin tipo'} ${s.origen} · inicio ${fechaHoraCL(s.inicio_at)}${s.duracion_seg ? ` · ${Math.round(s.duracion_seg / 60)} min` : ''} · estado ${s.estado} · consentimientos ${s.consent_ids.join(', ') || '—'}`);
      if (s.excluida_de_ia) meta(`Excluida de las preguntas a la IA el ${fechaHoraCL(s.excluida_de_ia.at)} (${s.excluida_de_ia.motivo ?? 'sin motivo'})`);
      for (const r of s.resumenes.filter((x) => x.estado === 'listo')) {
        par(`Resumen automático (IA) · versión ${r.version}${r.autor === 'vale' ? ' (editada por la psicóloga)' : ''}${r.oculto_at ? ` · oculto el ${fechaHoraCL(r.oculto_at)}` : ''}`, 10);
        meta(r.aviso, 10);
        B.push({ tipo: 'mono', texto: r.contenido != null ? resumenATexto(r.contenido) : '[No se pudo abrir este resumen al exportar]', sangria: 18 });
      }
      if (s.transcripcion) {
        par(`Transcripción completa (automática; puede tener errores) · ${s.transcripcion.lineas.filter((l) => l.tipo === 'tramo').length} intervenciones${s.transcripcion.copia_b2 ? ' · con copia de respaldo' : ''}`, 10);
        for (const l of s.transcripcion.lineas) {
          B.push({ tipo: 'mono', texto: l.tipo === 'pausa' ? `[${l.inicio}] — ${l.texto} —` : `[${l.inicio}] ${l.hablante ? `${l.hablante}: ` : ''}${l.texto}`, sangria: 18 });
        }
      } else if (s.transcripcion_error) {
        par(s.transcripcion_error, 10);
      }
    }
    B.push({ tipo: 'separador' });
  }

  h2('4. Bitácora de accesos');
  meta('Registro inmutable de quién vio, preguntó, exportó o procesó contenido de esta ficha en el transcriptor (sin contenido clínico).');
  if (!f.bitacora.length) par('Sin registros.');
  for (const a of f.bitacora) {
    const det = a.detalle && typeof a.detalle === 'object' ? Object.entries(a.detalle as Record<string, unknown>).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ') : '';
    B.push({ tipo: 'mono', texto: `${fechaHoraCL(a.at)} · ${a.actor} · ${a.accion} · ${a.resultado}${a.ip ? ` · IP ${a.ip}` : ''}${det ? ` · ${det}` : ''}` });
  }
  return B;
}

// ─── Armado del archivo ──────────────────────────────────────────────────────

export function slug(t: string): string {
  return (t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'paciente';
}

export interface ArchivoExportado { bytes: Uint8Array; contentType: string; nombre: string; resumen: { sesiones: number; transcripciones: number; resumenes: number; notas: number; consentimientos: number; avisos: number } }

export function armarArchivo(f: FichaExportada, formato: FormatoExportacion): ArchivoExportado {
  const hoy = f.generado_at.slice(0, 10);
  const base = `ficha-completa-${slug(String(f.paciente.name ?? ''))}-${f.alcance.anio ?? 'todo'}-${hoy}`;
  const json = () => new TextEncoder().encode(JSON.stringify(f, null, 2));
  const pdf = () => generarPdf(documentoPdf(f), {
    titulo: `Ficha clínica completa — ${f.paciente.name ?? ''}`, autor: 'Ps. Valentina Orellana',
    pie: `Ficha de ${f.paciente.name ?? ''} · exportada ${fechaHoraCL(f.generado_at)} · confidencial`, creado: new Date(f.generado_at),
  });
  const resumen = {
    sesiones: f.sesiones_grabadas.length,
    transcripciones: f.sesiones_grabadas.filter((s) => s.transcripcion).length,
    resumenes: f.sesiones_grabadas.reduce((n, s) => n + s.resumenes.filter((r) => r.estado === 'listo').length, 0),
    notas: f.notas.length,
    consentimientos: f.consentimientos.length,
    avisos: f.avisos.length,
  };
  if (formato === 'json') return { bytes: json(), contentType: 'application/json; charset=utf-8', nombre: `${base}.json`, resumen };
  if (formato === 'pdf') return { bytes: pdf(), contentType: 'application/pdf', nombre: `${base}.pdf`, resumen };
  const leeme = new TextEncoder().encode([
    'Ficha clínica completa — exportación legal',
    `Exportada: ${fechaHoraCL(f.generado_at)}`,
    '',
    'ficha.pdf  : documento legible, ordenado por fecha (consentimientos, notas, resúmenes IA, transcripciones, bitácora).',
    'datos.json : los mismos datos estructurados (para peritajes o traspaso a otro sistema).',
    '',
    'Contiene datos sensibles de salud. Guárdalo en un lugar seguro y no lo envíes por canales no cifrados.',
  ].join('\n'));
  return {
    bytes: crearZip([{ nombre: 'ficha.pdf', datos: pdf() }, { nombre: 'datos.json', datos: json() }, { nombre: 'LEEME.txt', datos: leeme }], new Date(f.generado_at)),
    contentType: 'application/zip', nombre: `${base}.zip`, resumen,
  };
}
