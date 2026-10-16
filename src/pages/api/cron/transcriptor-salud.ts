// GET /api/cron/transcriptor-salud — chequeo diario del transcriptor (paquete P8).
// Vercel Cron (vercel.json: "0 11 * * *" = 08:00 de Chile en verano) con Authorization: Bearer
// <CRON_SECRET>; también acepta la clave interna de pg_cron (src/lib/cronAuth.ts). Falla cerrado.
// 1) Chequeos de salud (src/lib/transcriptor/salud.ts): cada falla → aviso en el panel (+ correo de
//    respaldo); si todo está bien no avisa nada, solo guarda transcriptor_salud.
// 2) Reporte del mes anterior en transcriptor_reportes si todavía no existe (src/lib/transcriptor/reporte.ts).
// La respuesta no lleva datos clínicos ni de pacientes (solo nombres de chequeos y ok/no ok).
import type { APIRoute } from 'astro';
import { cronAutorizado } from '../../../lib/cronAuth';
import { registrarAlerta, sanearTexto } from '../../../lib/transcriptor/alertas';
import { ejecutarSaludReal } from '../../../lib/transcriptor/salud';
import { reporteDelMesAnteriorSiFalta } from '../../../lib/transcriptor/reporte';

export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const GET: APIRoute = async ({ request }) => {
  if (!(await cronAutorizado(request))) return new Response('Unauthorized', { status: 401 });

  const ahora = new Date();
  let salud: Awaited<ReturnType<typeof ejecutarSaludReal>> | null = null;
  try {
    salud = await ejecutarSaludReal(ahora);
  } catch (e) {
    const detalle = sanearTexto(e instanceof Error ? e.message : String(e), 300);
    console.error('[cron/transcriptor-salud] el chequeo falló:', detalle);
    await registrarAlerta({ tipo: 'salud', clave: 'salud:cron', accion: 'revisar', titulo: 'El chequeo diario del transcriptor no pudo correr', detalle });
    return json({ ok: false, error: 'el chequeo falló' }, 500);
  }

  let reporte: { mes: string; generado: boolean } | { error: string } | null = null;
  if (salud.activo) {
    try {
      reporte = await reporteDelMesAnteriorSiFalta(ahora);
    } catch (e) {
      const detalle = sanearTexto(e instanceof Error ? e.message : String(e), 300);
      console.error('[cron/transcriptor-salud] reporte mensual:', detalle);
      await registrarAlerta({ tipo: 'salud', clave: 'salud:reporte', accion: 'revisar', titulo: 'No se pudo generar el reporte mensual del transcriptor', detalle });
      reporte = { error: 'no se pudo generar' };
    }
  }

  return json({ ok: salud.ok, activo: salud.activo, alertas: salud.alertas, resultados: salud.resultados, reporte });
};
