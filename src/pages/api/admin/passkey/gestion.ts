import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { logInfo, logWarn } from '../../../../lib/logger';
import { COOKIE_ADMIN, nivelTokenAdmin } from '../../../../lib/adminSession';
import { puedeEliminar, puedeGestionar } from '../../../../lib/passkey/nucleo';
import {
  SETTING_OBLIGATORIA, estadoPasskeys, invalidarEstadoPasskeys, nuevosCodigosRespaldo, opcionesAcceso,
  opcionesRegistro, ponerSesion, rpDe, verificarAcceso, verificarRegistro,
} from '../../../../lib/passkey/servidor';

export const prerender = false;

// Pantalla Seguridad del panel (16 oct 2026). Protegida por el middleware
// (sesión del panel + mismo origen). Todo por JSON {accion, ...}:
//   registro-opciones / registro-verificar {respuesta, nombre} → agregar passkey
//   confirmar-opciones / confirmar {respuesta}                → confirmar esta sesión con passkey
//   eliminar {id} · obligatoria {valor} · regenerar-codigos
// Si ya hay passkeys, todo menos "confirmar" exige una sesión confirmada con
// passkey (o código de respaldo): la contraseña sola no puede agregar una
// passkey ajena, borrar las de Vale ni apagar la obligatoriedad.

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ request, cookies, url }) => {
  const token = cookies.get(COOKIE_ADMIN)?.value ?? '';
  const nivel = nivelTokenAdmin(token);
  if (!nivel) return json({ error: 'No autorizado.' }, 401);
  // El desafío queda ligado a esta sesión (firma del token).
  const vinculo = `s:${token.split('.')[2]}`;

  let cuerpo: { accion?: string; respuesta?: unknown; nombre?: unknown; id?: unknown; valor?: unknown };
  try { cuerpo = await request.json(); } catch { return json({ error: 'Solicitud inválida.' }, 400); }

  let estado;
  try { estado = await estadoPasskeys(); }
  catch { return json({ error: 'No pude leer la configuración de passkeys. Intenta en unos minutos.' }, 503); }
  if (estado.migracionPendiente) return json({ error: 'Falta aplicar la migración 0015 en Supabase.' }, 409);

  const rp = rpDe(url);
  const accion = cuerpo.accion ?? '';
  const necesitaRp = ['registro-opciones', 'registro-verificar', 'confirmar-opciones', 'confirmar'].includes(accion);
  if (necesitaRp && !rp) return json({ error: 'Las passkeys solo se pueden usar en valentinaorellana.cl.' }, 400);

  // Confirmar esta sesión con passkey (sube de "solo contraseña" a "con passkey").
  if (accion === 'confirmar-opciones') {
    if (estado.cantidad === 0) return json({ error: 'Aún no hay passkeys registradas.' }, 400);
    return json(await opcionesAcceso(rp!, vinculo));
  }
  if (accion === 'confirmar') {
    const r = await verificarAcceso(rp!, vinculo, cuerpo.respuesta as never);
    if (!r.ok) {
      if (r.detalle) await logWarn('auth/passkey', 'Passkey rechazada al confirmar la sesión', { detalle: r.detalle });
      return json({ error: r.error }, 400);
    }
    ponerSesion(cookies, 'passkey');
    await logInfo('auth/passkey-ok', `Sesión del panel confirmada con passkey (${r.nombre})`);
    return json({ ok: true });
  }

  if (!puedeGestionar(nivel, estado)) {
    return json({ error: 'Primero confirma esta sesión con tu passkey (botón "Confirmar con passkey").', confirmar: true }, 403);
  }

  if (accion === 'registro-opciones') {
    return json(await opcionesRegistro(rp!, vinculo));
  }

  if (accion === 'registro-verificar') {
    const r = await verificarRegistro(rp!, vinculo, cuerpo.respuesta as never, cuerpo.nombre);
    if (!r.ok) {
      if (r.detalle) await logWarn('auth/passkey', 'No se pudo registrar una passkey', { detalle: r.detalle });
      return json({ error: r.error }, 400);
    }
    // Registrar una passkey exige Face ID / huella en ese mismo momento: la
    // sesión queda confirmada con passkey (para poder activar la obligatoriedad).
    ponerSesion(cookies, 'passkey');
    await logInfo('auth/passkey-registrada', `Passkey registrada en el panel: ${String(cuerpo.nombre ?? '').slice(0, 60)}`);
    return json({ ok: true, codigos: r.codigos });
  }

  if (accion === 'eliminar') {
    const id = String(cuerpo.id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'Passkey inválida.' }, 400);
    if (!puedeEliminar(estado)) {
      return json({ error: 'Es tu única passkey y la passkey es obligatoria. Agrega otra o desactiva "Passkey obligatoria" antes de eliminarla.' }, 409);
    }
    const { data, error } = await supabase.from('admin_passkeys').delete().eq('id', id).select('nombre');
    invalidarEstadoPasskeys();
    if (error) return json({ error: `No se pudo eliminar: ${error.message}` }, 500);
    await logWarn('auth/passkey-eliminada', `Passkey eliminada del panel: ${data?.[0]?.nombre ?? id}`);
    return json({ ok: true });
  }

  if (accion === 'obligatoria') {
    const valor = cuerpo.valor === true;
    if (valor && estado.cantidad === 0) return json({ error: 'Registra al menos una passkey antes de hacerla obligatoria.' }, 409);
    if (valor && estado.codigosRestantes === 0) return json({ error: 'Genera tus códigos de respaldo antes de hacerla obligatoria.' }, 409);
    const { error } = await supabase.from('settings').upsert(
      { key: SETTING_OBLIGATORIA, value: valor ? 'true' : 'false', updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
    invalidarEstadoPasskeys();
    if (error) return json({ error: `No se pudo guardar: ${error.message}` }, 500);
    await logWarn('auth/passkey-obligatoria', valor ? 'Passkey obligatoria ACTIVADA para entrar al panel' : 'Passkey obligatoria DESACTIVADA (basta la contraseña si se omite)');
    return json({ ok: true });
  }

  if (accion === 'regenerar-codigos') {
    if (estado.cantidad === 0) return json({ error: 'Registra primero una passkey.' }, 409);
    try {
      const codigos = await nuevosCodigosRespaldo();
      await logWarn('auth/codigos-respaldo', 'Códigos de respaldo nuevos generados; los anteriores ya no sirven');
      return json({ ok: true, codigos });
    } catch (e) {
      return json({ error: `No se pudieron generar los códigos: ${(e as Error).message}` }, 500);
    }
  }

  return json({ error: 'Acción desconocida.' }, 400);
};
