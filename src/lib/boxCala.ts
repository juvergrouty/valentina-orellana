import { supabase } from './supabase';
import { getValidAccessToken } from './syncCalendar';
import { nowCL } from './dateUtils';

// Box en Espacio Cala (Valentina, 12 oct 2026): desde la nueva consulta en
// Estoril 50 cada hora presencial necesita una hora de box comprada en
// espaciocala.cl (antes se anotaba en Reservo; eso ya no se usa). El panel
// recuerda cada sesión presencial que aún no tiene box, con un botón para
// marcarla como hecha.
//
// Se lee de Google Calendar y no de la tabla de reservas porque ahí llegan
// TODAS las horas presenciales: las de la página (pagadas o con link de pago
// enviado) y las que Valentina agenda en Encuadrado. Una sesión puede tener
// dos eventos (página + Encuadrado, intencional), así que se agrupa por
// fecha y hora: un box por horario.
//
// Si una sesión con box ya comprado se cancela o se mueve, su horario deja de
// estar en el calendario y el panel avisa que libere ese box.
// Un registro por horario en settings ("box_cala:2026-10-15T11:00" → BoxSesion):
// así dos clics seguidos no se pisan (con un solo JSON, uno podía perderse).
const PREFIJO = 'box_cala:';
const DIAS_ADELANTE = 60;
const MAX_PAGINAS = 4; // 4 × 250 eventos: de sobra para 60 días

export type BoxSesion = { slot: string; fecha: string; hora: string; paciente: string };
// error: no se pudo revisar (calendario o base de datos) → el panel lo dice,
// en vez de quedarse callado sin recordar los boxes.
export type AvisosBox = { pendientes: BoxSesion[]; liberar: BoxSesion[]; error: boolean };

async function leerReservados(): Promise<Map<string, BoxSesion>> {
  const { data, error } = await supabase.from('settings').select('key, value').like('key', `${PREFIJO}%`);
  if (error) throw new Error(error.message);
  const out = new Map<string, BoxSesion>();
  for (const fila of data ?? []) {
    const slot = String(fila.key).slice(PREFIJO.length);
    let v: Partial<BoxSesion> = {};
    try { v = JSON.parse(fila.value || '{}') ?? {}; } catch { /* fila ilegible: igual cuenta como reservado */ }
    out.set(slot, { slot, fecha: slot.slice(0, 10), hora: slot.slice(11, 16), paciente: String(v.paciente ?? '') });
  }
  return out;
}

/** Nombre del paciente desde el título del evento.
 *  Página:     "Por pagar · Sesión Individual Presencial — Nombre"
 *  Encuadrado: "Nombre Sesión individual Presencial Las Condes" */
export function pacienteDeTitulo(titulo: string): string {
  const t = titulo.replace(/\s+/g, ' ').trim();
  const guion = t.split(' — ');
  if (guion.length > 1) return guion[guion.length - 1].trim();
  const antes = t.split(/\s+sesi[oó]n\b/i)[0].trim();
  return antes && antes !== t ? antes : t;
}

/** Sesiones presenciales futuras del calendario, una por horario. null = no se pudo leer. */
async function sesionesPresenciales(): Promise<Map<string, BoxSesion> | null> {
  const auth = await getValidAccessToken();
  if (!auth) return null;
  const ahora = new Date();
  const hasta = new Date(ahora.getTime() + DIAS_ADELANTE * 86400000);
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events`
    + `?timeMin=${ahora.toISOString()}&timeMax=${hasta.toISOString()}&singleEvents=true&orderBy=startTime&maxResults=250`
    + `&q=${encodeURIComponent('presencial')}&timeZone=America%2FSantiago`;
  const items: Array<{ summary?: string; status?: string; start?: { dateTime?: string } }> = [];
  let pagina: string | undefined;
  for (let i = 0; i < MAX_PAGINAS; i++) {
    const res = await fetch(base + (pagina ? `&pageToken=${encodeURIComponent(pagina)}` : ''),
      { headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    items.push(...(data.items ?? []));
    pagina = data.nextPageToken;
    if (!pagina) break;
  }
  // Lista incompleta: mejor no avisar nada que pedir liberar un box que sí se usa.
  if (pagina) return null;
  const out = new Map<string, BoxSesion>();
  for (const ev of items) {
    const titulo: string = ev.summary ?? '';
    const inicio: string | undefined = ev.start?.dateTime;
    // La búsqueda de Google también mira descripción y lugar: se exige que el
    // título sea de una sesión presencial (página y Encuadrado dicen "Sesión … Presencial").
    if (!inicio || ev.status === 'cancelled' || !/presencial/i.test(titulo) || !/sesi[oó]n/i.test(titulo)) continue;
    // Con timeZone=America/Santiago, dateTime viene en hora de Chile ("2026-10-15T11:00:00-03:00").
    const fecha = inicio.slice(0, 10);
    const hora = inicio.slice(11, 16);
    const slot = `${fecha}T${hora}`;
    // Si hay evento de la página y de Encuadrado, queda el nombre del de la página (nombre completo).
    if (!out.has(slot) || titulo.includes(' — ')) out.set(slot, { slot, fecha, hora, paciente: pacienteDeTitulo(titulo) });
  }
  return out;
}

/** Qué mostrar hoy en el panel. Si no se puede leer el calendario no se pide
 *  liberar nada (mejor callar que pedir liberar un box que sí se usa), pero se
 *  avisa que la revisión falló. */
export async function avisosBoxCala(): Promise<AvisosBox> {
  const sesiones = await sesionesPresenciales().catch(() => null);
  const reservados = await leerReservados().catch(() => null);
  if (!sesiones || !reservados) return { pendientes: [], liberar: [], error: true };
  // Hora de Chile en el mismo formato que los horarios ("2026-10-15T11:00").
  const ahora = nowCL().toISOString().slice(0, 16);
  const pendientes = [...sesiones.values()].filter((s) => !reservados.has(s.slot));
  const liberar = [...reservados.values()]
    .filter((r) => !sesiones.has(r.slot) && r.slot > ahora)
    .sort((a, b) => a.slot.localeCompare(b.slot));
  return { pendientes, liberar, error: false };
}

/** "Ya compré el box" (guarda el horario) o "Ya lo liberé" (lo olvida). */
export async function marcarBoxCala(accion: 'reservado' | 'liberado', s: BoxSesion): Promise<void> {
  const key = PREFIJO + s.slot;
  if (accion === 'reservado') {
    const { error } = await supabase.from('settings').upsert(
      { key, value: JSON.stringify(s), updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from('settings').delete().eq('key', key);
    if (error) throw new Error(error.message);
  }
  // Limpieza: horarios de hace más de 2 días ya no sirven (si falla, no importa).
  const limite = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  await supabase.from('settings').delete().like('key', `${PREFIJO}%`).lt('key', PREFIJO + limite);
}
