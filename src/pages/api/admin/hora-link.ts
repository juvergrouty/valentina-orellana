import type { APIRoute } from 'astro';
import { agregarLineaNotas } from '../../../lib/apigateway';
import { rutaInterna } from '../../../lib/rutaInterna';
import { MARCA_HORA_VENCIDA_VISTA, MARCA_PASOS_WA_HECHO, MARCA_BOLETA_DATOS_OCULTA } from '../../../lib/horaLinkUtil';

export const prerender = false;

// Botones de «atendido» de los avisos del Inicio de las horas con link (22 nov 2026, horaLink.ts).
// Cada uno deja su propia marca en la sesión; nada se borra y nada más cambia.
const MARCAS: Record<string, string> = {
  vencida_vista: MARCA_HORA_VENCIDA_VISTA,   // «Ya lo vi»: la hora se liberó sin pago
  pasos_hecho: MARCA_PASOS_WA_HECHO,         // «Ya se los mandé»: Pasos a seguir por WhatsApp
  boleta_ocultar: MARCA_BOLETA_DATOS_OCULTA, // «Ocultar»: boleta pendiente de datos (la sesión lo sigue mostrando)
};

export const POST: APIRoute = async ({ request, redirect }) => {
  const form = await request.formData();
  const id = String(form.get('id') ?? '');
  const marca = MARCAS[String(form.get('accion') ?? '')];
  const destino = rutaInterna(form.get('redirect'), '/admin');
  if (!/^[0-9a-f-]{36}$/i.test(id) || !marca) return redirect(destino, 303);
  const ok = await agregarLineaNotas(id, `${marca} ${new Date().toISOString()}`);
  return redirect(ok ? destino : destino + (destino.includes('?') ? '&' : '?') + 'error=aviso_guardar', 303);
};
