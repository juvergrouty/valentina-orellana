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
  // Corregido: esta llamada se hace en cada carga de /admin/agenda y
  // /admin/calendario (bloquea el renderizado de la página entera hasta que
  // responde). Sin timeout, un Google lento o caído dejaba el admin "pegado"
  // hasta que Vercel mataba la función — de ahí el calendario que no cargaba.
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     import.meta.env.GOOGLE_CLIENT_ID,
      client_secret: import.meta.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
    signal: AbortSignal.timeout(6000),
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
  location?:    string;   // dirección de la consulta (sesiones presenciales)
  date:         string;   // YYYY-MM-DD
  startTime:    string;   // HH:MM
  durationMin:  number;   // minutos
  attendeeEmail?: string;
  isOnline:     boolean;
  calendarId?:  string;   // default 'primary'
  unpaid?:      boolean;  // reserva aún sin pagar: prefijo + color rojo (ver UNPAID_PREFIX)
  paid?:        boolean;  // reserva ya pagada: color verde
  eventId?:     string;   // id fijo (base32hex): un reintento no puede crear un segundo evento
}

/** Marca visual de una reserva que bloquea la hora pero todavía no está pagada. */
export const UNPAID_PREFIX   = 'Por pagar · ';
export const UNPAID_COLOR_ID = '11'; // rojo ("Tomate") en Google Calendar
export const PAID_COLOR_ID   = '10'; // verde ("Albahaca") en Google Calendar

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
    // "Por pagar · " solo si la paciente NO está invitada: el título lo ve
    // ella en su invitación. Con invitada, el aviso para Valentina es el color rojo.
    summary:     event.unpaid && !event.attendeeEmail ? UNPAID_PREFIX + event.title : event.title,
    description: event.description ?? '',
    start: { dateTime: toISO(startDate), timeZone: TIMEZONE },
    end:   { dateTime: toISO(endDate),   timeZone: TIMEZONE },
  };

  if (event.eventId)   body.id = event.eventId;
  if (event.location)  body.location = event.location;
  if (event.unpaid)    body.colorId = UNPAID_COLOR_ID;
  else if (event.paid) body.colorId = PAID_COLOR_ID;

  if (event.attendeeEmail) {
    body.attendees = [{ email: event.attendeeEmail }];
    body.guestsCanSeeOtherGuests = false;
  }

  // Agregar Google Meet para sesiones online
  if (event.isOnline) {
    body.conferenceData = {
      createRequest: {
        // Único por solicitud (Google lo exige); antes se repetía para la misma fecha y hora.
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  const calId  = event.calendarId ?? 'primary';
  const url    = `${CALENDAR_API}/calendars/${encodeURIComponent(calId)}/events` +
                 (event.isOnline ? '?conferenceDataVersion=1&sendUpdates=all' : '?sendUpdates=all');

  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  let res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

  // 409 con id fijo: ese id ya existe. Si es un evento vigente, es el que creó
  // un intento anterior que se cortó antes de guardar el id → se usa ese (no
  // se crea otro). Si es un evento borrado (Google no deja reusar el id), se
  // crea uno nuevo con id automático (8 oct 2026).
  if (res.status === 409 && event.eventId) {
    const prev = await fetch(`${CALENDAR_API}/calendars/${encodeURIComponent(calId)}/events/${event.eventId}`, { headers });
    if (prev.ok) {
      const p = await prev.json();
      if (p.status !== 'cancelled') {
        return {
          id:       p.id,
          meetLink: p.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === 'video')?.uri,
          htmlLink: p.htmlLink,
        };
      }
    } else if (prev.status !== 404 && prev.status !== 410) {
      // No se pudo comprobar (Google lento/caído): NO se crea otro evento; se
      // reintenta más tarde (un evento duplicado sería una segunda invitación).
      throw new Error(`Google Calendar get event failed (${prev.status}) tras 409`);
    }
    delete body.id;
    if (body.conferenceData) body.conferenceData.createRequest.requestId = crypto.randomUUID();
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  }

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

/** Elimina un evento del calendario */
export async function deleteCalendarEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const res = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
  );
  // 410 (Gone) = ya estaba eliminado en Google Calendar — no es una falla real.
  if (!res.ok && res.status !== 410) {
    throw new Error(`Google Calendar delete event failed (${res.status}): ${await res.text()}`);
  }
}

/** Actualiza fecha/hora de un evento existente */
export async function updateCalendarEventTime(
  accessToken: string,
  calendarId: string,
  eventId: string,
  date: string,
  startTime: string,
  durationMin: number,
  location?: string,
  notify = true, // false: Google no le avisa a la invitada (reagendar "sin aviso")
): Promise<void> {
  const startDate = new Date(`${date}T${startTime}:00`);
  const endDate   = new Date(startDate.getTime() + durationMin * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const toISO = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

  // sendUpdates=all: la invitada recibe la hora nueva en su calendario (Outlook,
  // Apple, etc.); sin esto Google no le avisaba del cambio (auditoría 8 oct 2026).
  // Con notify=false (Valentina reagenda "sin aviso", o una sesión pasada) no.
  const res = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?sendUpdates=${notify ? 'all' : 'none'}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: { dateTime: toISO(startDate), timeZone: TIMEZONE },
        end:   { dateTime: toISO(endDate),   timeZone: TIMEZONE },
        ...(location ? { location } : {}),
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Google Calendar update event failed (${res.status}): ${await res.text()}`);
  }
}

/** Actualiza el título/descripción de un evento existente (renombrar sesión,
 *  cambiar servicio) — antes esto solo se guardaba en la BD, el evento real
 *  en Google Calendar se quedaba con el título viejo para siempre. */
export async function updateCalendarEventTitle(
  accessToken: string,
  calendarId: string,
  eventId: string,
  title: string,
  description?: string,
): Promise<void> {
  const body: Record<string, unknown> = { summary: title };
  if (description !== undefined) body.description = description;
  const res = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    throw new Error(`Google Calendar update title failed (${res.status}): ${await res.text()}`);
  }
}

/** Pasa un evento a "pagado" (quita el prefijo y lo pone en verde; si se indica el
 *  correo del paciente y aún no es invitado, lo invita) o de vuelta a "por
 *  pagar". Solo hace la llamada de escritura si algo realmente cambia. */
/** Agrega un Google Meet a un evento que ya existe (ej. una sesión que se
 *  cambió de presencial a online: su evento se creó sin videollamada). */
export async function agregarMeetAEvento(accessToken: string, calendarId: string, eventId: string): Promise<string | null> {
  const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?conferenceDataVersion=1&sendUpdates=all`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Google Calendar no pudo agregar el Meet (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.hangoutLink ?? data.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === 'video')?.uri ?? null;
}

/** Deuda anulada (no se cobrará): sin "Por pagar" y en gris (Grafito), ni
 *  rojo de deuda ni verde de pagado. No avisa a los invitados (8 oct 2026). */
export const VOIDED_COLOR_ID = '8';
export async function setCalendarEventVoided(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  const base = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`;
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const getRes = await fetch(base, { headers });
  if (getRes.status === 404 || getRes.status === 410) return;
  if (!getRes.ok) throw new Error(`Google Calendar get event failed (${getRes.status}): ${await getRes.text()}`);
  const ev = await getRes.json();
  const summary: string = ev.summary ?? '';
  const body: Record<string, unknown> = { colorId: VOIDED_COLOR_ID };
  if (summary.startsWith(UNPAID_PREFIX)) body.summary = summary.slice(UNPAID_PREFIX.length);
  const res = await fetch(`${base}?sendUpdates=none`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Google Calendar update voided failed (${res.status}): ${await res.text()}`);
}

export async function setCalendarEventPaidState(
  accessToken: string,
  calendarId: string,
  eventId: string,
  paid: boolean,
  attendeeEmail?: string,
): Promise<void> {
  const base = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`;
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const getRes = await fetch(base, { headers });
  if (getRes.status === 404 || getRes.status === 410) return; // el evento ya no existe
  if (!getRes.ok) throw new Error(`Google Calendar get event failed (${getRes.status}): ${await getRes.text()}`);
  const ev = await getRes.json();
  const summary: string = ev.summary ?? '';
  const hasPrefix = summary.startsWith(UNPAID_PREFIX);

  const body: Record<string, unknown> = {};
  let invite = false;
  if (paid) {
    if (hasPrefix) body.summary = summary.slice(UNPAID_PREFIX.length);
    if (ev.colorId !== PAID_COLOR_ID) body.colorId = PAID_COLOR_ID;
    if (attendeeEmail && !(ev.attendees ?? []).some((a: any) => a.email?.toLowerCase() === attendeeEmail.toLowerCase())) {
      body.attendees = [...(ev.attendees ?? []), { email: attendeeEmail }];
      invite = true;
    }
  } else {
    // Con la paciente invitada no se agrega el prefijo (lo vería en su
    // calendario); el color rojo basta para Valentina.
    const tieneInvitados = (ev.attendees ?? []).length > 0;
    if (!hasPrefix && !tieneInvitados) body.summary = UNPAID_PREFIX + summary;
    if (hasPrefix && tieneInvitados) body.summary = summary.slice(UNPAID_PREFIX.length);
    if (ev.colorId !== UNPAID_COLOR_ID) body.colorId = UNPAID_COLOR_ID;
  }
  if (Object.keys(body).length === 0) return;

  const res = await fetch(`${base}?sendUpdates=${invite ? 'all' : 'none'}`, {
    method: 'PATCH', headers, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Google Calendar update paid state failed (${res.status}): ${await res.text()}`);
}

/** Obtiene info del usuario conectado */
export async function getGoogleUserInfo(accessToken: string) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error('Error obteniendo info del usuario');
  return res.json() as Promise<{ email: string; name: string; picture: string }>;
}

/** Quita "Por pagar · " del título si el evento tiene invitados (la paciente
 *  lo veía en su calendario). Devuelve true si cambió algo. */
export async function quitarPrefijoSiHayInvitados(accessToken: string, calendarId: string, eventId: string): Promise<boolean> {
  const base = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`;
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const getRes = await fetch(base, { headers, signal: AbortSignal.timeout(6000) });
  if (!getRes.ok) return false;
  const ev = await getRes.json();
  const summary: string = ev.summary ?? '';
  if (!summary.startsWith(UNPAID_PREFIX) || !(ev.attendees ?? []).length) return false;
  const res = await fetch(`${base}?sendUpdates=none`, {
    method: 'PATCH', headers, body: JSON.stringify({ summary: summary.slice(UNPAID_PREFIX.length) }),
    signal: AbortSignal.timeout(6000),
  });
  return res.ok;
}

/** Intervalos ocupados del calendario (eventos que marcan "ocupado") entre dos
 *  instantes, vía la API FreeBusy. Devuelve [{ start, end }] en ISO. */
export async function busyIntervals(
  accessToken: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<Array<{ start: string; end: string }>> {
  const res = await fetch(`${CALENDAR_API}/freeBusy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin, timeMax, items: [{ id: calendarId }] }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`Google Calendar freeBusy failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }> }> };
  return data.calendars?.[calendarId]?.busy ?? [];
}
