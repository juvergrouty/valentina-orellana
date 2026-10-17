// Seguir trabajando DESPUÉS de responder (17 oct 2026, velocidad del pipeline).
//
// Vercel (Fluid compute) deja que una función siga corriendo tras enviar la respuesta si se le entrega la
// promesa con `waitUntil`, hasta su maxDuration (300 s en este proyecto). El adaptador @astrojs/vercel 11
// no lo expone en Astro, y @vercel/functions no es dependencia directa; su implementación (v3.9.11,
// wait-until.js + get-context.js) es solo esto: leer el contexto de la petición que Vercel deja en
// globalThis[Symbol.for('@vercel/request-context')] y llamar a su waitUntil. Lo replicamos sin agregar
// dependencias. Fuera de Vercel (local, pruebas) no existe y se devuelve false: el cron del minuto cubre.

type ContextoVercel = { waitUntil?: (p: Promise<unknown>) => void };
const SIMBOLO = Symbol.for('@vercel/request-context');

export function contextoVercel(): ContextoVercel {
  const g = globalThis as unknown as Record<symbol, { get?: () => ContextoVercel } | undefined>;
  return g[SIMBOLO]?.get?.() ?? {};
}

/** Registra trabajo para después de responder. true si Vercel lo aceptó. Nunca lanza. */
export function despuesDeResponder(trabajo: () => Promise<unknown>, ctx: ContextoVercel = contextoVercel()): boolean {
  if (typeof ctx.waitUntil !== 'function') return false;
  try {
    ctx.waitUntil(trabajo().catch((e) => console.warn('[transcriptor] trabajo tras responder:', e instanceof Error ? e.message.slice(0, 200) : 'error')));
    return true;
  } catch {
    return false;
  }
}
