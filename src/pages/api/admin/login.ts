import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { logWarn } from '../../../lib/logger';
import { COOKIE_ADMIN, DURACION_SESION_MS, crearTokenAdmin, igualesSeguro } from '../../../lib/adminSession';

export const prerender = false;

// Límite de intentos (3 oct 2026): antes se podían probar contraseñas sin fin.
// Se cuentan los intentos fallidos registrados en admin_logs en los últimos
// 15 minutos: 5 desde la misma conexión bloquean esa conexión 15 minutos.
// Si hay muchos en total (ataque desde muchas conexiones), las conexiones que
// ya fallaron una vez quedan bloqueadas; una conexión limpia (la de Valentina)
// sigue pudiendo entrar. Antes, 30 intentos de cualquiera la dejaban fuera del
// panel a ella también (re-auditoría 4 oct 2026).
//
// Carrera corregida (12 oct 2026): antes se contaba ANTES de registrar el
// intento, así que varios intentos enviados al mismo tiempo veían todos el
// mismo conteo y pasaban juntos (más de 5 por conexión). Ahora cada intento se
// registra PRIMERO como fallido y después se cuenta (el conteo ya lo incluye):
// de una ráfaga simultánea pasan como máximo 5. Si la contraseña es correcta,
// ese registro se cambia a "auth/login-ok" y deja de contar como fallo; si el
// intento quedó bloqueado, pasa a "auth/login-bloqueado" (tampoco cuenta, para
// que seguir intentando durante el bloqueo no lo alargue). Si no se puede
// registrar o contar, se rechaza (antes se dejaba entrar igual).
const VENTANA_MS = 15 * 60 * 1000;
const MAX_POR_IP = 5;
const MAX_TOTAL  = 30;

// Respuesta cuando la base no permite revisar el límite: página simple con el
// aviso (el formulario de login es un POST normal del navegador).
const intentaEnUnosMinutos = () => new Response(
  '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Acceso · Panel Valentina Orellana</title></head>'
  + '<body style="font-family:Inter,system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 1.25rem;color:#1A1A18;line-height:1.6">'
  + '<p>No pude revisar el acceso en este momento. Intenta en unos minutos.</p>'
  + '<p><a href="/admin/login" style="color:#576352">Volver al acceso</a></p></body></html>',
  { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '120' } },
);

export const POST: APIRoute = async ({ request, cookies, redirect, clientAddress }) => {
  const form     = await request.formData();
  const password = form.get('password')?.toString() ?? '';
  const expected = import.meta.env.ADMIN_PASSWORD;
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || clientAddress || 'desconocida';

  // 1) Registrar el intento ANTES de revisar la contraseña (cuenta como fallido
  //    hasta que se demuestre lo contrario).
  const { data: fila, error: errorRegistro } = await supabase.from('admin_logs').insert({
    level: 'warn',
    context: 'auth/login-fallido',
    message: 'Intento de acceso al panel con contraseña incorrecta',
    data: { ip },
  }).select('id').single();
  if (errorRegistro || !fila) {
    console.warn('[login] no se pudo registrar el intento de acceso:', errorRegistro?.message);
    return intentaEnUnosMinutos();
  }

  /** Cambia el registro de este intento (deja de contar como fallido). */
  const reclasificar = async (context: string, level: string, message: string) => {
    const { error } = await supabase.from('admin_logs').update({ context, level, message }).eq('id', fila.id);
    if (error) console.warn(`[login] no se pudo marcar el intento como ${context}:`, error.message);
  };

  // 2) Contar los fallidos de la ventana; el conteo ya incluye este intento.
  const desde = new Date(Date.now() - VENTANA_MS).toISOString();
  const [porIp, total] = await Promise.all([
    supabase.from('admin_logs').select('id', { count: 'exact', head: true })
      .eq('context', 'auth/login-fallido').gt('created_at', desde).eq('data->>ip', ip),
    supabase.from('admin_logs').select('id', { count: 'exact', head: true })
      .eq('context', 'auth/login-fallido').gt('created_at', desde),
  ]);
  // Si no se puede contar, se rechaza (fail-closed) y queda registrado.
  if (porIp.error || total.error || porIp.count == null || total.count == null) {
    await logWarn('auth/login-limite', 'No se pudo revisar el límite de intentos de acceso; se rechazó el intento', { error: (porIp.error ?? total.error)?.message });
    await reclasificar('auth/login-bloqueado', 'warn', 'Intento de acceso rechazado: no se pudo revisar el límite de intentos');
    return intentaEnUnosMinutos();
  }
  const fallosIp        = porIp.count;      // incluye este intento
  const fallosPreviosIp = fallosIp - 1;
  const fallosPrevios   = total.count - 1;  // de todas las conexiones, sin este intento
  // Mismas reglas de antes: con 5 fallos previos desde esta conexión, este
  // intento (el 6.º) queda bloqueado; con 30 fallos previos en total, se
  // bloquea a las conexiones que ya fallaron alguna vez.
  if (fallosIp > MAX_POR_IP || (fallosPrevios >= MAX_TOTAL && fallosPreviosIp > 0)) {
    await reclasificar('auth/login-bloqueado', 'warn', 'Intento de acceso bloqueado por el límite de intentos');
    return redirect('/admin/login?error=bloqueado');
  }

  if (!expected || !igualesSeguro(password, expected)) {
    // El intento ya quedó registrado como fallido en el paso 1.
    return redirect('/admin/login?error=1');
  }

  await reclasificar('auth/login-ok', 'info', 'Acceso al panel');

  // Cookie de sesión: token firmado que vence en 8 horas (httpOnly).
  cookies.set(COOKIE_ADMIN, crearTokenAdmin(), {
    path:     '/',
    httpOnly: true,
    sameSite: 'lax',   // 'lax' permite que la cookie viaje en el redirect de vuelta de Google OAuth
    secure:   import.meta.env.PROD,
    maxAge:   DURACION_SESION_MS / 1000,
  });

  return redirect('/admin');
};
