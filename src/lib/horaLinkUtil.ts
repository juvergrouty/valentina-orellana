// Partes puras del link a una hora (/hora/<token>, 22 nov 2026): sin base de datos, para
// poder probarlas (horaLinkUtil.test.ts). La lógica con base de datos está en horaLink.ts.

// Marcas en bookings.notes (mismo estilo que el resto del sitio: una línea por marca).
export const MARCA_HORA_LINK = 'HoraLink';                       // HoraLink <iso> <origen>
export const MARCA_HORA_VENCIDA = 'HoraLinkVencida';             // HoraLinkVencida <iso>: se liberó sin pago
export const MARCA_HORA_VENCIDA_VISTA = 'HoraLinkVencidaVista';  // Vale apretó «Ya lo vi»
export const MARCA_PLAZO_VENCIDO = 'HoraLinkPlazoVencido';       // HoraLinkPlazoVencido <iso> <whatsapp|correo|nada>: venció el plazo, sigue guardada
export const MARCA_PLAZO_VISTO = 'HoraLinkPlazoVisto';           // Vale apretó «Ya lo vi» en el aviso del plazo
export const MARCA_PASOS_WA_ENVIADOS = 'PasosWhatsappEnviados';  // PasosWhatsappEnviados <iso>
export const MARCA_PASOS_WA_PENDIENTE = 'PasosWhatsappPendiente'; // no se pudieron enviar solos: Vale los manda
export const MARCA_PASOS_WA_HECHO = 'PasosWhatsappHecho';        // Vale apretó «Ya se los mandé»
export const MARCA_BOLETA_DATOS = 'BoletaPendienteDatos';        // pagada, falta el RUT para la boleta
export const MARCA_BOLETA_DATOS_OCULTA = 'BoletaPendienteDatosOculta'; // Vale la ocultó del Inicio

export const RETENCION_HORAS_DEFECTO = 24;
export const RETENCION_HORAS_MIN = 1;
export const RETENCION_HORAS_MAX = 168; // una semana

export const ORIGENES = ['panel', 'whatsapp', 'asistente', 'otro'] as const;
export type OrigenHora = typeof ORIGENES[number];
export function origenValido(o: unknown): OrigenHora {
  return (ORIGENES as readonly string[]).includes(String(o)) ? o as OrigenHora : 'otro';
}

/** Código del link: 24 caracteres base64url (144 bits al azar). */
export function tokenValido(t: unknown): t is string {
  return typeof t === 'string' && /^[A-Za-z0-9_-]{24,64}$/.test(t);
}

/** Horas de retención de Configuración (texto) → número válido; si no, 24. */
export function retencionHoras(valor: string | null | undefined): number {
  const n = Number(String(valor ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n < RETENCION_HORAS_MIN || n > RETENCION_HORAS_MAX) return RETENCION_HORAS_DEFECTO;
  return Math.round(n * 2) / 2; // de media en media hora
}

/** Hasta cuándo se retiene: ahora + horas, pero nunca después del inicio de la sesión. */
export function calcularVence(ahoraMs: number, horas: number, msHastaSesion: number): Date {
  const porPlazo = ahoraMs + horas * 3600_000;
  const porSesion = ahoraMs + Math.max(0, msHastaSesion);
  return new Date(Math.min(porPlazo, porSesion));
}

export function correoValido(c: string | null | undefined): boolean {
  const s = String(c ?? '').trim();
  return s.length <= 200 && /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i.test(s);
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "2026-11-25" → "miércoles 25 de noviembre". */
export function fechaLarga(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} de ${MESES[m - 1]}`;
}

/** Instante → { fecha, hora } en hora de Chile. */
export function enChile(iso: string | Date): { fecha: string; hora: string } {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return { fecha: `${v('year')}-${v('month')}-${v('day')}`, hora: `${v('hour')}:${v('minute')}` };
}

/** "lunes 24 de noviembre a las 18:00" (hora de Chile). */
export function venceTexto(iso: string | Date): string {
  const { fecha, hora } = enChile(iso);
  return `${fechaLarga(fecha)} a las ${hora}`;
}

export const primerNombre = (n: string | null | undefined) => {
  const p = String(n ?? '').trim().split(/\s+/)[0] || '';
  return p.charAt(0).toUpperCase() + p.slice(1);
};

/**
 * Mensaje para mandarle el link por WhatsApp. Cercano y corto, sin guion de venta
 * (regla de Vale: la primera respuesta por WhatsApp es cercanía, no un guion).
 */
export function mensajeHoraWhatsapp(o: { nombre: string; fecha: string; hora: string; online: boolean; url: string; venceIso: string; monto?: number | null }): string {
  const nombre = primerNombre(o.nombre);
  const saludo = nombre ? `Hola ${nombre}` : 'Hola';
  const modalidad = o.online ? 'online' : 'presencial';
  const valor = o.monto && o.monto > 0 ? ` (${clp(o.monto)}, con tarjeta o transferencia)` : '';
  return `${saludo}, te dejé reservada tu hora del ${fechaLarga(o.fecha)} a las ${o.hora} (${modalidad}).\n`
    + `Para confirmarla, puedes pagarla aquí${valor}: ${o.url}\n`
    + `Te la guardo hasta el ${venceTexto(o.venceIso)}; después se libera. Cualquier duda, me escribes.`;
}

export const clp = (n: number) => `$${Math.round(n).toLocaleString('es-CL')}`;

/** Instante UTC de una fecha y hora de Chile (con su horario de verano o invierno). */
export function utcDeChile(fecha: string, hora: string): Date {
  const [y, m, d] = fecha.split('-').map(Number);
  const [hh, mi] = hora.split(':').map(Number);
  let t = Date.UTC(y, m - 1, d, hh, mi);
  for (let i = 0; i < 2; i++) {
    const { fecha: f, hora: h } = enChile(new Date(t));
    const [fy, fm, fd] = f.split('-').map(Number);
    const [fh, fmi] = h.split(':').map(Number);
    t += Date.UTC(y, m - 1, d, hh, mi) - Date.UTC(fy, fm - 1, fd, fh, fmi);
  }
  return new Date(t);
}

/** «Agregar a mi calendario» (Google Calendar, sin cuenta de por medio para el sitio). */
export function enlaceCalendario(o: { fecha: string; hora: string; duracionMin: number; titulo: string; lugar?: string | null; detalle?: string | null }): string {
  const ini = utcDeChile(o.fecha, o.hora);
  const fin = new Date(ini.getTime() + (o.duracionMin || 50) * 60_000);
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const p = new URLSearchParams({ action: 'TEMPLATE', text: o.titulo, dates: `${f(ini)}/${f(fin)}` });
  if (o.lugar) p.set('location', o.lugar);
  if (o.detalle) p.set('details', o.detalle);
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

/** Recordatorio a la paciente cuando vence el plazo (la hora sigue guardada, plan aprobado: Línea 1). */
export function mensajeRecordatorioHora(o: { nombre: string; fecha: string; hora: string; url: string; monto?: number | null }): string {
  const nombre = primerNombre(o.nombre);
  const valor = o.monto && o.monto > 0 ? ` (${clp(o.monto)})` : '';
  return `${nombre ? `Hola ${nombre}` : 'Hola'}, te escribo por tu hora del ${fechaLarga(o.fecha)} a las ${o.hora}. Todavía te la tengo guardada.\n`
    + `Si quieres confirmarla, puedes pagarla aquí${valor}: ${o.url}\n`
    + 'Si ya no te acomoda, me avisas y la libero para otra persona.';
}

/** Pasos a seguir por WhatsApp, al pagar: lo imprescindible para llegar o conectarse. */
export function mensajePasosWhatsapp(o: { nombre: string; fecha: string; hora: string; online: boolean; meet?: string | null; direccion?: string | null; pasosUrl?: string | null }): string {
  const nombre = primerNombre(o.nombre);
  const lineas = [`${nombre ? `Hola ${nombre}` : 'Hola'}, tu hora del ${fechaLarga(o.fecha)} a las ${o.hora} quedó confirmada.`];
  if (o.online) {
    lineas.push(o.meet
      ? `La sesión es online; entra a este link a las ${o.hora}: ${o.meet}`
      : 'La sesión es online. El link para conectarte te llega en la invitación de Google Calendar; si no la ves, me escribes y te lo mando.');
  } else {
    lineas.push(o.direccion ? `Te espero en ${o.direccion}.` : 'Es presencial, en mi consulta. Si necesitas la dirección, me escribes.');
  }
  if (o.pasosUrl) lineas.push(`Aquí están los pasos a seguir antes de la sesión: ${o.pasosUrl}`);
  lineas.push(`Nos vemos el ${fechaLarga(o.fecha).split(' ')[0]}.`);
  return lineas.join('\n');
}

/** wa.me con el número (formato +56…) o, sin número, el selector de contacto. */
export function enlaceWhatsapp(telefono: string | null | undefined, texto: string): string {
  const d = String(telefono ?? '').replace(/\D/g, '');
  const num = d.length === 9 ? `56${d}` : d;
  const base = num.length >= 10 && num.length <= 15 ? `https://wa.me/${num}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(texto)}`;
}

/** ¿La sesión es una hora con link? (marca en las notas, sirve aunque falte la migración). */
export function esHoraLink(notes: string | null | undefined): boolean {
  return new RegExp(`^${MARCA_HORA_LINK} `, 'm').test(String(notes ?? ''));
}
export function tieneMarca(notes: string | null | undefined, marca: string): boolean {
  return new RegExp(`^${marca}(\\s|$)`, 'm').test(String(notes ?? ''));
}
