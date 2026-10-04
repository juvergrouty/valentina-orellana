import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { logWarn } from '../../../lib/logger';
import { COOKIE_ADMIN, DURACION_SESION_MS, crearTokenAdmin, igualesSeguro } from '../../../lib/adminSession';

export const prerender = false;

// Límite de intentos (3 oct 2026): antes se podían probar contraseñas sin fin.
// Se cuentan los intentos fallidos registrados en admin_logs en los últimos
// 15 minutos: 5 desde la misma conexión, o 30 en total, bloquean 15 minutos
// (incluso con la contraseña correcta).
const VENTANA_MS = 15 * 60 * 1000;
const MAX_POR_IP = 5;
const MAX_TOTAL  = 30;

export const POST: APIRoute = async ({ request, cookies, redirect, clientAddress }) => {
  const form     = await request.formData();
  const password = form.get('password')?.toString() ?? '';
  const expected = import.meta.env.ADMIN_PASSWORD;
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || clientAddress || 'desconocida';

  const desde = new Date(Date.now() - VENTANA_MS).toISOString();
  const [porIp, total] = await Promise.all([
    supabase.from('admin_logs').select('id', { count: 'exact', head: true })
      .eq('context', 'auth/login-fallido').gt('created_at', desde).eq('data->>ip', ip),
    supabase.from('admin_logs').select('id', { count: 'exact', head: true })
      .eq('context', 'auth/login-fallido').gt('created_at', desde),
  ]);
  if ((porIp.count ?? 0) >= MAX_POR_IP || (total.count ?? 0) >= MAX_TOTAL) {
    return redirect('/admin/login?error=bloqueado');
  }

  if (!expected || !igualesSeguro(password, expected)) {
    await logWarn('auth/login-fallido', 'Intento de acceso al panel con contraseña incorrecta', { ip });
    return redirect('/admin/login?error=1');
  }

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
