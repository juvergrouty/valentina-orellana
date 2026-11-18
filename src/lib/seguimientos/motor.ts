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
// Las sesiones salen de `bookings` Y de Google Calendar (las de Encuadrado solo están ahí). Si el
// calendario no se puede leer, no se envía nada (falla cerrado).
import { supabase } from '../supabase';
import { logError, logInfo } from '../logger';
import { todayCL, nowCL } from '../dateUtils';
import { listaFeriados, FERIADOS_CONFIRMADOS } from '../feriados';
import { getValidAccessToken } from '../syncCalendar';
import { pacienteDeTitulo } from '../boxCala';
import { esCobrable } from '../debt';
import { getWhatsappConfig, sendWhatsappText, sendWhatsappTemplate, estadoPlantillas } from '../whatsapp';
import { sendSeguimientoEmail, sendResumenSeguimientos, ADMIN_EMAIL_FALLBACK, type LineaResumen } from '../email';
import {
  pasoConsulta, pasoPaciente, cobroPendienteVencido, elegirCanal, enviadosRecientes, sePuedeReintentar, envioTrabado,
  enHorarioDeEnvio, fechaEnPalabras, primerNombre, mismoTelefono, normalizarCorreo, normalizarTelefono, diasEntre,
  sumarDias, eventosDePersona, unirSesiones, segundoRequiereAprobacion, codigoDeAnuncio, reservaVigente, decisionSegundo, debeDescartar, MAX_INTENTOS, TOPE_MENSAJES,
  type Canal, type Consulta, type EventoCalendario, type SesionPaciente,
} from './reglas';
import { textoWhatsapp, plantillaDe, variablesPlantilla, IDIOMA_PLANTILLAS, NOMBRE_PASO, type Paso, type DatosTexto } from './textos';
import type { EventoWhatsapp } from './webhookWhatsapp';

const SITIO = 'https://www.valentinaorellana.cl';
const DIAS_ATRAS = 200;     // sesiones pasadas que se miran (intervalo habitual y última sesión)
const DIAS_ADELANTE = 180;  // próximas horas que se miran
const PAGINA = 1000;        // Supabase devuelve como máximo 1000 filas por consulta
const MAX_PAGINAS = 20;

export type Persona = {
  id: string; tipo: 'consulta' | 'paciente'; nombre: string | null; telefono: string | null; email: string | null;
  patient_id: string | null; origen: string; codigo: string | null; no_escribir: boolean; segundo_aprobado?: boolean | null;
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
  created_by_admin: boolean | null; created_at: string | null;
};
type Ficha = { id: string; name: string | null; email: string | null; phone: string | null; active: boolean };

/** Un mensaje que corresponde enviar. */
export type Candidato = {
  clave: string; paso: Paso; referencia: string; nombre: string; email: string | null; telefono: string | null;
  ultimoEntrante: string | null; datos: DatosTexto; personaId?: string; agrupadas?: string[]; envioId?: number;
};
/** Mensaje que espera a Vale: 3A (pausa) o 1B de una consulta por correo. */
export type Aprobacion = {
  paso: '3A' | '1B'; envioId: number | null; clave: string; referencia: string; nombre: string; detalle: string;
  estado: string; motivo: string | null; intentos: number; texto: string; patientId?: string; personaId?: string;
};
export type FilaConsulta = Persona & { motivo: string; tiene1B: boolean };
export type FilaPaciente = { patientId: string; nombre: string; detalle: string; noEscribir: boolean };

export type Plan = {
  listo: boolean;               // migración 0027 aplicada
  activo: boolean;              // interruptor en /admin/seguimientos
  calendarioOk: boolean;        // se pudo leer Google Calendar (si no, no se envía nada)
  candidatos: Candidato[];
  aprobaciones: Aprobacion[];
  consultas: FilaConsulta[];
  pacientes: FilaPaciente[];    // pacientes con 2A, 3A o 4A, o con "No escribir"
  envios: Envio[];
  trabados: Envio[];            // "en curso" hace más de 1 hora: no se sabe si salió
  cambiosEstado: { id: string; estado: Consulta['estado'] }[];
};

export async function seguimientosActivos(): Promise<boolean> {
  const { data } = await supabase.from('settings').select('value').eq('key', 'seguimientos_activos').maybeSingle();
  return data?.value === 'true';
}

type ErrorDb = { code?: string; message?: string } | null;
const tablaFalta = (e: ErrorDb) => !!e && (e.code === '42P01' || /does not exist|schema cache/i.test(e.message ?? ''));
class TablaFalta extends Error {}

/** Todas las filas de una consulta, de a 1000 (el tope de Supabase), en orden estable. Lanza si hay más de 20 000.
 *  Las tablas se ordenan por `id` (uuid o bigserial): no es cronológico, pero es único y no cambia,
 *  que es lo que importa para que las páginas no se salten ni repitan filas. */
async function todas<T>(armar: (desde: number, hasta: number) => PromiseLike<{ data: unknown[] | null; error: ErrorDb }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < MAX_PAGINAS; i++) {
    const { data, error } = await armar(i * PAGINA, (i + 1) * PAGINA - 1);
    if (tablaFalta(error)) throw new TablaFalta(error?.message);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < PAGINA) return out;
  }
  // Justo 20 000 filas está bien; solo si hay más se lanza.
  const extra = await armar(MAX_PAGINAS * PAGINA, MAX_PAGINAS * PAGINA);
  if (extra.error) throw new Error(extra.error.message);
  if (!(extra.data ?? []).length) return out;
  throw new Error(`Demasiadas filas (más de ${MAX_PAGINAS * PAGINA}): no se revisa para no trabajar con datos incompletos`);
}

/** Sesiones de Google Calendar (página y Encuadrado) entre dos fechas. null = no se pudo leer completo. */
async function sesionesCalendario(desde: string, hasta: string): Promise<EventoCalendario[] | null> {
  const auth = await getValidAccessToken().catch(() => null);
  if (!auth) return null;
  const tMin = new Date(Date.parse(desde + 'T00:00:00Z') - 86400000).toISOString();
  const tMax = new Date(Date.parse(hasta + 'T00:00:00Z') + 2 * 86400000).toISOString();
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events`
    + `?timeMin=${tMin}&timeMax=${tMax}&singleEvents=true&orderBy=startTime&maxResults=250&timeZone=America%2FSantiago`;
  type Ev = { summary?: string; status?: string; start?: { dateTime?: string }; attendees?: { email?: string }[] };
  const items: Ev[] = [];
  let pagina: string | undefined;
  for (let i = 0; i < 20; i++) {
    const res = await fetch(base + (pagina ? `&pageToken=${encodeURIComponent(pagina)}` : ''),
      { headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!res?.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data) return null;
    items.push(...(data.items ?? []));
    pagina = data.nextPageToken;
    if (!pagina) break;
  }
  if (pagina) return null; // lista incompleta: mejor no enviar nada
  const out: EventoCalendario[] = [];
  for (const ev of items) {
    const inicio = ev.start?.dateTime;
    const titulo = ev.summary ?? '';
    // Solo sesiones (página: "… Sesión Individual … — Nombre"; Encuadrado: "Nombre Sesión individual …").
    if (!inicio || ev.status === 'cancelled' || !/sesi[oó]n/i.test(titulo)) continue;
    const fecha = inicio.slice(0, 10); // con timeZone=America/Santiago viene en hora de Chile
    if (fecha < desde || fecha > hasta) continue;
    out.push({
      fecha,
      nombre: pacienteDeTitulo(titulo.replace(/^\s*(Por pagar|Pagada)\s*·\s*/i, '')),
      correos: (ev.attendees ?? []).map((a) => normalizarCorreo(a.email)).filter((c): c is string => !!c),
    });
  }
  return out;
}

/** Lo que correspondería hacer ahora (lo mismo que ve el panel). */
export async function planSeguimientos(ahora = Date.now()): Promise<Plan> {
  const vacio: Plan = { listo: false, activo: false, calendarioOk: false, candidatos: [], aprobaciones: [], consultas: [], pacientes: [], envios: [], trabados: [], cambiosEstado: [] };
  const hoy = todayCL(new Date(ahora));
  const desde = sumarDias(hoy, -DIAS_ATRAS);
  const hasta = sumarDias(hoy, DIAS_ADELANTE);
  const desdeEnvios = new Date(ahora - 400 * 86400e3).toISOString();

  let personas: Persona[], envios: Envio[], reservas: Reserva[], fichas: Ficha[];
  const [activo, calendario] = await Promise.all([seguimientosActivos(), sesionesCalendario(desde, hasta)]);
  try {
    [personas, envios, reservas, fichas] = await Promise.all([
      todas<Persona>((a, b) => supabase.from('seguimiento_personas').select('*').order('id').range(a, b)),
      todas<Envio>((a, b) => supabase.from('seguimiento_envios').select('*').gte('creado_at', desdeEnvios).order('id').range(a, b)),
      todas<Reserva>((a, b) => supabase.from('bookings')
        .select('id, patient_name, patient_email, patient_phone, session_date, session_time, status, paid_at, debt_voided, amount, no_show, payment_note, notes, payment_method, created_by_admin, created_at')
        .in('status', ['confirmed', 'pending_payment']).gte('session_date', desde).lte('session_date', '2099-12-31').order('id').range(a, b)),
      todas<Ficha>((a, b) => supabase.from('patients').select('id, name, email, phone, active').order('id').range(a, b)),
    ]);
  } catch (e) {
    if (e instanceof TablaFalta) return vacio;
    throw e;
  }

  const plan: Plan = { ...vacio, listo: true, activo, calendarioOk: calendario !== null, envios };
  const eventos = calendario ?? [];
  plan.trabados = envios.filter((e) => envioTrabado(e, ahora));
  const enviosDe = (clave: string) => envios.filter((e) => e.clave === clave);
  const existe = (clave: string, paso: string, ref: string) => envios.find((e) => e.clave === clave && e.paso === paso && e.referencia === ref);
  // Un paso ya registrado solo vuelve a la lista si falló y le quedan intentos (nunca dos veces).
  const yaTomado = (clave: string, paso: string, ref: string) => { const f = existe(clave, paso, ref); return !!f && !sePuedeReintentar(f); };
  const vigente = (b: Reserva) => reservaVigente(b, esCobrable(b));
  const sesionDe = (b: Reserva): SesionPaciente => ({ session_date: b.session_date, vigente: vigente(b), no_show: b.no_show, payment_note: b.payment_note });
  // "No escribir": por ficha, o una consulta marcada con el mismo correo o teléfono (pasa a paciente al agendar).
  const bloqueada = (f: Ficha) => personas.some((p) => p.no_escribir && (p.patient_id === f.id
    || (!!normalizarCorreo(p.email) && normalizarCorreo(p.email) === normalizarCorreo(f.email))
    || (!!p.telefono && mismoTelefono(p.telefono, f.phone))));
  const hoyEnviado = (paso: string, email: string | null, tel: string | null) => envios.some((e) => e.paso === paso && e.estado === 'enviado'
    && !!e.enviado_at && todayCL(new Date(e.enviado_at)) === hoy
    && ((!!normalizarCorreo(email) && normalizarCorreo(e.email) === normalizarCorreo(email)) || (!!tel && mismoTelefono(e.telefono, tel))));

  // ── Secuencia 1: consultas nuevas ──
  for (const p of personas.filter((x) => x.tipo === 'consulta')) {
    const correo = normalizarCorreo(p.email);
    const esPersona = (email: string | null, tel: string | null) => (!!correo && normalizarCorreo(email) === correo) || (!!p.telefono && mismoTelefono(tel, p.telefono));
    const creada = p.creado_at.slice(0, 10);
    // Agendó: una hora vigente en la página, una ficha de paciente, o una sesión en Google Calendar (Encuadrado) desde que escribió.
    const agendo = reservas.some((b) => vigente(b) && esPersona(b.patient_email, b.patient_phone))
      || fichas.some((f) => esPersona(f.email, f.phone))
      || eventosDePersona(eventos, { nombre: p.nombre, email: p.email }).some((e) => e.fecha >= sumarDias(creada, -1));
    const clave = `consulta:${p.id}`;
    const d = pasoConsulta(p, enviosDe(clave).map((e) => ({ paso: e.paso, enviado_at: e.estado === 'enviado' ? e.enviado_at : null })), agendo, ahora);
    if (d.nuevoEstado && d.nuevoEstado !== p.estado) plan.cambiosEstado.push({ id: p.id, estado: d.nuevoEstado });
    plan.consultas.push({ ...p, estado: d.nuevoEstado ?? p.estado, motivo: d.motivo, tiene1B: !!existe(clave, '1B', '') });
    if (!d.paso) continue;
    const cand: Candidato = { clave, paso: d.paso, referencia: '', nombre: p.nombre ?? '', email: p.email, telefono: p.telefono, ultimoEntrante: p.ultimo_entrante_at, datos: { nombre: primerNombre(p.nombre) }, personaId: p.id };
    const fila = existe(clave, d.paso, '') ?? null;
    if (d.paso === '1B') {
      // Por correo no se ve si respondió: el segundo espera la confirmación de Vale (decisionSegundo).
      const dec = decisionSegundo(segundoRequiereAprobacion(p), fila);
      if (dec.aprobacion) {
        plan.aprobaciones.push({ paso: '1B', envioId: fila?.id ?? null, clave, referencia: '', nombre: p.nombre ?? '', detalle: p.email ? `Consulta por correo (${p.email}): ¿te respondió?` : 'Segundo seguimiento', estado: fila?.estado ?? 'nueva', motivo: fila?.motivo ?? null, intentos: fila?.intentos ?? 0, texto: textoWhatsapp('1B', cand.datos), personaId: p.id });
      }
      if (dec.candidato) plan.candidatos.push(fila ? { ...cand, envioId: fila.id } : cand);
      continue;
    }
    if (!yaTomado(clave, d.paso, '')) plan.candidatos.push(cand);
  }

  // Sesiones por persona: reservas por correo + eventos del calendario, sin repetir el día.
  const porCorreo = new Map<string, Reserva[]>();
  for (const b of reservas) {
    const c = normalizarCorreo(b.patient_email);
    if (c) porCorreo.set(c, [...(porCorreo.get(c) ?? []), b]);
  }
  const yaEnEstaVuelta: { email: string | null; tel: string | null }[] = [];
  const enVuelta = (email: string | null, tel: string | null) => yaEnEstaVuelta.some((x) => (!!x.email && x.email === normalizarCorreo(email)) || (!!x.tel && mismoTelefono(x.tel, tel)));

  // ── Secuencia 4 primero (gana sobre 2A el mismo día): sesión pasada sin pagar (2 a 7 días después) ──
  const vencidas = reservas.filter((b) => cobroPendienteVencido(b, hoy, esCobrable(b)));
  const grupos = new Map<string, Reserva[]>();
  for (const b of vencidas) {
    const c = normalizarCorreo(b.patient_email);
    if (c) grupos.set(c, [...(grupos.get(c) ?? []), b]);
  }
  for (const [correo, lista] of grupos) {
    const f = fichas.find((x) => normalizarCorreo(x.email) === correo && x.active) ?? fichas.find((x) => normalizarCorreo(x.email) === correo);
    // Sin ficha no hay enlace /pagar/<ficha> (que cobra todo lo pendiente en vivo): no se envía.
    if (!f || !f.active || bloqueada(f)) continue;
    const tel = f.phone ?? lista[0].patient_phone;
    if (enVuelta(correo, tel) || hoyEnviado('2A', correo, tel)) continue;
    const clave = `paciente:${f.id}`;
    const pendientes = lista.filter((b) => !yaTomado(clave, '4A', b.id)).sort((a, b) => b.session_date.localeCompare(a.session_date));
    if (!pendientes.length) continue;
    const [b, ...resto] = pendientes;
    yaEnEstaVuelta.push({ email: correo, tel });
    plan.pacientes.push({ patientId: f.id, nombre: f.name ?? b.patient_name, detalle: `Sesión del ${fechaEnPalabras(b.session_date)} pendiente de pago`, noEscribir: false });
    plan.candidatos.push({
      clave, paso: '4A', referencia: b.id, nombre: f.name ?? b.patient_name, email: f.email, telefono: tel, ultimoEntrante: null,
      datos: { nombre: primerNombre(f.name ?? b.patient_name), fecha: fechaEnPalabras(b.session_date), enlace: `${SITIO}/pagar/${f.id}` },
      agrupadas: resto.map((x) => x.id),
    });
  }

  // ── Secuencias 2 y 3: pacientes activas ──
  for (const f of fichas) {
    const correo = normalizarCorreo(f.email);
    if (!correo) continue;
    if (bloqueada(f)) { plan.pacientes.push({ patientId: f.id, nombre: f.name ?? '', detalle: 'Marcada «No escribir»', noEscribir: true }); continue; }
    if (!f.active) continue; // dada de baja: nunca
    const propias = eventosDePersona(eventos, { nombre: f.name, email: f.email });
    const d = pasoPaciente(unirSesiones((porCorreo.get(correo) ?? []).map(sesionDe), propias), hoy);
    if (!d.tipo) continue;
    const clave = `paciente:${f.id}`;
    const nombre = f.name ?? '';
    if (d.tipo === '2A') {
      // 4A gana; y una sola vez por persona: ni en esta vuelta, ni hoy, ni por la misma última sesión
      // desde otra ficha con el mismo correo o teléfono.
      if (enVuelta(correo, f.phone) || hoyEnviado('4A', correo, f.phone) || hoyEnviado('2A', correo, f.phone)) continue;
      if (envios.some((e) => e.paso === '2A' && e.referencia === d.referencia && e.clave !== clave && ['enviado', 'en_curso'].includes(e.estado)
        && ((!!normalizarCorreo(e.email) && normalizarCorreo(e.email) === correo) || (!!f.phone && mismoTelefono(e.telefono, f.phone))))) continue;
      yaEnEstaVuelta.push({ email: correo, tel: f.phone });
      plan.pacientes.push({ patientId: f.id, nombre, detalle: `Última sesión hace ${d.dias} días (suele venir cada ${d.intervalo})`, noEscribir: false });
      if (!yaTomado(clave, '2A', d.referencia)) {
        plan.candidatos.push({ clave, paso: '2A', referencia: d.referencia, nombre, email: f.email, telefono: f.phone, ultimoEntrante: null, datos: { nombre: primerNombre(nombre) } });
      }
    } else {
      const fila = existe(clave, '3A', d.referencia);
      if (!fila || ['por_aprobar', 'aprobado', 'error', 'en_curso'].includes(fila.estado)) {
        plan.aprobaciones.push({ paso: '3A', envioId: fila?.id ?? null, clave, referencia: d.referencia, nombre, detalle: `Última sesión el ${fechaEnPalabras(d.ultima)} (${d.dias} días)`, estado: fila?.estado ?? 'nueva', motivo: fila?.motivo ?? null, intentos: fila?.intentos ?? 0, texto: textoWhatsapp('3A', { nombre: primerNombre(nombre) }), patientId: f.id });
      }
      if (fila && (fila.estado === 'aprobado' || (fila.estado === 'error' && fila.intentos < MAX_INTENTOS))) {
        plan.candidatos.push({ clave, paso: '3A', referencia: d.referencia, nombre, email: f.email, telefono: f.phone, ultimoEntrante: null, datos: { nombre: primerNombre(nombre) }, envioId: fila.id });
      }
    }
  }
  return plan;
}

// ─── Tomar y cerrar una fila (nunca dos veces) ───────────────────────────────

async function tomarFila(clave: string, paso: string, referencia: string, extra: Record<string, unknown>): Promise<number | null> {
  const ahoraIso = new Date().toISOString();
  const ins = await supabase.from('seguimiento_envios').insert({ clave, paso, referencia, estado: 'en_curso', tomada_en: ahoraIso, intentos: 1, ...extra }).select('id').maybeSingle();
  if (!ins.error && ins.data) return ins.data.id as number;
  if (ins.error && ins.error.code !== '23505') {
    await logError('seguimientos/reservar', 'No se pudo registrar un seguimiento; se omite para no duplicarlo', { clave, paso, error: ins.error.message });
    return null;
  }
  const { data: f } = await supabase.from('seguimiento_envios').select('id, estado, intentos, tomada_en').eq('clave', clave).eq('paso', paso).eq('referencia', referencia).maybeSingle();
  if (!f || !sePuedeReintentar(f)) return null;
  // Toma condicionada: si otro proceso la tomó entre medio, no calza y no se envía.
  const { data: tomada } = await supabase.from('seguimiento_envios')
    .update({ estado: 'en_curso', tomada_en: ahoraIso, intentos: f.intentos + (f.estado === 'aprobado' ? 0 : 1), ...extra })
    .eq('id', f.id).eq('estado', f.estado).eq('intentos', f.intentos).select('id');
  return tomada?.length ? (f.id as number) : null;
}

const tomarPaso = (c: Candidato, canal: Canal) => tomarFila(c.clave, c.paso, c.referencia, {
  canal, telefono: normalizarTelefono(c.telefono), email: normalizarCorreo(c.email), nombre: c.nombre.slice(0, 120) || null,
});

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

/** Aviso del calendario sin leer, como máximo cada 6 horas (la tarea corre cada 5 min). */
async function avisarCalendarioSinLeer() {
  const clave = 'seguimientos_calendario_aviso';
  const { data } = await supabase.from('settings').select('value').eq('key', clave).maybeSingle();
  if (data?.value && Date.now() - Date.parse(data.value) < 6 * 3600e3) return;
  await supabase.from('settings').upsert({ key: clave, value: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'key' });
  await logError('seguimientos/calendario', 'No se pudo leer Google Calendar: los seguimientos no se envían hasta que se pueda (las sesiones de Encuadrado solo están ahí)');
}

// ─── Tarea programada ────────────────────────────────────────────────────────

export type ResultadoEjecucion = {
  ok: true; listo: boolean; activo: boolean; calendarioOk: boolean; enHorario: boolean;
  enviados: { clave: string; paso: string; canal: string }[];
  omitidos: { clave: string; paso: string; motivo: string }[];
  errores: { clave: string; paso: string; motivo: string }[];
  porAprobarNuevos: number; descartados: number; resumen: string;
};

export async function ejecutarSeguimientos(ahora = Date.now()): Promise<ResultadoEjecucion> {
  const out: ResultadoEjecucion = { ok: true, listo: false, activo: false, calendarioOk: false, enHorario: false, enviados: [], omitidos: [], errores: [], porAprobarNuevos: 0, descartados: 0, resumen: 'no' };
  const plan = await planSeguimientos(ahora);
  out.listo = plan.listo; out.activo = plan.activo; out.calendarioOk = plan.calendarioOk;
  if (!plan.listo) return out;

  // Siempre (aunque el interruptor esté apagado): se descartan las aprobaciones que ya no corresponden
  // (agendó, respondió, "No escribir"…), así el aviso del panel cuenta lo real. Descartar nunca envía nada.
  const vigentes = new Set(plan.aprobaciones.map((a) => `${a.clave}|${a.paso}|${a.referencia}`));
  for (const e of plan.envios.filter((x) => debeDescartar(x, vigentes))) {
    const r = await supabase.from('seguimiento_envios').update({ estado: 'descartado', motivo: 'Ya no corresponde (agendó, respondió o cambió su situación)' }).eq('id', e.id).eq('estado', e.estado).select('id');
    if (r.data?.length) out.descartados++;
  }
  if (!plan.activo) return out;

  if (!plan.calendarioOk) {
    await avisarCalendarioSinLeer();
    out.resumen = 'no: calendario sin leer';
    return out;
  }

  // Estados derivados (agendó / respondió / no siguió) quedan guardados para el panel.
  for (const c of plan.cambiosEstado) {
    await supabase.from('seguimiento_personas').update({ estado: c.estado, actualizado_at: new Date().toISOString() }).eq('id', c.id);
  }

  // Pausas (3A) y 1B por correo: se crean "por aprobar" (nunca se envían solas).
  for (const a of plan.aprobaciones.filter((x) => x.envioId === null)) {
    const r = await supabase.from('seguimiento_envios').insert({ clave: a.clave, paso: a.paso, referencia: a.referencia, estado: 'por_aprobar', nombre: a.nombre.slice(0, 120) || null });
    if (!r.error) out.porAprobarNuevos++;
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
      const elegido = elegirCanal({
        email: c.email, telefono: c.telefono, whatsappConectado: !!wa, ultimoEntrante: c.ultimoEntrante, ahora,
        plantillaAprobada: !!c.datos.nombre && plantillas?.get(plantillaDe(c.paso).nombre) === 'APPROVED',
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
    .or(`estado.eq.por_aprobar,enviado_at.gte."${new Date(ahora - 30 * 3600e3).toISOString()}"`).order('id').limit(1000);
  const filas = (data ?? []) as Pick<Envio, 'paso' | 'referencia' | 'estado' | 'canal' | 'nombre' | 'enviado_at' | 'creado_at'>[];
  const deHoy = (iso: string | null) => !!iso && todayCL(new Date(iso)) === hoy;
  const enviados = filas.filter((f) => f.estado === 'enviado' && f.paso !== 'resumen' && deHoy(f.enviado_at));
  const porAprobar = filas.filter((f) => f.estado === 'por_aprobar');
  if (!enviados.length && !porAprobar.some((f) => deHoy(f.creado_at))) return 'no: nada nuevo hoy';

  // Misma toma que los mensajes: si el envío del resumen falló, se reintenta (hasta 3 veces).
  const id = await tomarFila('resumen', 'resumen', hoy, {});
  if (id === null) return 'no: ya enviado hoy';
  const { data: notif } = await supabase.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  const adminEmail = notif?.value || ADMIN_EMAIL_FALLBACK;
  const lineas: LineaResumen[] = enviados.map((f) => ({
    nombre: f.nombre ?? 'Sin nombre', paso: NOMBRE_PASO[f.paso as Paso] ?? f.paso, canal: CANAL_TEXTO[f.canal ?? ''] ?? '',
    hora: f.enviado_at ? new Date(f.enviado_at).toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit' }) : undefined,
  }));
  const pausas = porAprobar.map((f) => ({
    nombre: f.nombre ?? 'Sin nombre',
    detalle: f.paso === '3A' && /^\d{4}-\d{2}-\d{2}$/.test(f.referencia) ? `${diasEntre(f.referencia, hoy)} días desde su última sesión` : 'Consulta por correo: ¿te respondió?',
  }));
  const r = await sendResumenSeguimientos(adminEmail, { fecha: fechaEnPalabras(hoy), enviados: lineas, porAprobar: pausas, urlPanel: `${SITIO}/admin/seguimientos` }, { idempotencyKey: `seguimientos-resumen:${hoy}` });
  await cerrarPaso(id, r.sent, r.reason);
  return r.sent ? 'enviado' : `error: ${r.reason}`;
}

// ─── Aviso (webhook) de WhatsApp ─────────────────────────────────────────────

const masTarde = (a: string | null, b: string) => (!a || Date.parse(b) > Date.parse(a) ? b : a);

/** Guarda solo metadatos. Crea una consulta SOLO si el mensaje vino de un anuncio (referral) o trae el
 *  código del sitio de un anuncio pagado (letra G, ver codigoDeAnuncio en reglas.ts). */
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
    // Nunca familia ni amigos: sin anuncio pagado no entra (orgánico, directo, etc. tampoco).
    if (!ev.anuncio && !codigoDeAnuncio(ev.codigo)) continue;
    const ins = await supabase.from('seguimiento_personas').insert({
      tipo: 'consulta', nombre: ev.nombre, telefono: ev.telefono, origen: ev.anuncio ? 'anuncio' : 'codigo', codigo: ev.codigo, ultimo_entrante_at: ev.at,
    });
    if (ins.error && ins.error.code !== '23505') throw new Error(ins.error.message);
    guardados++;
  }
  return { guardados, listo: true };
}

export { NOMBRE_PASO };
