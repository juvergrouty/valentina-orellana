// Seguimientos automáticos (aprobado por Vale el 18 nov 2026): reglas PURAS, sin base de datos ni
// variables de entorno, para poder probarlas (reglas.test.ts). La tarea /api/cron/seguimientos y
// /admin/seguimientos usan exactamente estas funciones, así lo que el panel muestra como "por salir"
// es lo mismo que la tarea envía.
//
// Reglas generales aprobadas:
// - Su primera respuesta a una consulta nueva siempre es de ella: la secuencia 1 parte solo después.
// - Solo entran como consulta: WhatsApp desde un anuncio (referral), con el código del sitio
//   ("código G-7K3Q"), o marcadas a mano "Consulta nueva". Nunca familia ni amigos.
// - Se detiene si la persona agenda, si responde después de un mensaje automático, o con "No escribir".
// - Nunca a pacientes dadas de baja, de sesiones Sin costo, ni marcadas "No escribir".
// - Solo de lunes a sábado, de 10:00 a 20:00 (hora de Chile), y nunca en feriados.
// - Máximo 2 mensajes automáticos por persona (ver TOPE_MENSAJES).

import { mismaPersona } from '../mismaPersona';

export const DIA_MS = 24 * 60 * 60 * 1000;
export const HORA_MS = 60 * 60 * 1000;

export const DIAS_1A = 3;            // 1A: 3 días después de su última respuesta
export const DIAS_1B = 7;            // 1B: 7 días después de 1A
export const DIAS_EXTRA_2A = 3;      // 2A: intervalo habitual + 3 días
export const INTERVALO_POR_DEFECTO = 7;
export const DIAS_PAUSA = 30;        // 3A: 30 días o más desde la última sesión
export const DIAS_COBRO = 2;         // 4A: 2 días después de la sesión
export const DIAS_COBRO_MAX = 7;     // 4A: no se manda por sesiones más antiguas (evita una ola al activarlo)
// "Máximo 2 mensajes automáticos por persona en total": la secuencia 1 tiene justo 2 (1A y 1B). Para
// pacientes (2A y 4A, que se repiten a lo largo de meses) el tope se cuenta en los últimos 30 días;
// si fuera de por vida, después de dos meses una paciente nunca más recibiría el aviso de pago.
export const TOPE_MENSAJES = 2;
export const TOPE_VENTANA_DIAS = 30;
export const VENTANA_SERVICIO_MS = 24 * HORA_MS; // ventana de 24 horas de WhatsApp para texto libre
export const MAX_INTENTOS = 3;
export const EN_CURSO_MS = 10 * 60 * 1000;
export const TRABADO_MS = 60 * 60 * 1000; // "en curso" por más de 1 hora: no se sabe si salió (no se reintenta)

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "martes 17 de noviembre" para una fecha YYYY-MM-DD. */
export function fechaEnPalabras(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${DIAS_SEMANA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} de ${MESES[m - 1]}`;
}

/** Suma días a una fecha YYYY-MM-DD (calendario, sin husos horarios). */
export function sumarDias(iso: string, dias: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}

/** Días de calendario entre dos fechas YYYY-MM-DD (b - a). */
export function diasEntre(a: string, b: string): number {
  const ms = (s: string) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((ms(b) - ms(a)) / DIA_MS);
}

/**
 * ¿Se puede enviar ahora? `relojCL` es la hora de pared de Chile (nowCL() de dateUtils: un Date cuyos
 * campos locales son la hora de Chile). Lunes a sábado, desde las 10:00 y antes de las 20:00, y no en
 * un feriado (fechas YYYY-MM-DD).
 */
export function enHorarioDeEnvio(relojCL: Date, feriados: ReadonlySet<string> = new Set()): boolean {
  const dia = relojCL.getDay();
  if (dia === 0) return false;
  const fecha = `${relojCL.getFullYear()}-${String(relojCL.getMonth() + 1).padStart(2, '0')}-${String(relojCL.getDate()).padStart(2, '0')}`;
  if (feriados.has(fecha)) return false;
  const min = relojCL.getHours() * 60 + relojCL.getMinutes();
  return min >= 10 * 60 && min < 20 * 60;
}

/** Primer nombre, con mayúscula inicial ("maría josé" → "María"). Vacío si no hay nombre. */
export function primerNombre(nombre: string | null | undefined): string {
  const p = String(nombre ?? '').trim().split(/\s+/)[0] ?? '';
  if (!p || /[@\d]/.test(p)) return '';
  return p.charAt(0).toLocaleUpperCase('es-CL') + p.slice(1).toLocaleLowerCase('es-CL');
}

/** Teléfono en dígitos con código de país (Chile por defecto), o null si no parece un teléfono. */
export function normalizarTelefono(t: string | null | undefined): string | null {
  let d = String(t ?? '').replace(/\D/g, '');
  if (d.length === 9 && d.startsWith('9')) d = '56' + d;
  return d.length >= 8 && d.length <= 15 ? d : null;
}

/** ¿Mismo teléfono? Compara los últimos 9 dígitos (con o sin +56, espacios, etc.). */
export function mismoTelefono(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = String(a ?? '').replace(/\D/g, ''), y = String(b ?? '').replace(/\D/g, '');
  return x.length >= 8 && y.length >= 8 && x.slice(-9) === y.slice(-9);
}

export function normalizarCorreo(e: string | null | undefined): string | null {
  const c = String(e ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c) ? c : null;
}

/** Código de seguimiento del sitio, exactamente como lo arma BaseLayout: "(código G-7K3Q)", con su
 *  alfabeto (sin I, O, 0 ni 1). Cualquier otra cosa ("código penal") no cuenta. */
export function detectarCodigo(texto: string | null | undefined): string | null {
  const m = String(texto ?? '').match(/\(código ([GSIMPDOX]-[A-HJ-NP-Z2-9]{4})\)/);
  return m ? m[1] : null;
}

/** Letras del código que vienen de un anuncio PAGADO (BaseLayout.astro, función letra()):
 *  - G: Google Ads (gclid / gbraid / wbraid, o utm_source=google con medium cpc/ppc/paid).
 *  Las demás NO son anuncio seguro y no crean consulta: S Google orgánico, X directo, O otro,
 *  P Psychology Today, D Doctoralia, e I / M, que salen de utm_source o del referrer de Instagram o
 *  Facebook y por eso también marcan visitas orgánicas desde esas redes. Los anuncios de Meta con
 *  botón de WhatsApp llegan con `referral`, que sí crea la consulta. */
export const LETRAS_ANUNCIO = new Set(['G']);
export const codigoDeAnuncio = (codigo: string | null | undefined) => !!codigo && LETRAS_ANUNCIO.has(codigo.charAt(0));

/** Instante (ISO) del mediodía de Chile de una fecha YYYY-MM-DD, con el horario de verano que rija ese día. */
export function mediodiaChile(fecha: string): string {
  const [y, m, d] = fecha.split('-').map(Number);
  for (const desfase of [3, 4]) {
    const t = Date.UTC(y, m - 1, d, 12 + desfase);
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', hour: '2-digit', hour12: false }).format(new Date(t)));
    if (h === 12) return new Date(t).toISOString();
  }
  return new Date(Date.UTC(y, m - 1, d, 15)).toISOString();
}

/**
 * Intervalo habitual entre sesiones, en días: la mediana de las distancias entre las últimas 6
 * sesiones (fechas distintas). Con una sola sesión, 7 días.
 */
export function intervaloHabitual(fechas: string[]): number {
  const f = [...new Set(fechas.map((x) => x.slice(0, 10)))].sort().slice(-6);
  if (f.length < 2) return INTERVALO_POR_DEFECTO;
  const gaps = f.slice(1).map((x, i) => diasEntre(f[i], x)).filter((g) => g > 0).sort((a, b) => a - b);
  if (!gaps.length) return INTERVALO_POR_DEFECTO;
  const mid = Math.floor(gaps.length / 2);
  return Math.round(gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2);
}

// ─── Secuencia 1: consulta nueva que no agendó ───────────────────────────────

export type Consulta = {
  estado: 'activa' | 'agendo' | 'respondio' | 'no_siguio' | 'no_escribir';
  no_escribir: boolean;
  ultimo_entrante_at: string | null;
  ultima_respuesta_vale_at: string | null;
};
export type EnvioHecho = { paso: string; enviado_at: string | null };
export type Decision = { paso: '1A' | '1B' | null; motivo: string; nuevoEstado?: Consulta['estado'] };

const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

export function pasoConsulta(c: Consulta, envios: EnvioHecho[], agendo: boolean, ahora: number): Decision {
  if (c.no_escribir || c.estado === 'no_escribir') return { paso: null, motivo: 'Marcada «No escribir»' };
  if (agendo) return { paso: null, motivo: 'Ya agendó', nuevoEstado: c.estado === 'agendo' ? undefined : 'agendo' };
  if (c.estado === 'respondio') return { paso: null, motivo: 'Respondió' };
  const vale = ms(c.ultima_respuesta_vale_at);
  if (!Number.isFinite(vale)) return { paso: null, motivo: 'Esperando tu primera respuesta' };
  const entrante = ms(c.ultimo_entrante_at);
  const a = envios.find((e) => e.paso === '1A' && e.enviado_at);
  const b = envios.find((e) => e.paso === '1B' && e.enviado_at);
  // (Math.max con un NaN da NaN: se filtran los que no existen.)
  const tiempos = [ms(a?.enviado_at), ms(b?.enviado_at)].filter(Number.isFinite);
  const ultimoAuto = tiempos.length ? Math.max(...tiempos) : NaN;
  // Respondió después de un mensaje automático: se detiene.
  if (Number.isFinite(ultimoAuto) && Number.isFinite(entrante) && entrante > ultimoAuto) {
    return { paso: null, motivo: 'Respondió después del mensaje automático', nuevoEstado: 'respondio' };
  }
  if (b) return { paso: null, motivo: 'No siguió (ya se enviaron los 2 mensajes)', nuevoEstado: c.estado === 'no_siguio' ? undefined : 'no_siguio' };
  if (!a) {
    // Te escribió después de tu última respuesta: le toca responder a Vale, no a la automatización.
    if (Number.isFinite(entrante) && entrante > vale) return { paso: null, motivo: 'Te escribió: le toca responder a ti' };
    const cuando = vale + DIAS_1A * DIA_MS;
    return ahora >= cuando ? { paso: '1A', motivo: 'Corresponde el primer seguimiento' } : { paso: null, motivo: `Primer seguimiento el ${new Date(cuando).toISOString().slice(0, 10)}` };
  }
  const base = Math.max(ms(a.enviado_at), vale);
  const cuando = base + DIAS_1B * DIA_MS;
  return ahora >= cuando ? { paso: '1B', motivo: 'Corresponde el segundo seguimiento' } : { paso: null, motivo: `Segundo seguimiento el ${new Date(cuando).toISOString().slice(0, 10)}` };
}

// ─── Secuencias 2 y 3: paciente sin próxima hora / en pausa ─────────────────

export type SesionPaciente = {
  session_date: string;
  // La hora existe de verdad: confirmada, o sin pagar pero cobrable (debt.ts esCobrable: agendada por el
  // panel con link enviado, o reserva web dentro de sus 30 min). Los eventos de Google Calendar
  // (Encuadrado o página) cuentan como vigentes. Una reserva web abandonada no.
  vigente: boolean;
  no_show?: boolean | null;
  payment_note?: string | null;
};

export type DecisionPaciente =
  | { tipo: '2A' | '3A'; referencia: string; ultima: string; intervalo: number; dias: number }
  | { tipo: null; motivo: string };

/** Qué le corresponde a una paciente activa según sus sesiones. `hoy` en hora de Chile. */
export function pasoPaciente(sesiones: SesionPaciente[], hoy: string): DecisionPaciente {
  const vigentes = sesiones.filter((s) => s.session_date !== '2099-12-31' && s.vigente);
  if (vigentes.some((s) => s.session_date >= hoy)) return { tipo: null, motivo: 'Tiene una próxima hora' };
  const pasadas = vigentes.filter((s) => s.no_show !== true && s.session_date < hoy)
    .sort((a, b) => a.session_date.localeCompare(b.session_date));
  if (!pasadas.length) return { tipo: null, motivo: 'Sin sesiones pasadas' };
  const ultima = pasadas[pasadas.length - 1];
  if (ultima.payment_note === 'Sin costo') return { tipo: null, motivo: 'Sesión Sin costo' };
  const intervalo = intervaloHabitual(pasadas.map((s) => s.session_date));
  const dias = diasEntre(ultima.session_date, hoy);
  if (dias >= DIAS_PAUSA) return { tipo: '3A', referencia: ultima.session_date, ultima: ultima.session_date, intervalo, dias };
  if (dias >= intervalo + DIAS_EXTRA_2A) return { tipo: '2A', referencia: ultima.session_date, ultima: ultima.session_date, intervalo, dias };
  return { tipo: null, motivo: `Al día (cada ${intervalo} días)` };
}

// ─── Secuencia 4: sesión pasada sin pagar ───────────────────────────────────

export type ReservaCobro = {
  session_date: string;
  status: string;
  paid_at?: string | null;
  debt_voided?: boolean | null;
  amount?: number | null;
  no_show?: boolean | null;
  payment_note?: string | null;
  notes?: string | null;
  payment_method?: string | null;
};

/** ¿Corresponde el aviso de pago pendiente (2 a 7 días después de la sesión)? `cobrable` es
 *  esCobrable(b) de debt.ts (la misma regla de /pagar): una reserva web abandonada nunca cobra. */
export function cobroPendienteVencido(b: ReservaCobro, hoy: string, cobrable: boolean): boolean {
  if (!cobrable || b.session_date === '2099-12-31') return false;
  if (b.paid_at || b.debt_voided === true || !((b.amount ?? 0) > 0)) return false;
  if (b.payment_note === 'Sin costo' || b.no_show === true) return false;
  // Solo horas ya confirmadas (o agendadas por el panel y aún sin pagar: status pending_payment).
  if (b.status !== 'confirmed' && b.status !== 'pending_payment') return false;
  const notas = String(b.notes ?? '');
  // Flow ya informó el pago, o hay una transferencia subida / por revisar en el banco: no se cobra.
  if (/PagoSinAviso|ComprobanteTransferencia|TransferenciaPorRevisar/.test(notas)) return false;
  // "Paga en consulta": se cobra en la sesión, sin enlace.
  if ((b.payment_method == null || b.payment_method === 'manual') && notas.split('\n').some((l) => l.trim() === 'PagoEnConsulta')) return false;
  const dias = diasEntre(b.session_date, hoy);
  return dias >= DIAS_COBRO && dias <= DIAS_COBRO_MAX;
}

// ─── Canal, tope e idempotencia ─────────────────────────────────────────────

export type Canal = 'correo' | 'whatsapp_texto' | 'whatsapp_plantilla';

/** Correo si hay correo; si no, WhatsApp (texto libre dentro de las 24 horas; si no, plantilla aprobada). */
export function elegirCanal(p: {
  email: string | null; telefono: string | null; whatsappConectado: boolean;
  ultimoEntrante: string | null; plantillaAprobada: boolean; ahora: number;
}): { canal: Canal } | { canal: null; motivo: string } {
  if (normalizarCorreo(p.email)) return { canal: 'correo' };
  if (!normalizarTelefono(p.telefono)) return { canal: null, motivo: 'Sin correo ni teléfono' };
  if (!p.whatsappConectado) return { canal: null, motivo: 'WhatsApp no está conectado' };
  const e = ms(p.ultimoEntrante);
  if (Number.isFinite(e) && p.ahora - e < VENTANA_SERVICIO_MS) return { canal: 'whatsapp_texto' };
  if (p.plantillaAprobada) return { canal: 'whatsapp_plantilla' };
  return { canal: null, motivo: 'La plantilla de WhatsApp todavía no está aprobada por Meta' };
}

export type EnvioParaTope = { paso: string; estado: string; enviado_at: string | null; telefono: string | null; email: string | null };

/** Mensajes automáticos ya enviados a esta persona en los últimos 30 días (por teléfono o correo).
 *  El 3A (aprobado a mano por Vale) y el resumen no cuentan. */
export function enviadosRecientes(envios: EnvioParaTope[], telefono: string | null, email: string | null, ahora: number): number {
  const correo = normalizarCorreo(email);
  return envios.filter((e) => e.estado === 'enviado' && e.paso !== '3A' && e.paso !== 'resumen'
    && ahora - ms(e.enviado_at) < TOPE_VENTANA_DIAS * DIA_MS
    && ((telefono && mismoTelefono(e.telefono, telefono)) || (correo && normalizarCorreo(e.email) === correo))).length;
}

export type FilaEnvio = { estado: string; intentos: number; tomada_en: string | null };

/**
 * ¿Se puede (re)intentar un paso que ya tiene fila? Nunca dos veces: enviado, omitido, descartado o
 * esperando aprobación no se tocan; uno "en curso" tampoco (aunque haya quedado cortado: WhatsApp no
 * tiene llave de idempotencia y podría haber salido). Solo un error, hasta 3 intentos.
 * `aprobado` (3A que Vale aprobó) sí se toma para enviarlo.
 */
export function sePuedeReintentar(f: FilaEnvio): boolean {
  if (f.estado === 'aprobado') return true;
  return f.estado === 'error' && f.intentos < MAX_INTENTOS;
}

/** Fila "en curso" hace más de 1 hora: se cortó a medio enviar. Se muestra para revisar a mano. */
export function envioTrabado(f: { estado: string; tomada_en: string | null }, ahora: number): boolean {
  return f.estado === 'en_curso' && Number.isFinite(ms(f.tomada_en)) && ahora - ms(f.tomada_en) > TRABADO_MS;
}

// ─── Google Calendar (sesiones de Encuadrado y de la página) ────────────────
// Las sesiones agendadas en Encuadrado solo están en Google Calendar, no en `bookings` (igual que en
// el Inicio, boxCala.ts y cobrosProximos.ts). Una sesión puede tener evento de la página y de
// Encuadrado (intencional): se cuenta una por persona y día.

export type EventoCalendario = { fecha: string; nombre: string; correos: string[] };

const palabrasNombre = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-zñ ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);

/** Calce fuerte por nombre: los dos traen nombre y apellido, mismo primer nombre y al menos un
 *  apellido en común ("Luis Medina" = "Luis Rafael Medina Mendez"; "Luis" solo NO calza con nadie). */
export function mismoNombreFuerte(a: string, b: string): boolean {
  const x = palabrasNombre(a), y = palabrasNombre(b);
  return x.length >= 2 && y.length >= 2 && mismaPersona(a, b) && x.slice(1).some((w) => y.slice(1).includes(w));
}

/** Eventos de una persona: por correo de invitado, o por nombre con calce fuerte (nombre + apellido).
 *  Un nombre de una sola palabra (p. ej. el perfil de WhatsApp "Camila") no toma eventos de otras. */
export function eventosDePersona(eventos: EventoCalendario[], p: { nombre: string | null; email: string | null }): EventoCalendario[] {
  const correo = normalizarCorreo(p.email);
  return eventos.filter((e) => (!!correo && e.correos.includes(correo)) || (!!p.nombre && !!e.nombre && mismoNombreFuerte(e.nombre, p.nombre)));
}

/** Reservas + eventos del calendario, sin repetir el mismo día. */
export function unirSesiones(reservas: SesionPaciente[], eventos: EventoCalendario[]): SesionPaciente[] {
  const dias = new Set(reservas.filter((r) => r.vigente).map((r) => r.session_date));
  const extra: SesionPaciente[] = [];
  for (const e of eventos) {
    if (dias.has(e.fecha)) continue;
    dias.add(e.fecha);
    extra.push({ session_date: e.fecha, vigente: true });
  }
  return [...reservas, ...extra];
}

/** Consulta nueva por correo: el 1B espera la confirmación de Vale (las respuestas por correo no se
 *  detectan solas), salvo que ella ya haya marcado "No respondió: enviar el segundo". */
export function segundoRequiereAprobacion(p: { email: string | null; segundo_aprobado?: boolean | null }): boolean {
  return !!normalizarCorreo(p.email) && p.segundo_aprobado !== true;
}

/** ¿La reserva es una hora real (agendada, realizada o pagada)? Además de confirmada o cobrable
 *  (esCobrable de debt.ts, que se pasa como parámetro), cuenta si Flow ya la pagó sin aviso, si tiene
 *  transferencia subida o por revisar, si está pagada, si la agendó Vale en el panel, o si se anuló
 *  la deuda (la sesión igual ocurrió). Solo una reserva web abandonada (sin pagar, sin nada) no cuenta. */
export function reservaVigente(b: { status: string; paid_at?: string | null; created_by_admin?: boolean | null; debt_voided?: boolean | null; notes?: string | null }, cobrable: boolean): boolean {
  if (b.status === 'cancelled' || b.status === 'expired') return false;
  return b.status === 'confirmed' || cobrable || !!b.paid_at || b.created_by_admin === true || b.debt_voided === true
    || /PagoSinAviso|ComprobanteTransferencia|TransferenciaPorRevisar/.test(String(b.notes ?? ''));
}

/**
 * Segundo mensaje (1B) cuando corresponde según pasoConsulta. `fila` es su registro, si existe.
 *  - aprobacion: se muestra en "Esperando tu aprobación" (y por eso nunca se descarta por "ya no corresponde").
 *  - candidato:  entra a la lista de envío.
 * Un 1B aprobado (por el botón de la tarjeta o por "No me respondió: enviar el segundo") se mantiene y
 * se envía; uno por aprobar solo sale cuando Vale lo aprueba.
 */
export function decisionSegundo(requiereAprobacion: boolean, fila: { estado: string; intentos: number } | null): { aprobacion: boolean; candidato: boolean } {
  const reintentable = !!fila && fila.estado === 'error' && fila.intentos < MAX_INTENTOS;
  if (fila && ['por_aprobar', 'aprobado', 'error', 'en_curso'].includes(fila.estado)) {
    // por_aprobar nunca se toma sola (sePuedeReintentar no la deja): espera el botón de Vale.
    return { aprobacion: true, candidato: fila.estado === 'aprobado' || reintentable };
  }
  if (fila) return { aprobacion: false, candidato: false }; // enviado, descartado, omitido
  return requiereAprobacion ? { aprobacion: true, candidato: false } : { aprobacion: false, candidato: true };
}

/** ¿Se descarta una fila por aprobar/aprobada que ya no está en el plan? (claves "clave|paso|referencia") */
export function debeDescartar(f: { clave: string; paso: string; referencia: string; estado: string }, vigentes: ReadonlySet<string>): boolean {
  return (f.paso === '3A' || f.paso === '1B') && (f.estado === 'por_aprobar' || f.estado === 'aprobado') && !vigentes.has(`${f.clave}|${f.paso}|${f.referencia}`);
}
