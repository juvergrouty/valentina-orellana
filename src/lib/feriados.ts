import { supabase } from './supabase';
import { todayCL } from './dateUtils';
import { getValidAccessToken } from './syncCalendar';
import { logError } from './logger';

// Feriados — a pedido de Valentina: avisarle de cada feriado y que ELLA
// decida si cierra o atiende ese día (5 oct 2026; antes, 3 oct, se cerraban
// solos). Un día cerrado queda anotado en su Google Calendar.
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
    // 409 = ese id ya existe: o el evento sigue ahí, o se borró al quitar el
    // bloqueo (Google guarda los borrados como "cancelados" y no deja reusar el
    // id). Se reactiva con PATCH para que el día vuelva a verse en el calendario.
    if (res.status === 409) {
      const r2 = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(auth.calendarId)}/events/${eventIdCierre(fecha)}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'confirmed', summary: titulo, start: { date: fecha }, end: { date: addDays(fecha, 1) }, transparency: 'opaque' }),
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!r2.ok) await logError('feriados/calendar', `No se pudo volver a anotar el día cerrado ${fecha} en Google Calendar`, { status: r2.status });
      return;
    }
    if (!res.ok) {
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

// ── Decisión de Valentina por feriado (5 oct 2026) ──────────────────────────
// Ya NO se cierran solos: 2 semanas antes aparece un aviso en el panel y ella
// elige "Cerrar el día" o "Atender normal" (puede igual agendar a alguien a
// mano en un día cerrado desde el panel). La decisión queda en settings.
const SETTING_DECISIONES = 'feriados_decision'; // JSON { "YYYY-MM-DD": "cerrar" | "atender" }
export const DIAS_AVISO_FERIADO = 14;

export type DecisionFeriado = 'cerrar' | 'atender';

export async function leerDecisionesFeriados(): Promise<Record<string, DecisionFeriado>> {
  const { data } = await supabase.from('settings').select('value').eq('key', SETTING_DECISIONES).maybeSingle();
  try { const o = JSON.parse(data?.value || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}

/** Aplica la decisión (cierra o abre el día en la web y en Google Calendar) y la guarda. */
export async function decidirFeriado(fecha: string, decision: DecisionFeriado): Promise<boolean> {
  const f = (await listaFeriados()).find(x => x.fecha === fecha);
  if (!f) return false;
  const titulo = `Feriado · ${f.nombre}`;
  if (decision === 'cerrar') {
    const { error } = await supabase.from('blocked_dates').upsert({ date: fecha, reason: titulo }, { onConflict: 'date' });
    if (error) { await logError('feriados/decidir', `No se pudo cerrar el feriado ${fecha}`, { error: error.message }); return false; }
    await crearEventoCierre(fecha, titulo);
  } else {
    const { error } = await supabase.from('blocked_dates').delete().eq('date', fecha);
    if (error) { await logError('feriados/decidir', `No se pudo abrir el feriado ${fecha}`, { error: error.message }); return false; }
    await borrarEventoCierre(fecha);
  }
  const decisiones = await leerDecisionesFeriados();
  decisiones[fecha] = decision;
  const { error } = await supabase.from('settings').upsert(
    { key: SETTING_DECISIONES, value: JSON.stringify(decisiones), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (error) await logError('feriados/decidir', 'No se pudo guardar la decisión del feriado', { fecha, error: error.message });
  return !error;
}

// ── Feriados automáticos (Valentina, 5 oct 2026) ────────────────────────────
// Se descargan solos, una vez al día (tarea google-reviews-refresh), para el
// año en curso y el siguiente, desde api.boostr.cl (calendario de feriados
// legales de Chile; la API del Gobierno, apis.digital.gob.cl, no respondía).
// Verificado el 5 oct 2026: 2026 coincide con FERIADOS_CONFIRMADOS y 2027 con
// feriados.cl (Ley 20.983 para el 17-sep-2027, Ley 21.357 para el 21-jun).
// Solo feriados nacionales (no regionales). Si la descarga falla, se usa lo
// último guardado más FERIADOS_CONFIRMADOS: nunca queda sin feriados.
const SETTING_AUTO = 'feriados_auto'; // JSON { actualizado, lista: [{ fecha, nombre }] }

async function descargarAnio(anio: number): Promise<{ fecha: string; nombre: string }[] | null> {
  try {
    const res = await fetch(`https://api.boostr.cl/holidays/${anio}.json`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.status !== 'success' || !Array.isArray(json.data)) return null;
    const lista = (json.data as { date?: unknown; title?: unknown; type?: unknown; extra?: unknown }[])
      .filter(h => typeof h.date === 'string' && new RegExp(`^${anio}-\\d{2}-\\d{2}$`).test(h.date) && typeof h.title === 'string')
      .filter(h => !/regional/i.test(`${h.type ?? ''} ${h.extra ?? ''}`))
      .map(h => ({ fecha: h.date as string, nombre: String(h.title).slice(0, 100) }));
    return lista.length >= 10 ? lista : null; // un año con menos de 10 feriados es una respuesta rota
  } catch { return null; }
}

/** Descarga y guarda los feriados del año en curso y del siguiente. */
export async function actualizarFeriadosAutomaticos(): Promise<{ ok: boolean; total: number }> {
  const anio = Number(todayCL().slice(0, 4));
  const [a, b] = await Promise.all([descargarAnio(anio), descargarAnio(anio + 1)]);
  if (!a && !b) {
    await logError('feriados/descarga', 'No se pudieron descargar los feriados (se usan los guardados)', { anio });
    return { ok: false, total: 0 };
  }
  const anteriores = await leerFeriadosGuardados();
  // Si un año no se pudo descargar, se conserva lo guardado de ese año.
  const deAnio = (y: number) => anteriores.filter(f => f.fecha.startsWith(`${y}-`));
  const lista = [...(a ?? deAnio(anio)), ...(b ?? deAnio(anio + 1))];
  const { error } = await supabase.from('settings').upsert(
    { key: SETTING_AUTO, value: JSON.stringify({ actualizado: new Date().toISOString(), lista }), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (error) await logError('feriados/descarga', 'No se pudieron guardar los feriados descargados', { error: error.message });
  return { ok: !error, total: lista.length };
}

async function leerFeriadosGuardados(): Promise<{ fecha: string; nombre: string }[]> {
  const { data } = await supabase.from('settings').select('value').eq('key', SETTING_AUTO).maybeSingle();
  try { const o = JSON.parse(data?.value || '{}'); return Array.isArray(o.lista) ? o.lista : []; } catch { return []; }
}

/** Todos los feriados conocidos (descargados + confirmados a mano), sin repetir. */
export async function listaFeriados(): Promise<{ fecha: string; nombre: string }[]> {
  let guardados = await leerFeriadosGuardados();
  if (!guardados.length) {
    // Primera vez (aún no corre la tarea diaria): se descargan ahora.
    await actualizarFeriadosAutomaticos().catch(() => undefined);
    guardados = await leerFeriadosGuardados();
  }
  const porFecha = new Map<string, { fecha: string; nombre: string }>();
  for (const f of guardados) porFecha.set(f.fecha, f);
  for (const f of FERIADOS_CONFIRMADOS) porFecha.set(f.fecha, f); // los verificados a mano mandan
  return [...porFecha.values()].sort((x, y) => x.fecha.localeCompare(y.fecha));
}

export interface FeriadoEstado {
  fecha: string; nombre: string;
  cerrado: boolean;                 // hoy está cerrado en la agenda web
  decision: DecisionFeriado | null; // lo que eligió Valentina (null = no ha decidido)
}

/** Todos los feriados confirmados de hoy en adelante, con su estado. */
export async function estadoFeriados(): Promise<FeriadoEstado[]> {
  const hoy = todayCL();
  const proximos = (await listaFeriados()).filter(f => f.fecha >= hoy);
  if (!proximos.length) return [];
  const [decisiones, { data: cerrados }] = await Promise.all([
    leerDecisionesFeriados(),
    supabase.from('blocked_dates').select('date').in('date', proximos.map(f => f.fecha)),
  ]);
  const setCerrados = new Set((cerrados ?? []).map((r: { date: string }) => r.date));
  return proximos.map(f => ({ ...f, cerrado: setCerrados.has(f.fecha), decision: decisiones[f.fecha] ?? null }));
}

/** Feriados de las próximas 2 semanas sobre los que Valentina aún no decide. */
export async function feriadosPorDecidir(): Promise<FeriadoEstado[]> {
  const hasta = addDays(todayCL(), DIAS_AVISO_FERIADO);
  return (await estadoFeriados()).filter(f => f.fecha <= hasta && !f.decision);
}
