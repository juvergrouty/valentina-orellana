// Seguimientos automáticos (aprobado por Vale el 18 nov 2026): lectura de datos, plan y envío.
// Las reglas están en reglas.ts (puras, con pruebas); los textos en textos.ts.
//
// Lo usan:
//  - /api/cron/seguimientos (cada 5 min desde Supabase pg_cron): ejecutarSeguimientos().
//  - /api/webhooks/whatsapp: registrarEventosWhatsapp().
//  - /admin/seguimientos y el aviso del panel: planSeguimientos() (lo mismo que enviaría la tarea).
//
// Nunca dos veces: cada paso es una fila única (clave, paso, referencia) en seguimiento_envios que se
// toma ANTES de enviar. Si la migración 0027 no está aplicada, todo se omite sin romper nada.
import { supabase } from '../supabase';
import { logError, logInfo } from '../logger';
import { todayCL, nowCL } from '../dateUtils';
import { listaFeriados, FERIADOS_CONFIRMADOS } from '../feriados';
import { getWhatsappConfig, sendWhatsappText, sendWhatsappTemplate, estadoPlantillas } from '../whatsapp';
import { sendSeguimientoEmail, sendResumenSeguimientos, ADMIN_EMAIL_FALLBACK, type LineaResumen } from '../email';
import {
  pasoConsulta, pasoPaciente, cobroPendienteVencido, elegirCanal, enviadosRecientes, sePuedeReintentar,
  enHorarioDeEnvio, fechaEnPalabras, primerNombre, mismoTelefono, normalizarCorreo, normalizarTelefono,
  diasEntre, TOPE_MENSAJES, type Canal, type Consulta,
} from './reglas';
import { textoWhatsapp, plantillaDe, variablesPlantilla, IDIOMA_PLANTILLAS, NOMBRE_PASO, type Paso, type DatosTexto } from './textos';
import type { EventoWhatsapp } from './webhookWhatsapp';

const SITIO = 'https://www.valentinaorellana.cl';

export type Persona = {
  id: string; tipo: 'consulta' | 'paciente'; nombre: string | null; telefono: string | null; email: string | null;
  patient_id: string | null; origen: string; codigo: string | null; no_escribir: boolean;
  ultimo_entrante_at: string | null; ultima_respuesta_vale_at: string | null; estado: Consulta['estado']; creado_at: string;
};
export type Envio = {
  id: number; clave: string; paso: string; referencia: string; estado: string; canal: string | null;
  telefono: string | null; email: string | null; nombre: string | null; motivo: string | null;
  intentos: number; tomada_en: string | null; enviado_at: string | null; creado_at: string;
};
type Reserva = {
  id: string; patient_name: string; patient_email: string | null; patient_phone: string | null;
  session_date: string; session_time: string | null; status: string; paid_at: string | null; debt_voided: boolean | null;
  amount: number | null; no_show: boolean | null; payment_note: string | null; notes: string | null; payment_method: string | null;
};
type Ficha = { id: string; name: string | null; email: string | null; phone: string | null; active: boolean };

/** Un mensaje que corresponde enviar (o que no se puede, con su motivo). */
export type Candidato = {
  clave: string; paso: Paso; referencia: string; nombre: string; email: string | null; telefono: string | null;
  ultimoEntrante: string | null; datos: DatosTexto; personaId?: string; agrupadas?: string[]; envioId?: number;
};
export type Pausa = { envioId: number | null; patientId: string; nombre: string; ultima: string; dias: number; estado: string; texto: string };
export type FilaConsulta = Persona & { motivo: string };
export type FilaPaciente = { patientId: string; nombre: string; detalle: string; noEscribir: boolean };

export type Plan = {
  listo: boolean;               // migración 0027 aplicada
  activo: boolean;              // interruptor en /admin/seguimientos
  candidatos: Candidato[];
  pausas: Pausa[];
  consultas: FilaConsulta[];
  pacientes: FilaPaciente[];    // pacientes con 2A o 3A, o con "No escribir"
  envios: Envio[];
  cambiosEstado: { id: string; estado: Consulta['estado'] }[];
};

export async function seguimientosActivos(): Promise<boolean> {
  const { data } = await supabase.from('settings').select('value').eq('key', 'seguimientos_activos').maybeSingle();
  return data?.value === 'true';
}

const tablaFalta = (e: { code?: string; message?: string } | null) => !!e && (e.code === '42P01' || /does not exist|schema cache/i.test(e.message ?? ''));

/** Lo que correspondería hacer ahora (lo mismo que ve el panel). */
export async function planSeguimientos(ahora = Date.now()): Promise<Plan> {
  const vacio: Plan = { listo: false, activo: false, candidatos: [], pausas: [], consultas: [], pacientes: [], envios: [], cambiosEstado: [] };
  const hoy = todayCL(new Date(ahora));
  const desde = new Date(ahora - 400 * 86400e3).toISOString().slice(0, 10);

  const [pers, env, res, fic, activo] = await Promise.all([
    supabase.from('seguimiento_personas').select('*').order('creado_at', { ascending: false }).limit(2000),
    supabase.from('seguimiento_envios').select('*').order('creado_at', { ascending: false }).limit(5000),
    supabase.from('bookings')
      .select('id, patient_name, patient_email, patient_phone, session_date, session_time, status, paid_at, debt_voided, amount, no_show, payment_note, notes, payment_method')
      .in('status', ['confirmed', 'pending_payment']).gte('session_date', desde).limit(10000),
    supabase.from('patients').select('id, name, email, phone, active').limit(5000),
    seguimientosActivos(),
  ]);
  if (tablaFalta(pers.error) || tablaFalta(env.error)) return vacio;
  if (pers.error || env.error || res.error || fic.error) {
    throw new Error(pers.error?.message ?? env.error?.message ?? res.error?.message ?? fic.error?.message);
  }
  const personas = (pers.data ?? []) as Persona[];
  const envios = (env.data ?? []) as Envio[];
  const reservas = (res.data ?? []) as Reserva[];
  const fichas = (fic.data ?? []) as Ficha[];

  const plan: Plan = { ...vacio, listo: true, activo, envios };
  const enviosDe = (clave: string) => envios.filter((e) => e.clave === clave);
  const existe = (clave: string, paso: string, ref: string) => envios.find((e) => e.clave === clave && e.paso === paso && e.referencia === ref);
  // Un paso ya registrado solo vuelve a la lista si falló y le quedan intentos (nunca dos veces).
  const yaTomado = (clave: string, paso: string, ref: string) => { const f = existe(clave, paso, ref); return !!f && !sePuedeReintentar(f); };
  const bloqueada = (pid: string) => personas.some((p) => p.patient_id === pid && p.no_escribir);

  // ── Secuencia 1: consultas nuevas ──
  for (const p of personas.filter((x) => x.tipo === 'consulta')) {
    const correo = normalizarCorreo(p.email);
    const esPersona = (email: string | null, tel: string | null) => (!!correo && normalizarCorreo(email) === correo) || (!!p.telefono && mismoTelefono(tel, p.telefono));
    // Agendó: cualquier hora confirmada o por pagar, o ya tiene ficha de paciente.
    const agendo = reservas.some((b) => esPersona(b.patient_email, b.patient_phone)) || fichas.some((f) => esPersona(f.email, f.phone));
    const clave = `consulta:${p.id}`;
    const d = pasoConsulta(p, enviosDe(clave).map((e) => ({ paso: e.paso, enviado_at: e.estado === 'enviado' ? e.enviado_at : null })), agendo, ahora);
    if (d.nuevoEstado && d.nuevoEstado !== p.estado) plan.cambiosEstado.push({ id: p.id, estado: d.nuevoEstado });
    plan.consultas.push({ ...p, estado: d.nuevoEstado ?? p.estado, motivo: d.motivo });
    if (d.paso && !yaTomado(clave, d.paso, '')) {
      plan.candidatos.push({ clave, paso: d.paso, referencia: '', nombre: p.nombre ?? '', email: p.email, telefono: p.telefono, ultimoEntrante: p.ultimo_entrante_at, datos: { nombre: primerNombre(p.nombre) }, personaId: p.id });
    }
  }

  // ── Secuencias 2 y 3: pacientes activas ──
  const porCorreo = new Map<string, Reserva[]>();
  for (const b of reservas) {
    const c = normalizarCorreo(b.patient_email);
    if (c) porCorreo.set(c, [...(porCorreo.get(c) ?? []), b]);
  }
  for (const f of fichas) {
    const correo = normalizarCorreo(f.email);
    if (!correo) continue;
    if (bloqueada(f.id)) { plan.pacientes.push({ patientId: f.id, nombre: f.name ?? '', detalle: 'Marcada «No escribir»', noEscribir: true }); continue; }
    if (!f.active) continue; // dada de baja / alta: nunca
    const d = pasoPaciente(porCorreo.get(correo) ?? [], hoy);
    if (!d.tipo) continue;
    const clave = `paciente:${f.id}`;
    const nombre = f.name ?? '';
    if (d.tipo === '2A') {
      plan.pacientes.push({ patientId: f.id, nombre, detalle: `Última sesión hace ${d.dias} días (suele venir cada ${d.intervalo})`, noEscribir: false });
      if (!yaTomado(clave, '2A', d.referencia)) {
        plan.candidatos.push({ clave, paso: '2A', referencia: d.referencia, nombre, email: f.email, telefono: f.phone, ultimoEntrante: null, datos: { nombre: primerNombre(nombre) } });
      }
    } else {
      const fila = existe(clave, '3A', d.referencia);
      if (!fila || ['por_aprobar', 'aprobado'].includes(fila.estado)) {
        plan.pausas.push({ envioId: fila?.id ?? null, patientId: f.id, nombre, ultima: d.ultima, dias: d.dias, estado: fila?.estado ?? 'nueva', texto: textoWhatsapp('3A', { nombre: primerNombre(nombre) }) });
      }
      if (fila?.estado === 'aprobado') {
        plan.candidatos.push({ clave, paso: '3A', referencia: d.referencia, nombre, email: f.email, telefono: f.phone, ultimoEntrante: null, datos: { nombre: primerNombre(nombre) }, envioId: fila.id });
      }
    }
  }

  // ── Secuencia 4: sesión pasada sin pagar (2 a 7 días después) ──
  const vencidas = reservas.filter((b) => cobroPendienteVencido(b, hoy));
  const grupos = new Map<string, Reserva[]>();
  for (const b of vencidas) {
    const c = normalizarCorreo(b.patient_email);
    if (c) grupos.set(c, [...(grupos.get(c) ?? []), b]);
  }
  for (const [correo, lista] of grupos) {
    const f = fichas.find((x) => normalizarCorreo(x.email) === correo);
    // Sin ficha no hay enlace /pagar/<ficha> (que cobra todo lo pendiente en vivo): no se envía.
    if (!f || !f.active || bloqueada(f.id)) continue;
    const clave = `paciente:${f.id}`;
    const pendientes = lista.filter((b) => !yaTomado(clave, '4A', b.id)).sort((a, b) => b.session_date.localeCompare(a.session_date));
    if (!pendientes.length) continue;
    const [b, ...resto] = pendientes;
    plan.candidatos.push({
      clave, paso: '4A', referencia: b.id, nombre: f.name ?? b.patient_name, email: f.email, telefono: f.phone ?? b.patient_phone, ultimoEntrante: null,
      datos: { nombre: primerNombre(f.name ?? b.patient_name), fecha: fechaEnPalabras(b.session_date), enlace: `${SITIO}/pagar/${f.id}` },
      agrupadas: resto.map((x) => x.id),
    });
  }
  return plan;
}

// ─── Tomar y cerrar una fila (nunca dos veces) ───────────────────────────────

async function tomarPaso(c: Candidato, canal: Canal): Promise<number | null> {
  const ahoraIso = new Date().toISOString();
  const fila = { clave: c.clave, paso: c.paso, referencia: c.referencia, estado: 'en_curso', canal, telefono: normalizarTelefono(c.telefono), email: normalizarCorreo(c.email), nombre: c.nombre.slice(0, 120) || null, tomada_en: ahoraIso, intentos: 1 };
  const ins = await supabase.from('seguimiento_envios').insert(fila).select('id').maybeSingle();
  if (!ins.error && ins.data) return ins.data.id as number;
  if (ins.error && ins.error.code !== '23505') {
    await logError('seguimientos/reservar', 'No se pudo registrar un seguimiento; se omite para no duplicarlo', { clave: c.clave, paso: c.paso, error: ins.error.message });
    return null;
  }
  const { data: f } = await supabase.from('seguimiento_envios').select('id, estado, intentos, tomada_en').eq('clave', c.clave).eq('paso', c.paso).eq('referencia', c.referencia).maybeSingle();
  if (!f || !sePuedeReintentar(f)) return null;
  // Toma condicionada: si otro proceso la tomó entre medio, no calza y no se envía.
  const { data: tomada } = await supabase.from('seguimiento_envios')
    .update({ estado: 'en_curso', canal, tomada_en: ahoraIso, intentos: f.intentos + (f.estado === 'aprobado' ? 0 : 1) })
    .eq('id', f.id).eq('estado', f.estado).eq('intentos', f.intentos).select('id');
  return tomada?.length ? (f.id as number) : null;
}

async function cerrarPaso(id: number, ok: boolean, motivo?: string) {
  await supabase.from('seguimiento_envios')
    .update(ok ? { estado: 'enviado', enviado_at: new Date().toISOString(), motivo: null } : { estado: 'error', motivo: (motivo ?? 'error').slice(0, 500) })
    .eq('id', id);
}

async function enviar(c: Candidato, canal: Canal): Promise<{ sent: boolean; reason?: string }> {
  if (canal === 'correo') return sendSeguimientoEmail(c.paso, normalizarCorreo(c.email)!, c.datos, { idempotencyKey: `seguimiento:${c.clave}:${c.paso}:${c.referencia}` });
  if (canal === 'whatsapp_texto') return sendWhatsappText(c.telefono!, textoWhatsapp(c.paso, c.datos));
  return sendWhatsappTemplate(c.telefono!, plantillaDe(c.paso).nombre, IDIOMA_PLANTILLAS, variablesPlantilla(c.paso, c.datos));
}

// ─── Tarea programada ────────────────────────────────────────────────────────

export type ResultadoEjecucion = {
  ok: true; listo: boolean; activo: boolean; enHorario: boolean;
  enviados: { clave: string; paso: string; canal: string }[];
  omitidos: { clave: string; paso: string; motivo: string }[];
  errores: { clave: string; paso: string; motivo: string }[];
  pausasNuevas: number; resumen: string;
};

export async function ejecutarSeguimientos(ahora = Date.now()): Promise<ResultadoEjecucion> {
  const out: ResultadoEjecucion = { ok: true, listo: false, activo: false, enHorario: false, enviados: [], omitidos: [], errores: [], pausasNuevas: 0, resumen: 'no' };
  const plan = await planSeguimientos(ahora);
  out.listo = plan.listo; out.activo = plan.activo;
  if (!plan.listo || !plan.activo) return out;

  // Estados derivados (agendó / respondió / no siguió) quedan guardados para el panel.
  for (const c of plan.cambiosEstado) {
    await supabase.from('seguimiento_personas').update({ estado: c.estado, actualizado_at: new Date().toISOString() }).eq('id', c.id);
  }

  // Pausas: se crean "por aprobar" (nunca se envían solas). Las que ya no corresponden (agendó, etc.) se descartan.
  for (const p of plan.pausas.filter((x) => x.envioId === null)) {
    const r = await supabase.from('seguimiento_envios').insert({ clave: `paciente:${p.patientId}`, paso: '3A', referencia: p.ultima, estado: 'por_aprobar', nombre: p.nombre.slice(0, 120) });
    if (!r.error) out.pausasNuevas++;
  }
  const vigentes = new Set(plan.pausas.map((p) => `paciente:${p.patientId}|${p.ultima}`));
  for (const e of plan.envios.filter((x) => x.paso === '3A' && ['por_aprobar', 'aprobado'].includes(x.estado) && !vigentes.has(`${x.clave}|${x.referencia}`))) {
    await supabase.from('seguimiento_envios').update({ estado: 'descartado', motivo: 'Ya no corresponde (agendó o cambió su situación)' }).eq('id', e.id).eq('estado', e.estado);
  }

  let feriados: Set<string>;
  try { feriados = new Set((await listaFeriados()).map((f) => f.fecha)); } catch { feriados = new Set(FERIADOS_CONFIRMADOS.map((f) => f.fecha)); }
  out.enHorario = enHorarioDeEnvio(nowCL(new Date(ahora)), feriados);

  if (out.enHorario && plan.candidatos.length) {
    const wa = await getWhatsappConfig().catch(() => null);
    const necesitaPlantillas = !!wa && plan.candidatos.some((c) => !normalizarCorreo(c.email));
    const plantillas = necesitaPlantillas ? await estadoPlantillas() : null;
    // El tope se cuenta con lo ya enviado + lo que sale en esta misma vuelta.
    const registro = [...plan.envios];
    for (const c of plan.candidatos) {
      if (c.paso !== '3A' && enviadosRecientes(registro, normalizarTelefono(c.telefono), c.email, ahora) >= TOPE_MENSAJES) {
        out.omitidos.push({ clave: c.clave, paso: c.paso, motivo: `Tope de ${TOPE_MENSAJES} mensajes automáticos` });
        continue;
      }
      const nombrePlantilla = plantillaDe(c.paso).nombre;
      const elegido = elegirCanal({
        email: c.email, telefono: c.telefono, whatsappConectado: !!wa, ultimoEntrante: c.ultimoEntrante, ahora,
        plantillaAprobada: !!c.datos.nombre && plantillas?.get(nombrePlantilla) === 'APPROVED',
      });
      if (!elegido.canal) { out.omitidos.push({ clave: c.clave, paso: c.paso, motivo: elegido.motivo }); continue; }
      const id = await tomarPaso(c, elegido.canal);
      if (id === null) { out.omitidos.push({ clave: c.clave, paso: c.paso, motivo: 'Ya enviado o en curso' }); continue; }
      const r = await enviar(c, elegido.canal).catch((e) => ({ sent: false, reason: e instanceof Error ? e.message : String(e) }));
      await cerrarPaso(id, r.sent, r.reason);
      if (r.sent) {
        out.enviados.push({ clave: c.clave, paso: c.paso, canal: elegido.canal });
        registro.push({ id, clave: c.clave, paso: c.paso, referencia: c.referencia, estado: 'enviado', canal: elegido.canal, telefono: normalizarTelefono(c.telefono), email: normalizarCorreo(c.email), nombre: c.nombre, motivo: null, intentos: 1, tomada_en: null, enviado_at: new Date().toISOString(), creado_at: new Date().toISOString() });
        if (c.paso === '1B' && c.personaId) await supabase.from('seguimiento_personas').update({ estado: 'no_siguio', actualizado_at: new Date().toISOString() }).eq('id', c.personaId);
        // Las otras sesiones sin pagar de la misma persona van en el mismo enlace: no se avisa de nuevo por cada una.
        for (const ref of c.agrupadas ?? []) {
          await supabase.from('seguimiento_envios').insert({ clave: c.clave, paso: '4A', referencia: ref, estado: 'omitido', motivo: `Incluida en el aviso del ${todayCL(new Date(ahora))}`, nombre: c.nombre.slice(0, 120) });
        }
        await logInfo('seguimientos/envio', `Seguimiento ${c.paso} enviado`, { clave: c.clave, paso: c.paso, canal: elegido.canal });
      } else {
        out.errores.push({ clave: c.clave, paso: c.paso, motivo: r.reason ?? 'error' });
        await logError('seguimientos/envio', `No se pudo enviar el seguimiento ${c.paso}`, { clave: c.clave, paso: c.paso, canal: elegido.canal, motivo: r.reason });
      }
    }
  }

  out.resumen = await quizasEnviarResumen(ahora);
  return out;
}

// ─── Resumen diario a Vale (desde las 20:00, una vez al día, solo si hay algo nuevo) ─────────

const CANAL_TEXTO: Record<string, string> = { correo: 'Correo', whatsapp_texto: 'WhatsApp', whatsapp_plantilla: 'WhatsApp (plantilla)' };

async function quizasEnviarResumen(ahora: number): Promise<string> {
  const reloj = nowCL(new Date(ahora));
  if (reloj.getHours() < 20) return 'no: antes de las 20:00';
  const hoy = todayCL(new Date(ahora));
  const { data } = await supabase.from('seguimiento_envios').select('paso, referencia, estado, canal, nombre, enviado_at, creado_at')
    .or(`estado.eq.por_aprobar,enviado_at.gte."${new Date(ahora - 30 * 3600e3).toISOString()}"`).limit(1000);
  const filas = (data ?? []) as Pick<Envio, 'paso' | 'referencia' | 'estado' | 'canal' | 'nombre' | 'enviado_at' | 'creado_at'>[];
  const deHoy = (iso: string | null) => !!iso && todayCL(new Date(iso)) === hoy;
  const enviados = filas.filter((f) => f.estado === 'enviado' && f.paso !== 'resumen' && deHoy(f.enviado_at));
  const porAprobar = filas.filter((f) => f.estado === 'por_aprobar');
  if (!enviados.length && !porAprobar.some((f) => deHoy(f.creado_at))) return 'no: nada nuevo hoy';

  const clave = 'resumen';
  const ins = await supabase.from('seguimiento_envios').insert({ clave, paso: 'resumen', referencia: hoy, estado: 'en_curso', tomada_en: new Date().toISOString() }).select('id').maybeSingle();
  if (ins.error || !ins.data) return 'no: ya enviado hoy';
  const { data: notif } = await supabase.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  const adminEmail = notif?.value || ADMIN_EMAIL_FALLBACK;
  const lineas: LineaResumen[] = enviados.map((f) => ({
    nombre: f.nombre ?? 'Sin nombre', paso: NOMBRE_PASO[f.paso as Paso] ?? f.paso, canal: CANAL_TEXTO[f.canal ?? ''] ?? '',
    hora: f.enviado_at ? new Date(f.enviado_at).toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit' }) : undefined,
  }));
  const pausas = porAprobar.map((f) => ({ nombre: f.nombre ?? 'Sin nombre', dias: diasEntre(f.referencia, hoy) }));
  const r = await sendResumenSeguimientos(adminEmail, { fecha: fechaEnPalabras(hoy), enviados: lineas, porAprobar: pausas, urlPanel: `${SITIO}/admin/seguimientos` }, { idempotencyKey: `seguimientos-resumen:${hoy}` });
  await cerrarPaso(ins.data.id as number, r.sent, r.reason);
  return r.sent ? 'enviado' : `error: ${r.reason}`;
}

// ─── Aviso (webhook) de WhatsApp ─────────────────────────────────────────────

const masTarde = (a: string | null, b: string) => (!a || Date.parse(b) > Date.parse(a) ? b : a);

/** Guarda solo metadatos. Crea una consulta SOLO si el mensaje vino de un anuncio o trae el código del sitio. */
export async function registrarEventosWhatsapp(eventos: EventoWhatsapp[]): Promise<{ guardados: number; listo: boolean }> {
  let guardados = 0;
  for (const ev of eventos) {
    const { data: existente, error } = await supabase.from('seguimiento_personas').select('id, nombre, ultimo_entrante_at, ultima_respuesta_vale_at').eq('telefono', ev.telefono).maybeSingle();
    if (tablaFalta(error)) return { guardados, listo: false };
    if (error) throw new Error(error.message);
    const ahoraIso = new Date().toISOString();
    if (ev.tipo === 'respuesta_vale') {
      // Sus respuestas a quien no está en seguimiento (familia, amigos, pacientes) no se guardan.
      if (!existente) continue;
      await supabase.from('seguimiento_personas').update({ ultima_respuesta_vale_at: masTarde(existente.ultima_respuesta_vale_at, ev.at), actualizado_at: ahoraIso }).eq('id', existente.id);
      guardados++;
      continue;
    }
    if (existente) {
      await supabase.from('seguimiento_personas').update({ ultimo_entrante_at: masTarde(existente.ultimo_entrante_at, ev.at), nombre: existente.nombre ?? ev.nombre, actualizado_at: ahoraIso }).eq('id', existente.id);
      guardados++;
      continue;
    }
    if (!ev.anuncio && !ev.codigo) continue; // nunca familia ni amigos: sin anuncio ni código no entra
    const ins = await supabase.from('seguimiento_personas').insert({
      tipo: 'consulta', nombre: ev.nombre, telefono: ev.telefono, origen: ev.anuncio ? 'anuncio' : 'codigo', codigo: ev.codigo, ultimo_entrante_at: ev.at,
    });
    if (ins.error && ins.error.code !== '23505') throw new Error(ins.error.message);
    guardados++;
  }
  return { guardados, listo: true };
}

export { NOMBRE_PASO };
