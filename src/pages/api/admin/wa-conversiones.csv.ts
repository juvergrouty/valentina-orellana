import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';

export const prerender = false;

// Archivo para Google Ads (14 oct 2026): conversiones sin conexión por GCLID de
// los pacientes que llegaron por WhatsApp desde un anuncio y pagaron (marcados en
// /admin/whatsapp-codigos). Formato de la plantilla oficial de Google
// ("Importar conversiones desde clics"). Solo GCLID, nombre, hora, valor y moneda:
// ningún dato personal. Google acepta clics de hasta 90 días.
// Nombre neutro (no revela que es una sesión de terapia). Crear en Google Ads una
// acción "Importar > Clics" con este nombre exacto antes de subir el archivo.
const NOMBRE_CONVERSION = 'reserva_pagada';

export const GET: APIRoute = async () => {
  const desde = new Date(Date.now() - 90 * 86400e3).toISOString();
  const { data: pagos } = await supabase.from('admin_logs').select('message, data')
    .eq('context', 'wa/paciente').limit(1000);
  const { data: clics } = await supabase.from('admin_logs').select('message, data, created_at')
    .eq('context', 'wa/clic').gte('created_at', desde).limit(2000);

  type Toque = { gclid?: string };
  const clicPorCodigo = new Map((clics ?? []).map(c => [c.message as string, c]));
  const lineas = ['Parameters:TimeZone=America/Santiago', 'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency'];
  const ahoraCL = new Date().toLocaleString('sv-SE', { timeZone: 'America/Santiago' });
  const hechos = new Set<string>();
  for (const p of pagos ?? []) {
    if (hechos.has(p.message as string)) continue;
    hechos.add(p.message as string);
    const c = clicPorCodigo.get(p.message as string);
    const d = (c?.data ?? {}) as { last?: Toque | null; first?: Toque | null };
    const gclid = d.last?.gclid ?? d.first?.gclid;
    if (!gclid || !/^[A-Za-z0-9_-]+$/.test(gclid)) continue;
    const pago = (p.data ?? {}) as { monto?: number; fecha?: string };
    // Hora de la conversión: la fecha del pago a las 12:00 (Google exige que sea
    // posterior al clic; si el pago fue el mismo día del clic, se usa la hora del clic + 1 h).
    const fecha = pago.fecha ?? new Date().toISOString().slice(0, 10);
    let hora = `${fecha} 12:00:00`;
    if (c) {
      const clicCL = new Date(new Date(c.created_at as string).getTime() + 3600e3)
        .toLocaleString('sv-SE', { timeZone: 'America/Santiago' });
      if (clicCL > hora) hora = clicCL;
    }
    if (hora > ahoraCL) hora = ahoraCL; // Google rechaza horas futuras
    lineas.push([gclid, NOMBRE_CONVERSION, hora, String(pago.monto ?? 0), 'CLP'].join(','));
  }
  return new Response(lineas.join('\n') + '\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="google-ads-pacientes-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
};
