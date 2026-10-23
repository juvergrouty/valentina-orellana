import { randomBytes } from 'node:crypto';
import { supabase } from './supabase';
import { logError } from './logger';

// Conversiones sin conexión para Google Ads (14 oct 2026): "paciente nuevo que
// pagó", por GCLID. Todo automático, sin trabajo para Valentina:
//  1) Reservas pagadas cuyo origen (bookings.origen) trae un clic de anuncio. El
//     origen lo guarda la agenda web al reservar, y /pagar/[id] al pagar el link
//     que Valentina manda por WhatsApp (si la reserva no tenía origen).
//     Solo cuenta el PRIMER pago de cada paciente (paciente nuevo, no recurrente).
//  2) Los códigos de WhatsApp marcados a mano en /admin/whatsapp-codigos (opcional).
// Google Ads descarga el archivo solo, todos los días (subida programada por
// HTTPS a /api/google-ads/conversiones.csv, con usuario y contraseña).
// Ningún dato personal: solo GCLID, nombre de la conversión, hora, valor y moneda.

// Nombre neutro (no revela que es una sesión de terapia); tiene que coincidir
// con la acción "Importar > Clics" creada en Google Ads.
export const NOMBRE_CONVERSION = 'reserva_pagada';
export const CSV_USUARIO = 'google';
const CLAVE_SETTING = 'google_ads_csv_clave';

type Toque = { gclid?: string; ts?: number };
type OrigenGuardado = { first?: Toque | null; last?: Toque | null } | null;

// Un GCLID real tiene decenas de caracteres. Los valores cortos o de prueba
// ("TEST_…", "ejemplo") que alguien pegue en la URL no se mandan: Google los
// rechaza como "Unparseable gclid" y ensucian el diagnóstico (22 oct 2026).
const GCLID = /^[A-Za-z0-9_-]{20,}$/;
const GCLID_PRUEBA = /^(test|prueba|ejemplo)/i;
const DIA = 86400e3;

/** Desfase de Chile en ese instante ("-03:00" en verano, "-04:00" en invierno). */
function desfaseChile(ms: number): string {
  const gmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', timeZoneName: 'longOffset' })
    .formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-03:00';
  return gmt === 'GMT' ? '+00:00' : gmt.replace('GMT', '');
}

// Hora de Chile con su desfase explícito ("2026-10-14 15:30:00-03:00"): el Gestor
// de Datos de Google lee la primera fila como encabezado, así que la zona horaria
// va en cada fecha y no en una línea "Parameters:TimeZone" aparte.
function enChile(ms: number): string {
  return new Date(ms).toLocaleString('sv-SE', { timeZone: 'America/Santiago' }) + desfaseChile(ms);
}

/** Mediodía en Chile de una fecha "AAAA-MM-DD", con el desfase que corresponde a ese día. */
function mediodiaChile(fecha: string): number {
  const ref = Date.parse(`${fecha}T16:00:00Z`);
  if (!Number.isFinite(ref)) return NaN; // fecha inválida: se pierde esa fila, no el archivo entero
  return new Date(`${fecha}T12:00:00${desfaseChile(ref)}`).getTime();
}

/** Toque con GCLID válido (el último clic de anuncio manda; si no, el primero). */
function toqueConClic(o: OrigenGuardado): Toque | null {
  for (const t of [o?.last, o?.first]) if (t?.gclid && GCLID.test(t.gclid) && !GCLID_PRUEBA.test(t.gclid)) return t;
  return null;
}

/** Hora para Google: posterior al clic. Si todavía es futura se devuelve null y
 *  la fila sale en la próxima descarga con su hora definitiva (si se ajustara a
 *  "ahora", Google la contaría dos veces: misma conversión con otra hora). */
function horaConversion(pagoMs: number, clicMs: number | undefined, ahora: number): string | null {
  let ms = pagoMs;
  if (!Number.isFinite(ms)) return null;
  if (clicMs && ms <= clicMs) ms = clicMs + 3600e3;
  return ms > ahora ? null : enChile(ms);
}

/** Una consulta que falla no puede producir un archivo vacío "normal": se avisa
 *  y la descarga responde error (Google marca la subida como fallida). */
async function revisar(error: { message: string } | null, que: string) {
  if (!error) return;
  await logError('conversiones-google', `No se pudo leer ${que}`, { error: error.message });
  throw new Error(`conversiones-google: ${que}`);
}

export async function csvConversiones(): Promise<string> {
  const ahora = Date.now();
  const desde = new Date(ahora - 90 * DIA).toISOString(); // Google acepta clics de hasta 90 días
  const filas = new Map<string, string>(); // gclid -> línea (una conversión por clic)

  // 1) Reservas pagadas con clic de anuncio.
  const { data: pagadas, error: e1 } = await supabase.from('bookings')
    .select('patient_email, amount, paid_at, origen')
    // Sin reservas vencidas: un pago de una hora ya tomada se reembolsa (15 oct 2026).
    // amount > 0: una sesión sin costo (obra social, 17 oct 2026) no es un paciente que pagó.
    .not('paid_at', 'is', null).gt('amount', 0).not('origen', 'is', null).neq('status', 'expired').gte('paid_at', desde)
    .order('paid_at', { ascending: true }).limit(1000);
  await revisar(e1, 'reservas pagadas');
  const conClic = (pagadas ?? [])
    .map(b => ({ ...b, toque: toqueConClic(b.origen as OrigenGuardado) }))
    .filter(b => b.toque && b.patient_email);
  if (conClic.length) {
    // Primer pago de cada paciente, mirando TODO su historial (no solo 90 días).
    const emails = [...new Set(conClic.map(b => String(b.patient_email).toLowerCase()))];
    // Ordenado por fecha: si algún día se corta en 1000 filas, se pierden las más
    // nuevas (a lo más falta una conversión), nunca el primer pago real.
    const { data: historial, error: e2 } = await supabase.from('bookings')
      .select('patient_email, paid_at').in('patient_email', emails).not('paid_at', 'is', null).gt('amount', 0).neq('status', 'expired')
      .order('paid_at', { ascending: true }).limit(1000);
    await revisar(e2, 'historial de pagos');
    const primerPago = new Map<string, number>();
    for (const h of historial ?? []) {
      const e = String(h.patient_email).toLowerCase();
      const ms = new Date(h.paid_at as string).getTime();
      if (!primerPago.has(e) || ms < primerPago.get(e)!) primerPago.set(e, ms);
    }
    // Primer pago de cada paciente; si ese pago cubrió varias sesiones (mismo
    // paid_at), el valor es la suma.
    const porClic = new Map<string, { pagoMs: number; ts?: number; valor: number }>();
    for (const b of conClic) {
      const pagoMs = new Date(b.paid_at as string).getTime();
      if (pagoMs !== primerPago.get(String(b.patient_email).toLowerCase())) continue; // paciente recurrente
      if (b.toque!.ts && b.toque!.ts < ahora - 90 * DIA) continue;
      const gclid = b.toque!.gclid!;
      const previo = porClic.get(gclid);
      if (!previo) porClic.set(gclid, { pagoMs, ts: b.toque!.ts, valor: Number(b.amount) || 0 });
      else if (previo.pagoMs === pagoMs) previo.valor += Number(b.amount) || 0;
    }
    for (const [gclid, c] of porClic) {
      const hora = horaConversion(c.pagoMs, c.ts, ahora);
      if (hora) filas.set(gclid, [gclid, NOMBRE_CONVERSION, hora, String(c.valor), 'CLP'].join(','));
    }
  }

  // 2) Códigos de WhatsApp marcados a mano (si alguna vez se usan).
  const { data: marcados, error: e3 } = await supabase.from('admin_logs').select('message, data')
    .eq('context', 'wa/paciente').limit(1000);
  await revisar(e3, 'pacientes marcados');
  const { data: clics, error: e4 } = await supabase.from('admin_logs').select('message, data, created_at')
    .eq('context', 'wa/clic').gte('created_at', desde).order('created_at', { ascending: false }).limit(1000);
  await revisar(e4, 'clics de WhatsApp');
  const clicPorCodigo = new Map((clics ?? []).map(c => [c.message as string, c]));
  for (const p of marcados ?? []) {
    const c = clicPorCodigo.get(p.message as string);
    const toque = toqueConClic((c?.data ?? null) as OrigenGuardado);
    if (!toque || filas.has(toque.gclid!)) continue;
    const pago = (p.data ?? {}) as { monto?: number; fecha?: string };
    const hoyChile = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
    const pagoMs = mediodiaChile(pago.fecha ?? hoyChile);
    const clicMs = c ? new Date(c.created_at as string).getTime() : toque.ts;
    const hora = horaConversion(pagoMs, clicMs, ahora);
    if (hora) filas.set(toque.gclid!, [toque.gclid, NOMBRE_CONVERSION, hora, String(pago.monto ?? 0), 'CLP'].join(','));
  }

  // El Gestor de Datos de Google necesita al menos una fila para reconocer las
  // columnas. Mientras no haya pacientes de anuncios va una fila de ejemplo con un
  // identificador de clic inexistente: Google la rechaza y no cuenta nada.
  if (filas.size === 0) {
    filas.set('ejemplo', ['EJEMPLO-SIN-PACIENTES-AUN', NOMBRE_CONVERSION, enChile(ahora - DIA), '0', 'CLP'].join(','));
  }
  const lineas = ['Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency', ...filas.values()];
  return lineas.join('\n') + '\n';
}

/** Contraseña de la subida programada de Google Ads (se crea la primera vez). */
export async function claveCsv(crear: boolean): Promise<string | null> {
  const { data } = await supabase.from('settings').select('value').eq('key', CLAVE_SETTING).maybeSingle();
  if (data?.value) return data.value as string;
  if (!crear) return null;
  const nueva = randomBytes(18).toString('base64url');
  const { error } = await supabase.from('settings').insert({ key: CLAVE_SETTING, value: nueva });
  if (!error) return nueva;
  // Otra visita la creó al mismo tiempo: se usa la que quedó guardada.
  const { data: otra } = await supabase.from('settings').select('value').eq('key', CLAVE_SETTING).maybeSingle();
  return (otra?.value as string) ?? null;
}
