import type { APIRoute } from 'astro';
import { procesarEventoBot, type AlmacenamientoBot } from '../../../lib/transcriptor/bot';

export const prerender = false;

// Eventos del bot de Meet (máquina efímera en Fly). Público, sin cookie: se autentica con
// `Authorization: Bearer <token de un uso>` cuyo HMAC está en grabaciones.bot_token_sha256.
// Solo acepta POST y NO permite leer nada: responde {ok:true} o, en `pide_url`, la URL PUT
// prefirmada del segmento de audio de ESA grabación. Token falso/vencido/revocado → 404
// genérico. Lógica y validación en src/lib/transcriptor/bot.ts (procesarEventoBot).

// Almacenamiento (paquete P1): se carga si el archivo existe. Así este endpoint compila aunque
// P1 aún no esté integrado; mientras falte, pide_url / segmento_subido responden 503.
// (Vite reconoce el texto literal `import.meta.glob(`; el ts-ignore es porque los tipos de
// Vite solo existen tras `astro sync`.)
// @ts-ignore
const modulosAlmacenamiento: Record<string, () => Promise<unknown>> = import.meta.glob('../../../lib/transcriptor/almacenamiento.ts');

async function almacenamiento(): Promise<AlmacenamientoBot | null> {
  const cargar = Object.values(modulosAlmacenamiento)[0];
  if (!cargar) return null;
  const m = (await cargar()) as Record<string, unknown>;
  const candidato = m.almacenamiento ?? m.default
    ?? (typeof m.crearAlmacenamiento === 'function' ? (m.crearAlmacenamiento as () => unknown)() : null);
  const a = candidato as Partial<AlmacenamientoBot> | null;
  return a && typeof a.urlSubida === 'function' && typeof a.head === 'function' ? (a as AlmacenamientoBot) : null;
}

const json = (status: number, cuerpo: Record<string, unknown>) => new Response(JSON.stringify(cuerpo), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export const POST: APIRoute = async ({ request, clientAddress }) => {
  try {
    const r = await procesarEventoBot({
      authorization: request.headers.get('authorization'),
      cuerpoTexto: await request.text(),
      request,
      clientAddress,
    }, { almacenamiento });
    return json(r.status, r.cuerpo);
  } catch (e) {
    console.warn('[transcriptor/bot-evento] error:', e instanceof Error ? e.message : e);
    return json(503, { error: 'Intenta de nuevo' });
  }
};

// Cualquier otro método: mismo 404 genérico (no se puede leer nada por aquí).
export const ALL: APIRoute = () => json(404, { error: 'No encontrado' });
