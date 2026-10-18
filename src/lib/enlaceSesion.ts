// Enlace propio de cada sesión online (pedido de Vale, 18 oct 2026): "el robot tiene que estar
// disponible SIEMPRE que venga de una sesión y se clickee el link para abrirla".
//
//   https://www.valentinaorellana.cl/sesion/<código>
//
// Paciente y Vale reciben este enlace en vez del de Meet (correos, WhatsApp, evento de Calendar,
// panel). Al abrirlo, el sitio manda el robot de notas a esa sesión (si corresponde) y redirige al
// Meet de la reserva, que no cambia (la sala sigue siendo la que crea Google Calendar).
//
// Código (sin columna nueva: sirve para todas las reservas, también las antiguas):
//   base64url( AES-256-ECB(kCifrado, uuid de 16 bytes) ‖ HMAC-SHA256(kFirma, uuid)[0..16] ) → 43 caracteres
//  - La firma de 128 bits hace el código no adivinable (no se puede fabricar el de otra reserva).
//  - El cifrado de un solo bloque (permutación con llave) oculta el id de la reserva en la URL.
//  - Las dos llaves se derivan de ADMIN_SECRET (secretos.ts, en runtime) con etiquetas propias, así
//    no se cruzan con la sesión del panel ni con el enlace de reagendar. OJO: si se rota ADMIN_SECRET,
//    los enlaces ya enviados dejan de funcionar (como los de reagendar).
// Sin ADMIN_SECRET no hay enlace propio: quien arma el texto usa el de Meet tal cual (nunca queda sin link).
import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { secreto } from './secretos';

export const SITIO_ENLACE = 'https://www.valentinaorellana.cl';
export const RUTA_ENLACE = '/sesion/';
const CODIGO_RE = /^[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEET_RE = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#].*)?$/i;
const CORREO_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,100}\.[A-Za-z]{2,24}$/;

function llaves(base: string | undefined): { cifrado: Buffer; firma: Buffer } | null {
  if (!base) return null;
  return {
    cifrado: createHmac('sha256', `enlace-sesion:v1:cifrado:${base}`).update('k').digest(),
    firma: createHmac('sha256', `enlace-sesion:v1:firma:${base}`).update('k').digest(),
  };
}

function uuidABytes(id: string): Buffer | null {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  return Buffer.from(id.replace(/-/g, ''), 'hex');
}

function bytesAUuid(b: Buffer): string {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function firmaDe(k: Buffer, uuid: Buffer): Buffer {
  return createHmac('sha256', k).update(uuid).digest().subarray(0, 16);
}

/** Código del enlace de una reserva (siempre el mismo para la misma reserva). null sin secreto o id inválido. */
export function codigoSesion(bookingId: string, base: string | undefined = secreto('ADMIN_SECRET')): string | null {
  const k = llaves(base);
  const u = uuidABytes(bookingId);
  if (!k || !u) return null;
  const c = createCipheriv('aes-256-ecb', k.cifrado, null);
  c.setAutoPadding(false);
  const bloque = Buffer.concat([c.update(u), c.final()]);
  return Buffer.concat([bloque, firmaDe(k.firma, u)]).toString('base64url');
}

/** Id de la reserva si el código es auténtico; null si no (formato, largo o firma). Tiempo constante en la firma. */
export function reservaDesdeCodigo(codigo: unknown, base: string | undefined = secreto('ADMIN_SECRET')): string | null {
  if (typeof codigo !== 'string' || !CODIGO_RE.test(codigo)) return null;
  const k = llaves(base);
  if (!k) return null;
  const raw = Buffer.from(codigo, 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== codigo) return null; // forma canónica única
  const d = createDecipheriv('aes-256-ecb', k.cifrado, null);
  d.setAutoPadding(false);
  const u = Buffer.concat([d.update(raw.subarray(0, 16)), d.final()]);
  const esperada = firmaDe(k.firma, u);
  if (!timingSafeEqual(esperada, raw.subarray(16))) return null;
  const id = bytesAUuid(u);
  return UUID_RE.test(id) ? id : null;
}

/** https://www.valentinaorellana.cl/sesion/<código>, o null si no se puede generar. */
export function urlSesion(bookingId: string | null | undefined, base: string | undefined = secreto('ADMIN_SECRET')): string | null {
  if (!bookingId) return null;
  const c = codigoSesion(bookingId, base);
  return c ? `${SITIO_ENLACE}${RUTA_ENLACE}${c}` : null;
}

/**
 * Enlace para entrar a la sesión que se le da a paciente y Vale: el propio si se puede, si no el de Meet
 * (nunca quedan sin enlace). null si no hay ninguno.
 */
export function enlaceParaSesion(bookingId: string | null | undefined, meetUrl: string | null | undefined, base: string | undefined = secreto('ADMIN_SECRET')): string | null {
  return urlSesion(bookingId, base) ?? normalizarMeet(meetUrl);
}

/** Id de la reserva de un evento creado por el sitio (google event id = booking.id sin guiones). */
export function reservaDeEventId(eventId: string | null | undefined): string | null {
  const e = String(eventId ?? '');
  if (!/^[0-9a-f]{32}$/.test(e)) return null;
  const u = `${e.slice(0, 8)}-${e.slice(8, 12)}-${e.slice(12, 16)}-${e.slice(16, 20)}-${e.slice(20)}`;
  return UUID_RE.test(u) ? u : null;
}

/** https://meet.google.com/xxx-xxxx-xxx (sin parámetros) o null si no es una sala de Meet. */
export function normalizarMeet(url: string | null | undefined): string | null {
  const m = MEET_RE.exec(String(url ?? '').trim());
  return m ? `https://meet.google.com/${m[1].toLowerCase()}` : null;
}

/** Último "Meet: <url>" que escribió el sistema en las notas de la reserva (syncCalendar / generate-meet). */
export function meetDeNotas(notas: string | null | undefined): string | null {
  const m = [...String(notas ?? '').matchAll(/(?:^|\n)Meet: (https:\/\/meet\.google\.com\/\S+)/g)].at(-1);
  return m ? normalizarMeet(m[1]) : null;
}

/**
 * Destino de la redirección: SOLO https://meet.google.com/<sala> (nada de redirección abierta). Si viene
 * `authuser` con forma de correo (el panel de Vale lo manda para abrir Meet con la cuenta del negocio),
 * se agrega como único parámetro.
 */
export function destinoMeet(meetUrl: string | null | undefined, authuser?: string | null): string | null {
  const base = normalizarMeet(meetUrl);
  if (!base) return null;
  const u = new URL(base);
  if (authuser && CORREO_RE.test(authuser)) u.searchParams.set('authuser', authuser);
  return u.origin === 'https://meet.google.com' ? u.toString() : null;
}

/**
 * Visitas que no son una persona abriendo la sesión: vistas previas de WhatsApp/redes, buscadores y
 * revisores de enlaces del correo. Se les redirige igual, pero no mandan el robot.
 */
export function esVisitaAutomatica(userAgent: string | null | undefined): boolean {
  const ua = String(userAgent ?? '');
  if (!ua) return true;
  return /bot\b|crawler|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|skype|linkedin|embedly|curl\/|wget|python-requests|headless|lighthouse|safelinks|proofpoint|mimecast|barracuda/i.test(ua);
}

// ─── Textos con el enlace (correos, WhatsApp, Calendar) ──────────────────────

const escapar = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Enlace propio para los correos de una sesión online; null si no es online o no se puede generar. */
export function enlaceEntradaSesion(
  data: { session_type?: string | null; sesion_id?: string | null; booking_id?: string | null },
  base: string | undefined = secreto('ADMIN_SECRET'),
): string | null {
  if (!String(data.session_type ?? '').includes('online')) return null;
  return urlSesion(data.sesion_id ?? data.booking_id ?? null, base);
}

/** Recuadro con el botón "Entrar a la sesión" (correo de confirmación, recordatorio y cambio de hora). */
export function bloqueEntrarSesion(enlace: string): string {
  const e = escapar(enlace);
  return `
        <div style="border:1px solid #DDD8CF;background:#FFFFFF;padding:1.1rem 1.25rem;margin-bottom:1.5rem;">
          <p style="font-family:'Inter',sans-serif;font-size:0.85rem;color:#1A1A18;margin:0 0 0.75rem;">Para entrar a tu sesión por Google Meet:</p>
          <a href="${e}"
             style="display:inline-block;background:#576352;color:white;padding:0.7rem 1.3rem;text-decoration:none;
                    font-family:'Inter',sans-serif;font-size:0.75rem;letter-spacing:0.08em;text-transform:uppercase;">
            Entrar a la sesión
          </a>
          <p style="font-family:'Inter',sans-serif;font-size:0.78rem;color:#6B6860;margin:0.75rem 0 0;line-height:1.6;">
            Ábrelo a la hora de tu sesión: te lleva directo a la videollamada. Si el botón no funciona, copia este enlace:<br>
            <span style="word-break:break-all;color:#576352;">${e}</span>
          </p>
        </div>`;
}

/** Línea del mensaje de WhatsApp con el link de pago. */
export function lineaEntrarWhatsApp(enlace: string | null | undefined): string {
  return enlace ? `\n🔗 Entrar a la sesión (Google Meet): ${enlace}` : '';
}

/** Línea de la descripción del evento de Google Calendar. */
export function lineaEntrarCalendario(enlace: string | null | undefined): string {
  return enlace ? `\nEntrar a la sesión: ${enlace}` : '';
}
