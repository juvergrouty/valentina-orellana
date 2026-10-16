import type { APIRoute } from 'astro';
import { procesarEventoBot, type AlmacenamientoBot } from '../../../lib/transcriptor/bot';
import { procesarSesionInicial } from '../../../lib/transcriptor/botCuenta';
import { almacenamiento as almacenamientoR2 } from '../../../lib/transcriptor/almacenamiento';

export const prerender = false;

// Eventos del bot de Meet (máquina efímera en Fly). Público, sin cookie: se autentica con
// `Authorization: Bearer <token de un uso>` cuyo HMAC está en grabaciones.bot_token_sha256.
// Solo acepta POST y NO permite leer nada de pacientes: responde {ok:true}, en `pide_url` la URL
// PUT prefirmada del segmento de audio de ESA grabación y, en modo 'cuenta', en `pide_sesion` la
// sesión de Google del ROBOT (una vez, antes de entrar). Token falso/vencido/revocado → 404
// genérico. Lógica y validación en src/lib/transcriptor/bot.ts (procesarEventoBot).
//
// Con la cabecera `X-VO-Aprovisionar: 1` es la subida de la sesión inicial del robot (la hace la
// máquina "iniciar_sesion" tras el inicio de sesión manual de Vale), autenticada con
// BOT_APROVISIONAR_SECRET. Ver botCuenta.ts y docs/transcriptor/85-robot-meet.md.

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
    if (request.headers.get('x-vo-aprovisionar') === '1') {
      const r = await procesarSesionInicial({ authorization: request.headers.get('authorization'), cuerpoTexto: await request.text() });
      return json(r.status, r.cuerpo);
    }
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
