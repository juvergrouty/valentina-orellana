import { randomBytes } from 'node:crypto';
import { supabase } from './supabase';

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

const GCLID = /^[A-Za-z0-9_-]+$/;
const DIA = 86400e3;
const enChile = (ms: number) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'America/Santiago' });

/** Toque con GCLID válido (el último clic de anuncio manda; si no, el primero). */
function toqueConClic(o: OrigenGuardado): Toque | null {
  for (const t of [o?.last, o?.first]) if (t?.gclid && GCLID.test(t.gclid)) return t;
  return null;
}

/** Hora para Google: posterior al clic y nunca futura. */
function horaConversion(pagoMs: number, clicMs: number | undefined, ahora: number): string {
  let ms = pagoMs;
  if (clicMs && ms <= clicMs) ms = clicMs + 3600e3;
  return enChile(Math.min(ms, ahora));
}

export async function csvConversiones(): Promise<string> {
  const ahora = Date.now();
  const desde = new Date(ahora - 90 * DIA).toISOString(); // Google acepta clics de hasta 90 días
  const filas = new Map<string, string>(); // gclid -> línea (una conversión por clic)

  // 1) Reservas pagadas con clic de anuncio.
  const { data: pagadas } = await supabase.from('bookings')
    .select('patient_email, amount, paid_at, origen')
    .not('paid_at', 'is', null).not('origen', 'is', null).gte('paid_at', desde).limit(2000);
  const conClic = (pagadas ?? [])
    .map(b => ({ ...b, toque: toqueConClic(b.origen as OrigenGuardado) }))
    .filter(b => b.toque && b.patient_email);
  if (conClic.length) {
    // Primer pago de cada paciente, mirando TODO su historial (no solo 90 días).
    const emails = [...new Set(conClic.map(b => String(b.patient_email).toLowerCase()))];
    const { data: historial } = await supabase.from('bookings')
      .select('patient_email, paid_at').in('patient_email', emails).not('paid_at', 'is', null).limit(5000);
    const primerPago = new Map<string, number>();
    for (const h of historial ?? []) {
      const e = String(h.patient_email).toLowerCase();
      const ms = new Date(h.paid_at as string).getTime();
      if (!primerPago.has(e) || ms < primerPago.get(e)!) primerPago.set(e, ms);
    }
    for (const b of conClic.sort((x, y) => String(x.paid_at).localeCompare(String(y.paid_at)))) {
      const pagoMs = new Date(b.paid_at as string).getTime();
      if (pagoMs !== primerPago.get(String(b.patient_email).toLowerCase())) continue; // paciente recurrente
      const gclid = b.toque!.gclid!;
      if (filas.has(gclid)) continue;
      if (b.toque!.ts && b.toque!.ts < ahora - 90 * DIA) continue;
      filas.set(gclid, [gclid, NOMBRE_CONVERSION, horaConversion(pagoMs, b.toque!.ts, ahora), String(Number(b.amount) || 0), 'CLP'].join(','));
    }
  }

  // 2) Códigos de WhatsApp marcados a mano (si alguna vez se usan).
  const { data: marcados } = await supabase.from('admin_logs').select('message, data')
    .eq('context', 'wa/paciente').limit(1000);
  const { data: clics } = await supabase.from('admin_logs').select('message, data, created_at')
    .eq('context', 'wa/clic').gte('created_at', desde).limit(2000);
  const clicPorCodigo = new Map((clics ?? []).map(c => [c.message as string, c]));
  for (const p of marcados ?? []) {
    const c = clicPorCodigo.get(p.message as string);
    const toque = toqueConClic((c?.data ?? null) as OrigenGuardado);
    if (!toque || filas.has(toque.gclid!)) continue;
    const pago = (p.data ?? {}) as { monto?: number; fecha?: string };
    const pagoMs = new Date(`${pago.fecha ?? new Date().toISOString().slice(0, 10)}T12:00:00-03:00`).getTime();
    const clicMs = c ? new Date(c.created_at as string).getTime() : toque.ts;
    filas.set(toque.gclid!, [toque.gclid, NOMBRE_CONVERSION, horaConversion(pagoMs, clicMs, ahora), String(pago.monto ?? 0), 'CLP'].join(','));
  }

  const lineas = ['Parameters:TimeZone=America/Santiago', 'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency', ...filas.values()];
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
