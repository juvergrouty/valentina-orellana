import type { APIRoute } from 'astro';
import { agregarLineaNotas } from '../../../lib/apigateway';
import { MARCA_TRANSFERENCIA_REVISADA } from '../../../lib/comprobantes';
import { MARCA_BANCO_OK } from '../../../lib/gmailBancoUtil';
import { emitirBoletasConfirmadas } from '../../../lib/tareasEnvio';
import { rutaInterna } from '../../../lib/rutaInterna';

export const prerender = false;

// Botón "Ya la revisé" de la tarea "Revisar en tu banco la transferencia de…"
// del Inicio (ver getTransferenciasPorRevisar en src/lib/comprobantes.ts).
// Desde el 22 nov 2026 la boleta de una transferencia espera esta revisión (o el
// correo del banco, gmailBanco.ts): al apretarlo, Vale confirma que el dinero llegó
// y se emite la boleta, con la fecha del pago.
export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const ids = String(form.get('ids') ?? '').split(',').filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const destino = rutaInterna(form.get('redirect'), '/admin');
  try {
    if (!ids.length) throw new Error('sin sesiones');
    const iso = new Date().toISOString();
    const ok = await Promise.all(ids.map((id) => agregarLineaNotas(id, `${MARCA_TRANSFERENCIA_REVISADA} ${iso}`)));
    if (ok.includes(false)) throw new Error('no se guardó');
    await Promise.all(ids.map((id) => agregarLineaNotas(id, `${MARCA_BANCO_OK} ${iso} panel`)));
    await emitirBoletasConfirmadas(ids, `banco-${Date.parse(iso)}`);
  } catch {
    return redirect(destino + (destino.includes('?') ? '&' : '?') + 'error=transferencia_guardar', 303);
  }
  return redirect(destino, 303);
};
