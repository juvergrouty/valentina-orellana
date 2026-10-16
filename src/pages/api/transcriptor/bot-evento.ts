import type { APIRoute } from 'astro';
import { procesarEventoBot, type AlmacenamientoBot } from '../../../lib/transcriptor/bot';
import { almacenamiento as almacenamientoR2 } from '../../../lib/transcriptor/almacenamiento';

export const prerender = false;

// Eventos del bot de Meet (máquina efímera en Fly). Público, sin cookie: se autentica con
// `Authorization: Bearer <token de un uso>` cuyo HMAC está en grabaciones.bot_token_sha256.
// Solo acepta POST y NO permite leer nada: responde {ok:true} o, en `pide_url`, la URL PUT
// prefirmada del segmento de audio de ESA grabación. Token falso/vencido/revocado → 404
// genérico. Lógica y validación en src/lib/transcriptor/bot.ts (procesarEventoBot).

// Almacenamiento (paquete P1): import directo (integrado por P6). Se pasa como función para
// que solo se use en pide_url / segmento_subido.
async function almacenamiento(): Promise<AlmacenamientoBot | null> {
  return almacenamientoR2;
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
