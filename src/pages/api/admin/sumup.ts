import type { APIRoute } from 'astro';
import { supabase } from '../../../lib/supabase';
import { logInfo, logError } from '../../../lib/logger';
import {
  sumupConfigurado, leerEstado, sesionesParaElegir, sincronizarSumUp, cobroPorCodigo, registrarPagoSumUp,
  ignorarCobro, quitarDePorAsociar, crearLinkSumUp, cobrosExitosos, porAsociarVigentes,
  sesionesParaAsociar, asociarSinBoleta, asociacionesSinBoleta,
} from '../../../lib/sumup';
import { codigoValido } from '../../../lib/sumupMatch';

export const prerender = false;

// Cobros con SumUp desde el panel (18 nov 2026, ver src/lib/sumup.ts). Ruta protegida por el
// middleware de /api/admin; los POST además exigen X-Panel: 1 (igual que los demás del panel).
const json = (b: unknown, status = 200) => Response.json(b, { status });
const esId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

// GET → cobros por asociar, últimos cobros y sesiones sin pagar para elegir.
export const GET: APIRoute = async () => {
  if (!sumupConfigurado()) return json({ ok: true, configurado: false });
  try {
    const [estado, pendientes, sesiones, sesionesPaciente, recientes] = await Promise.all([
      leerEstado(), porAsociarVigentes(), sesionesParaElegir(), sesionesParaAsociar(), cobrosExitosos(new Date(Date.now() - 14 * 86400_000).toISOString()),
    ]);
    const sinBoleta = await asociacionesSinBoleta(recientes.map((c) => c.codigo));
    const codigos = recientes.map((c) => `sumup-${c.codigo}`);
    const { data: usadas } = codigos.length
      ? await supabase.from('bookings').select('id, patient_name, session_date, session_time, mp_payment_id').in('mp_payment_id', codigos)
      : { data: [] as any[] };
    const porCodigo = new Map<string, any[]>();
    for (const u of usadas ?? []) porCodigo.set(u.mp_payment_id.slice(6), [...(porCodigo.get(u.mp_payment_id.slice(6)) ?? []), u]);
    const ignorados = new Set(estado.ignorados);
    return json({
      ok: true, configurado: true,
      porAsociar: pendientes,
      recientes: recientes.map((c) => ({ ...c, sesiones: porCodigo.get(c.codigo) ?? [], ignorado: ignorados.has(c.codigo), sinBoleta: sinBoleta.get(c.codigo) ?? null })),
      sesiones,
      sesionesPaciente,
    });
  } catch (e) {
    console.error('[sumup] GET:', (e as Error).message);
    return json({ ok: false, error: 'No se pudo conectar con SumUp. Intenta de nuevo en un minuto.' }, 502);
  }
};

export const POST: APIRoute = async ({ request }) => {
  if (request.headers.get('X-Panel') !== '1') return json({ error: 'No autorizado.' }, 403);
  if (!sumupConfigurado()) return json({ error: 'SumUp todavía no está conectado en la página.' }, 400);
  const body = await request.json().catch(() => ({}));
  const action = body?.action;
  try {
    if (action === 'sincronizar') {
      const r = await sincronizarSumUp();
      return json({ ok: true, ...r });
    }
    if (action === 'asociar') {
      const ids = Array.isArray(body.ids) ? body.ids.filter(esId).slice(0, 10) : [];
      if (!codigoValido(body.codigo) || !ids.length) return json({ error: 'Elige el cobro y la sesión.' }, 400);
      // El cobro se vuelve a leer en SumUp: nunca se marca pagada una sesión con datos del navegador.
      const cobro = await cobroPorCodigo(body.codigo);
      if (!cobro) return json({ error: 'SumUp no muestra ese cobro como exitoso.' }, 400);
      const r = await registrarPagoSumUp(ids, cobro, 'panel');
      if (!r.ok) return json({ error: r.error }, 409);
      // Ya quedó pagada: si limpiar la lista falla, igual se informa éxito (la lista oculta los usados).
      await quitarDePorAsociar(body.codigo).catch((e) => console.error('[sumup] quitar de la lista:', (e as Error).message));
      return json({ ok: true, pagadas: r.pagadas });
    }
    if (action === 'asociar_paciente') {
      if (!codigoValido(body.codigo) || !esId(body.id)) return json({ error: 'Elige el cobro y la sesión.' }, 400);
      const cobro = await cobroPorCodigo(body.codigo);
      if (!cobro) return json({ error: 'SumUp no muestra ese cobro como exitoso.' }, 400);
      const r = await asociarSinBoleta(body.id, cobro, typeof body.resto === 'string' ? body.resto : '');
      return r.ok ? json({ ok: true, quedoPagada: r.quedoPagada }) : json({ error: r.error }, 409);
    }
    if (action === 'ignorar') {
      if (!codigoValido(body.codigo)) return json({ error: 'Cobro no válido.' }, 400);
      await ignorarCobro(body.codigo);
      await logInfo('sumup/ignorar', 'Cobro de SumUp marcado como "no es de una sesión"', { codigo: body.codigo });
      return json({ ok: true });
    }
    if (action === 'link') {
      if (!esId(body.bookingId)) return json({ error: 'Sesión no válida.' }, 400);
      const r = await crearLinkSumUp(body.bookingId);
      return r.ok ? json({ ok: true, url: r.url }) : json({ error: r.error }, 400);
    }
    return json({ error: 'Acción no válida.' }, 400);
  } catch (e) {
    const que: Record<string, string> = { sincronizar: 'revisar los cobros', link: 'crear el link de pago', asociar: 'asociar el cobro', asociar_paciente: 'asociar el cobro al paciente', ignorar: 'marcar "No es de una sesión"' };
    await logError('sumup/panel', `No se pudo ${que[String(action)] ?? 'completar la acción'} con SumUp.`, { error: (e as Error).message }).catch(() => {});
    return json({ error: 'No se pudo conectar con SumUp. Intenta de nuevo en un minuto.' }, 502);
  }
};
