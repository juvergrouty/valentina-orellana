/**
 * Google Calendar API client
 * Documentación: https://developers.google.com/calendar/api/v3/reference/events/insert
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API     = 'https://www.googleapis.com/calendar/v3';
const TIMEZONE         = 'America/Santiago';

// ─── Token helpers ────────────────────────────────────────────────────────────

/** Refresca el access_token usando el refresh_token guardado */
export async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     import.meta.env.GOOGLE_CLIENT_ID,
      client_secret: import.meta.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  return res.json();
}

/** Intercambia el código de autorización por tokens */
export async function exchangeCodeForTokens(code: string): Promise<{
  access_token:  string;
  refresh_token: string;
  expires_in:    number;
}> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     import.meta.env.GOOGLE_CLIENT_ID,
      client_secret: import.meta.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  import.meta.env.GOOGLE_REDIRECT_URI,
      code,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json();
}

// ─── Calendar helpers ─────────────────────────────────────────────────────────

export interface CalendarEventInput {
  title:        string;
  description?: string;
  date:         string;   // YYYY-MM-DD
  startTime:    string;   // HH:MM
  durationMin:  number;   // minutos
  attendeeEmail?: string;
  isOnline:     boolean;
  calendarId?:  string;   // default 'primary'
}

/** Crea un evento en Google Calendar. Retorna el evento creado (con Meet link si isOnline) */
export async function createCalendarEvent(
  accessToken: string,
  event: CalendarEventInput,
): Promise<{ id: string; meetLink?: string; htmlLink: string }> {
  const [startH, startM] = event.startTime.split(':').map(Number);
  const startDate = new Date(`${event.date}T${event.startTime}:00`);
  const endDate   = new Date(startDate.getTime() + event.durationMin * 60_000);

  const toISO = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  };

  const body: any = {
    summary:     event.title,
    description: event.description ?? '',
    start: { dateTime: toISO(startDate), timeZone: TIMEZONE },
    end:   { dateTime: toISO(endDate),   timeZone: TIMEZONE },
  };

  if (event.attendeeEmail) {
    body.attendees = [{ email: event.attendeeEmail }];
    body.guestsCanSeeOtherGuests = false;
  }

  // Agregar Google Meet para sesiones online
  if (event.isOnline) {
    body.conferenceData = {
      createRequest: {
        requestId: `session-${event.date}-${startH}${startM}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  const calId  = event.calendarId ?? 'primary';
  const url    = `${CALENDAR_API}/calendars/${encodeURIComponent(calId)}/events` +
                 (event.isOnline ? '?conferenceDataVersion=1&sendUpdates=all' : '?sendUpdates=all');

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google Calendar create event failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  return {
    id:       data.id,
    meetLink: data.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === 'video')?.uri,
    htmlLink: data.htmlLink,
  };
}

/** Obtiene las calendarios del usuario para que elija cuál usar */
export async function listCalendars(accessToken: string) {
  const res = await fetch(`${CALENDAR_API}/users/me/calendarList`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Error obteniendo calendarios');
  const data = await res.json();
  return (data.items ?? []).map((c: any) => ({
    id:      c.id,
    summary: c.summary,
    primary: c.primary ?? false,
  }));
}

/** Obtiene info del usuario conectado */
export async function getGoogleUserInfo(accessToken: string) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Error obteniendo info del usuario');
  return res.json() as Promise<{ email: string; name: string; picture: string }>;
}
