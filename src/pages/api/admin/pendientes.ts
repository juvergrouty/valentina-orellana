import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { COOKIE_ADMIN, tokenAdminValido } from '../../../lib/adminSession';
import { esUuid, json, leerJson, origenPropio } from '../../../lib/transcriptor/peticion';
import { claveValida, FaltaMigracion0023, marcarGestionado, textoValido } from '../../../lib/transcriptor/pendientes';

export const prerender = false;

// POST /api/admin/pendientes — "Ya está hecho" en la franja Pendientes de la ficha (0023).
// Solo registra que Vale lo gestionó: no cambia ninguna regla (si falta una firma, no se graba igual).
// Mismo sitio + X-Panel: 1 + sesión del panel (el middleware ya la exige; aquí falla cerrado igual).
export const POST: APIRoute = async ({ request, url, cookies }) => {
  if (!origenPropio(request, url) || request.headers.get('x-panel') !== '1') return json({ ok: false, error: 'Origen no permitido.' }, 403);
  if (!tokenAdminValido(cookies.get(COOKIE_ADMIN)?.value ?? '')) return json({ ok: false, error: 'Tu sesión del panel venció. Vuelve a entrar.' }, 401);
  const body = await leerJson(request, 4096);
  if (!body) return json({ ok: false, error: 'Pedido inválido.' }, 400);
  const patientId = body.patient_id;
  const texto = textoValido(body.texto);
  if (!esUuid(patientId) || !claveValida(body.clave) || !texto) return json({ ok: false, error: 'Pedido inválido.' }, 400);
  try {
    const { data: pac, error: ep } = await supabase.from('patients').select('id').eq('id', patientId).maybeSingle();
    if (ep) throw new Error(ep.message);
    if (!pac) return json({ ok: false, error: 'No se encontró la ficha.' }, 404);
    const g = await marcarGestionado(supabase, patientId, body.clave, texto);
    return json({ ok: true, gestionado: g });
  } catch (e) {
    if (e instanceof FaltaMigracion0023) return json({ ok: false, error: e.message }, 409);
    console.error('[pendientes]', e instanceof Error ? e.message : e);
    return json({ ok: false, error: 'No se pudo guardar. Intenta de nuevo.' }, 500);
  }
};
