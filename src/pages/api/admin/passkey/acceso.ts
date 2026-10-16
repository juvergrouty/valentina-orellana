import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { logInfo, logWarn } from '../../../../lib/logger';
import { pasoDosBloqueado, puedeOmitirPasskey } from '../../../../lib/passkey/nucleo';
import {
  borrarPaso, estadoPasskeys, leerPaso, opcionesAcceso, ponerSesion, rpDe, usarCodigoRespaldo, verificarAcceso,
} from '../../../../lib/passkey/servidor';
import { conVolver, destinoSeguro } from '../../../../lib/passkey/regreso';

export const prerender = false;

// Segundo paso del login (16 oct 2026). Público en el middleware, pero solo
// funciona con la cookie de paso intermedio (contraseña correcta hace menos de
// 10 minutos; SameSite=strict, así que otra página no puede usarla).
//   JSON {accion:'opciones'}             → opciones de WebAuthn (challenge nuevo)
//   JSON {accion:'verificar', respuesta} → verifica Face ID / huella y abre el panel
//   form accion=codigo, codigo=…         → código de respaldo de un solo uso
//   form accion=omitir                   → "Entrar sin passkey esta vez" (solo si no es obligatoria)
//
// Límite de intentos: los fallos se registran en admin_logs ('auth/2fa-fallido')
// ANTES de revisar; con más de 10 en 15 minutos (o más de 5 desde la misma IP) se pide la
// contraseña de nuevo.
const VENTANA_MS = 15 * 60 * 1000;

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, cookies, redirect, url, clientAddress }) => {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || clientAddress || 'desconocida';
  const esJson = (request.headers.get('content-type') ?? '').includes('application/json');

  // Igual que el resto de /api/admin: solo desde páginas de este mismo sitio.
  const origen = request.headers.get('origin') || request.headers.get('referer');
  if (origen) {
    let host = '';
    try { host = new URL(origen).host; } catch { /* inválido */ }
    const propios = [url.host, request.headers.get('host'), request.headers.get('x-forwarded-host')].filter(Boolean);
    if (!propios.includes(host)) return json({ error: 'Origen no permitido.' }, 403);
  }
  const vinculo = leerPaso(cookies);

  if (!vinculo) {
    return esJson ? json({ error: 'Pasaron más de 10 minutos. Vuelve a ingresar tu contraseña.', volver: true }, 401)
      : redirect('/admin/login?error=paso');
  }

  /** Registra un intento de segundo paso como fallido y dice si ya se pasó del límite. */
  const registrarFallo = async (motivo: string): Promise<{ id: string | null; bloqueado: boolean }> => {
    const { data: fila } = await supabase.from('admin_logs')
      .insert({ level: 'warn', context: 'auth/2fa-fallido', message: `Segundo paso del acceso rechazado: ${motivo}`, data: { ip } })
      .select('id').single();
    const desde = new Date(Date.now() - VENTANA_MS).toISOString();
    // Tope global y tope por IP (revisión 16 oct, B8; reglas en nucleo.ts pasoDosBloqueado).
    const [global, porIp] = await Promise.all([
      supabase.from('admin_logs').select('id', { count: 'exact', head: true })
        .eq('context', 'auth/2fa-fallido').gt('created_at', desde),
      supabase.from('admin_logs').select('id', { count: 'exact', head: true })
        .eq('context', 'auth/2fa-fallido').gt('created_at', desde).eq('data->>ip', ip),
    ]);
    return { id: fila?.id ?? null, bloqueado: pasoDosBloqueado(global.count ?? 0, porIp.count ?? 0, !!(global.error || porIp.error)) };
  };
  const anularFallo = async (id: string | null) => {
    if (id) await supabase.from('admin_logs').update({ context: 'auth/2fa-ok', level: 'info', message: 'Segundo paso del acceso correcto' }).eq('id', id);
  };

  if (esJson) {
    let cuerpo: { accion?: string; respuesta?: unknown; volver?: unknown };
    try { cuerpo = await request.json(); } catch { return json({ error: 'Solicitud inválida.' }, 400); }
    const rp = rpDe(url);
    if (!rp) return json({ error: 'La passkey solo funciona en valentinaorellana.cl. Usa un código de respaldo.' }, 400);

    if (cuerpo.accion === 'opciones') {
      try { return json(await opcionesAcceso(rp, vinculo)); }
      catch (e) {
        await logWarn('auth/passkey', 'No se pudieron preparar las opciones de acceso con passkey', { error: (e as Error).message });
        return json({ error: 'No pude preparar la passkey. Intenta en unos minutos.' }, 503);
      }
    }

    if (cuerpo.accion === 'verificar') {
      // Se cuenta como fallido hasta que la verificación pase (como en el login).
      const intento = await registrarFallo('passkey');
      if (intento.bloqueado) {
        borrarPaso(cookies);
        return json({ error: 'Demasiados intentos. Vuelve a ingresar tu contraseña en 15 minutos.', volver: true }, 429);
      }
      const r = await verificarAcceso(rp, vinculo, cuerpo.respuesta as never);
      if (!r.ok) {
        if (r.detalle) await logWarn('auth/passkey', 'Passkey rechazada al entrar', { detalle: r.detalle, ip });
        return json({ error: r.error }, 400);
      }
      await anularFallo(intento.id);
      borrarPaso(cookies);
      ponerSesion(cookies, 'passkey');
      await logInfo('auth/passkey-ok', `Acceso al panel con passkey (${r.nombre})`, { ip });
      // Login con regreso: la página del panel que pidió entrar (validada: solo /admin…).
      return json({ ok: true, ir: destinoSeguro(cuerpo.volver) ?? '/admin' });
    }
    return json({ error: 'Acción desconocida.' }, 400);
  }

  // Formularios (código de respaldo / omitir)
  const form = await request.formData();
  const accion = String(form.get('accion') ?? '');
  const volver = destinoSeguro(form.get('volver')?.toString());

  if (accion === 'codigo') {
    const intento = await registrarFallo('código de respaldo');
    if (intento.bloqueado) { borrarPaso(cookies); return redirect(conVolver('/admin/login?error=bloqueado', volver)); }
    if (!(await usarCodigoRespaldo(String(form.get('codigo') ?? '')))) return redirect(conVolver('/admin/login?paso=passkey&error=codigo', volver));
    await anularFallo(intento.id);
    borrarPaso(cookies);
    ponerSesion(cookies, 'passkey');
    await logWarn('auth/codigo-respaldo', 'Acceso al panel con un código de respaldo (queda inutilizado)', { ip });
    return redirect('/admin/seguridad?codigo_usado=1');
  }

  if (accion === 'omitir') {
    let estado;
    try { estado = await estadoPasskeys(); } catch { return redirect(conVolver('/admin/login?paso=passkey&error=estado', volver)); }
    if (!puedeOmitirPasskey(estado)) return redirect(conVolver('/admin/login?paso=passkey&error=obligatoria', volver));
    borrarPaso(cookies);
    ponerSesion(cookies, 'contrasena');
    await logWarn('auth/passkey-omitida', 'Acceso al panel sin passkey ("Entrar sin passkey esta vez")', { ip });
    return redirect(volver ?? '/admin');
  }

  return redirect(conVolver('/admin/login?paso=passkey', volver));
};
