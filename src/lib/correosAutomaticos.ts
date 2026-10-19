import { supabase } from './supabase';

// Correos automáticos (Valentina, 16 oct 2026): cada envío ya queda en
// admin_logs con contexto "email/…" (logEmail en src/lib/logger.ts): a quién,
// asunto, si salió y el error si falló. Comunicaciones → Automáticos los
// muestra, y el panel avisa cuando alguno falló desde la última vez que se miró.
export const CLAVE_VISTOS = 'correos_automaticos_vistos_at';

export const TIPOS_CORREO: Record<string, string> = {
  'email/confirmacion': 'Confirmación de sesión',
  'email/recordatorio': 'Recordatorio de sesión',
  'email/pasos': 'Pasos a seguir',
  'email/pasos-automatico': 'Pasos a seguir (envío automático)',
  'email/consentimiento': 'Consentimiento de datos',
  'email/consentimiento-copia': 'Copia del consentimiento firmado',
  'email/boleta': 'Boleta',
  'email/link-pago': 'Link de pago',
  'email/saldo-pendiente': 'Saldo pendiente',
  'email/sesion-actualizada': 'Sesión reagendada o cambiada',
  'email/hora-anulada': 'Hora anulada (aviso a la paciente)',
  'email/reserva-liberada': 'Hora liberada (no pagó)',
  'email/reseña': 'Solicitud de reseña',
  'email/evaluación': 'Evaluación post-sesión',
  'email/vitrina-confirmacion': 'Confirmación de taller',
  'email/notif-admin': 'Aviso para ti: nueva reserva',
  'email/reagendo-admin': 'Aviso para ti: paciente reagendó',
  'email/hora-liberada-admin': 'Aviso para ti: hora liberada',
  'email/contacto': 'Aviso para ti: formulario de contacto',
  'email/transferencia': 'Aviso para ti: comprobante de transferencia',
  'email/vitrina-admin': 'Aviso para ti: inscripción a taller',
};
export const tipoCorreo = (ctx: string) => TIPOS_CORREO[ctx] ?? ctx.replace(/^email\//, '');

export type CorreoAutomatico = {
  fecha: string; tipo: string; para: string; asunto: string;
  estado: 'enviado' | 'fallo' | 'desactivado'; error: string | null;
};

export async function leerCorreosAutomaticos(dias = 60, soloErrores = false): Promise<CorreoAutomatico[]> {
  const desde = new Date(Date.now() - dias * 86400000).toISOString();
  let q = supabase.from('admin_logs').select('level, context, message, data, created_at')
    .like('context', 'email/%').gt('created_at', desde)
    .order('created_at', { ascending: false }).limit(500);
  if (soloErrores) q = q.eq('level', 'error');
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map((l) => {
    const d = (l.data ?? {}) as { to?: string; email?: string; subject?: string; ok?: boolean; error?: string | null; desactivado?: boolean };
    return {
      fecha: String(l.created_at),
      tipo: tipoCorreo(String(l.context)),
      para: String(d.to ?? d.email ?? ''),
      asunto: String(d.subject ?? ''),
      estado: d.desactivado ? 'desactivado' : l.level === 'error' ? 'fallo' : 'enviado',
      error: l.level === 'error' ? String(d.error ?? l.message ?? '') : null,
    };
  });
}

/** Correos automáticos que fallaron desde la última vez que se miró la pestaña (máx. 14 días atrás). */
export async function contarCorreosFallidos(): Promise<number> {
  const { data: visto } = await supabase.from('settings').select('value').eq('key', CLAVE_VISTOS).maybeSingle();
  const tope = new Date(Date.now() - 14 * 86400000).toISOString();
  const desde = visto?.value && visto.value > tope ? visto.value : tope;
  const { count, error } = await supabase.from('admin_logs').select('id', { count: 'exact', head: true })
    .like('context', 'email/%').eq('level', 'error').gt('created_at', desde);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function marcarCorreosVistos(): Promise<void> {
  await supabase.from('settings').upsert({ key: CLAVE_VISTOS, value: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'key' });
}
