import type { APIRoute } from 'astro';
import { reintentarCalendarioAhora, descartarCalendarioPendiente } from '../../../lib/syncCalendar';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

// Botones de la franja "Google Calendar" del panel (28 oct 2026, ver syncCalendar.ts):
// accion=reintentar → lo intenta ya; accion=descartar → "Ya lo arreglé a mano".
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const id = String(form.get('id') ?? '');
  const accion = form.get('accion') === 'descartar' ? 'descartar' : 'reintentar';
  const destino = rutaInterna(form.get('redirect'), '/admin');
  const sep = destino.includes('?') ? '&' : '?';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return redirect(destino + sep + 'error=calendario_reintento', 303);
  if (accion === 'descartar') {
    const ok = await descartarCalendarioPendiente(id);
    return redirect(destino + sep + (ok ? 'calendario=quitado' : 'error=calendario_reintento'), 303);
  }
  const r = await reintentarCalendarioAhora(id);
  return r.ok
    ? redirect(destino + sep + 'calendario=ok', 303)
    : redirect(destino + sep + 'error=calendario_reintento&detail=' + encodeURIComponent(motivoClaro(r.error ?? '')), 303);
};

// El error técnico de Google (en inglés) queda en el registro; a Valentina se le dice en simple.
function motivoClaro(error: string): string {
  if (/no está conectado/i.test(error)) return 'Google Calendar no está conectado';
  if (/ya no existe/i.test(error)) return 'El evento ya no existe en tu Google Calendar: revisa la sesión y, si corresponde, márcalo como arreglado';
  if (/\((401|403)\)/.test(error)) return 'Google no aceptó el permiso de tu cuenta';
  return 'Google no respondió bien';
}
