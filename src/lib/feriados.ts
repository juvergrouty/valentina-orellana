import { supabase } from './supabase';
import { todayCL } from './dateUtils';
import { getValidAccessToken } from './syncCalendar';
import { logError } from './logger';

// Cierre automático de feriados — a pedido de Valentina (3 oct 2026): los
// feriados se cierran en la agenda web y quedan anotados en su Google
// Calendar ("Feriado · <nombre>"), sin que ella tenga que hacer nada.
//
// SOLO fechas CONFIRMADAS. Antes de agregar un año nuevo, verificar cada fecha
// contra una fuente oficial: algunos feriados se trasladan por ley y otros
// (Pueblos Indígenas) dependen del solsticio. Verificado el 3 oct 2026 en
// feriados.cl. 2027 queda pendiente: las fuentes no coinciden en el 20/21 de
// junio ni en el 17 de septiembre.
export const FERIADOS_CONFIRMADOS: { fecha: string; nombre: string }[] = [
  { fecha: '2026-10-12', nombre: 'Encuentro de Dos Mundos' },
  { fecha: '2026-10-31', nombre: 'Día de las Iglesias Evangélicas y Protestantes' },
  { fecha: '2026-11-01', nombre: 'Día de Todos los Santos' },
  { fecha: '2026-12-08', nombre: 'Inmaculada Concepción' },
  { fecha: '2026-12-25', nombre: 'Navidad' },
];

// Se cierran con esta anticipación (el aviso del panel sale 14 días antes).
const DIAS_ANTES_CIERRE = 60;
// Fechas ya cerradas automáticamente. Si Valentina quita un bloqueo a mano
// (decide atender ese feriado), no se vuelve a cerrar.
const SETTING_PROCESADOS = 'feriados_cerrados_auto';

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ID fijo por fecha (Google exige letras a-v y dígitos): permite crear el
// evento una sola vez y borrarlo al quitar el bloqueo, sin guardar nada más.
function eventIdCierre(fecha: string): string {
  return `cierre${fecha.replace(/-/g, '')}`;
}

/** Anota un día cerrado en Google Calendar como evento de día completo. */
export async function crearEventoCierre(fecha: string, titulo: string): Promise<void> {
  try {
    const auth = await getValidAccessToken();
    if (!auth) return; // Google Calendar no conectado
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: eventIdCierre(fecha),
          summary: titulo,
          start: { date: fecha },
          end: { date: addDays(fecha, 1) },
          transparency: 'opaque',
        }),
        signal: AbortSignal.timeout(8000),
      },
    );
    // 409 = el evento ya existe (se había creado antes): no es un error.
    if (!res.ok && res.status !== 409) {
      await logError('feriados/calendar', `No se pudo anotar el día cerrado ${fecha} en Google Calendar`, { status: res.status, body: (await res.text()).slice(0, 300) });
    }
  } catch (e) {
    await logError('feriados/calendar', `No se pudo anotar el día cerrado ${fecha} en Google Calendar`, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Quita de Google Calendar el evento de un día cerrado (al desbloquearlo). */
export async function borrarEventoCierre(fecha: string): Promise<void> {
  try {
    const auth = await getValidAccessToken();
    if (!auth) return;
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events/${eventIdCierre(fecha)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(8000) },
    );
    // 404/410 = no existía (bloqueo creado antes de este cambio): nada que borrar.
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      await logError('feriados/calendar', `No se pudo quitar de Google Calendar el día cerrado ${fecha}`, { status: res.status });
    }
  } catch (e) {
    await logError('feriados/calendar', `No se pudo quitar de Google Calendar el día cerrado ${fecha}`, { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Cierra en la web y en Google Calendar los feriados confirmados de los
 *  próximos DIAS_ANTES_CIERRE días que todavía no se hayan cerrado. */
export async function cerrarFeriadosConfirmados(): Promise<{ cerrados: string[] }> {
  const hoy = todayCL();
  const hasta = addDays(hoy, DIAS_ANTES_CIERRE);
  const proximos = FERIADOS_CONFIRMADOS.filter(f => f.fecha >= hoy && f.fecha <= hasta);
  if (!proximos.length) return { cerrados: [] };

  const { data: setting } = await supabase.from('settings').select('value').eq('key', SETTING_PROCESADOS).maybeSingle();
  const procesados = new Set((setting?.value ?? '').split(',').filter(Boolean));
  const pendientes = proximos.filter(f => !procesados.has(f.fecha));
  if (!pendientes.length) return { cerrados: [] };

  const cerrados: string[] = [];
  for (const f of pendientes) {
    const titulo = `Feriado · ${f.nombre}`;
    const { error } = await supabase.from('blocked_dates').upsert({ date: f.fecha, reason: titulo }, { onConflict: 'date' });
    if (error) {
      await logError('feriados/cerrar', `No se pudo cerrar el feriado ${f.fecha} en la agenda web`, { error: error.message });
      continue;
    }
    await crearEventoCierre(f.fecha, titulo);
    procesados.add(f.fecha);
    cerrados.push(f.fecha);
  }

  if (cerrados.length) {
    const { error } = await supabase.from('settings').upsert(
      { key: SETTING_PROCESADOS, value: [...procesados].sort().join(','), updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
    if (error) await logError('feriados/cerrar', 'No se pudo registrar qué feriados ya se cerraron', { error: error.message });
  }
  return { cerrados };
}
