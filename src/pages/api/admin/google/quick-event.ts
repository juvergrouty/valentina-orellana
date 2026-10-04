import type { APIRoute } from 'astro';
import { getValidAccessToken } from '../../../../lib/syncCalendar';

export const prerender = false;

// POST — crea un evento rápido en el Google Calendar de Valentina (página
// Calendario del panel). Antes el navegador llamaba a Google directo con el
// token de acceso de la cuenta incrustado en la página.
export const POST: APIRoute = async ({ request }) => {
  let body: { summary?: string; date?: string; start?: string; end?: string };
  try { body = await request.json(); }
  catch { return json({ error: 'Body inválido' }, 400); }

  const summary = String(body.summary ?? '').trim().slice(0, 200);
  const { date, start, end } = body;
  if (!summary || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^\d{2}:\d{2}$/.test(start ?? '') || !/^\d{2}:\d{2}$/.test(end ?? '')) {
    return json({ error: 'Faltan datos del evento.' }, 400);
  }

  try {
    const auth = await getValidAccessToken();
    if (!auth) return json({ error: 'Google Calendar no conectado' }, 503);
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary,
        start: { dateTime: `${date}T${start}:00`, timeZone: 'America/Santiago' },
        end:   { dateTime: `${date}T${end}:00`,   timeZone: 'America/Santiago' },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return json({ error: `Google respondió ${res.status}` }, 502);
    return json({ success: true });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
