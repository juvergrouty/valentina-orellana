import type { APIRoute } from 'astro';
import { getValidAccessToken } from '../../../../lib/syncCalendar';
import { deleteCalendarEvent } from '../../../../lib/googleCalendar';

export const prerender = false;

// POST — elimina un evento de Google Calendar por su event_id
export const POST: APIRoute = async ({ request }) => {
  let body: { eventId?: string };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Body inválido' }), { status: 400 }); }

  const { eventId } = body;
  if (!eventId) return new Response(JSON.stringify({ error: 'Falta eventId' }), { status: 400 });

  try {
    const auth = await getValidAccessToken();
    if (!auth) return new Response(JSON.stringify({ error: 'Google Calendar no conectado' }), { status: 503 });

    await deleteCalendarEvent(auth.token, auth.calendarId, eventId);
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
};
