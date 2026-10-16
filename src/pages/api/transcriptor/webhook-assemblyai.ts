import type { APIRoute } from 'astro';
import { WEBHOOK_HEADER_ASSEMBLYAI } from '../../../lib/transcriptor/tipos';
import { assemblyAIDesdeEnv, procesarWebhookAssemblyAI, repoWebhookSupabase } from '../../../lib/transcriptor/assemblyai';

export const prerender = false;

// Webhook de AssemblyAI (paquete P2). Público: lo autentica la cabecera X-VO-Webhook, cuyo valor
// (ASSEMBLYAI_WEBHOOK_SECRET) enviamos nosotros al crear cada transcript (webhook_auth_header_name/value).
// AssemblyAI exige 2xx en < 10 s y no reintenta tras un 4xx (https://www.assemblyai.com/docs/deployment/webhooks):
//  - cabecera inválida → 401 sin tocar la base; cuerpo inválido → 400;
//  - falta la variable o falla la consulta a AssemblyAI → 503 (reintenta; el cron además sondea);
//  - todo lo demás → 200 rápido. Aquí NO se descarga ni se guarda texto: solo se marca el segmento y el
//    orquestador (cron P6) descarga, cifra y guarda en el minuto siguiente.
// No confía en el cuerpo: vuelve a pedir el estado a AssemblyAI con nuestra llave.

export const POST: APIRoute = async ({ request }) => {
  const secreto = import.meta.env.ASSEMBLYAI_WEBHOOK_SECRET;
  const cabecera = request.headers.get(WEBHOOK_HEADER_ASSEMBLYAI);
  let cuerpo = '';
  try { cuerpo = await request.text(); } catch { /* cuerpo vacío → 400 más abajo */ }

  try {
    const { supabase } = await import('../../../lib/supabase');
    const resultado = await procesarWebhookAssemblyAI(
      { cabecera, cuerpo, secreto },
      {
        repo: repoWebhookSupabase(supabase),
        // Consulta rápida (1 intento, 6 s) para responder dentro de los 10 s de AssemblyAI.
        aai: { obtener: (id) => assemblyAIDesdeEnv({ intentos: 1, timeoutMs: 6_000 }).obtener(id) },
      },
    );
    if (resultado.efecto === 'no_configurado') {
      const { logError } = await import('../../../lib/logger');
      await logError('transcriptor/webhook', 'Falta ASSEMBLYAI_WEBHOOK_SECRET en Vercel: no se pueden recibir avisos de AssemblyAI');
    }
    return new Response(resultado.http === 200 ? 'ok' : resultado.efecto, {
      status: resultado.http,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (e) {
    // Error de base u otro inesperado: 500 → AssemblyAI reintenta. Sin datos del cuerpo en el registro.
    try {
      const { logError } = await import('../../../lib/logger');
      await logError('transcriptor/webhook', 'Error procesando webhook de AssemblyAI', { error: e instanceof Error ? e.message.slice(0, 300) : 'desconocido' });
    } catch { /* sin registro */ }
    return new Response('Error', { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
};
