import { supabase } from './supabase';
import { todayCL } from './dateUtils';

// Horas extra en un día específico — a pedido de Valentina (3 oct 2026): abrir
// una hora solo para una fecha (ej. para recuperar las horas que se pierden por
// un feriado) sin que se repita todas las semanas como el horario normal.
// Se guardan en settings ('horas_extra', JSON) para no necesitar tablas nuevas.
// La agenda pública y la de reagendar las suman al horario de ese día. Un día
// bloqueado (feriado, vacaciones) sigue cerrado aunque tenga horas extra.

export type ModalidadExtra = 'presencial' | 'online' | 'ambos';
// servicioId: si viene, la hora es solo para ese servicio; si no, para todos los
// servicios de esa modalidad.
// quitar: en vez de abrir una hora, la QUITA solo ese día para ese servicio
// (excepción a su horario semanal). Se deshace borrando la entrada.
export interface HoraExtra { id: string; fecha: string; hora: string; modalidad: ModalidadExtra; servicioId?: string; quitar?: boolean }

const KEY = 'horas_extra';

export async function leerHorasExtra(): Promise<HoraExtra[]> {
  return (await leerParaModificar()) ?? [];
}

// Lectura estricta para modificar la lista: si la base falla (o el JSON está
// dañado) devuelve null y NO se guarda nada. Antes una falla momentánea se
// leía como lista vacía y el guardado siguiente borraba todas las horas
// abiertas y quitadas (re-auditoría 4 oct 2026).
async function leerParaModificar(): Promise<HoraExtra[] | null> {
  const { data, error } = await supabase.from('settings').select('value').eq('key', KEY).maybeSingle();
  if (error) return null;
  try {
    const lista = JSON.parse(data?.value || '[]');
    return Array.isArray(lista) ? lista.filter((h: HoraExtra) => h?.fecha && h?.hora) : null;
  } catch { return null; }
}

async function guardar(lista: HoraExtra[]): Promise<boolean> {
  // Se guardan solo las de hoy en adelante (las pasadas ya no sirven).
  const hoy = todayCL();
  const vigentes = lista.filter(h => h.fecha >= hoy).sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));
  const { error } = await supabase.from('settings').upsert(
    { key: KEY, value: JSON.stringify(vigentes), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  return !error;
}

export async function agregarHoraExtra(fecha: string, hora: string, modalidad: ModalidadExtra, servicioId?: string): Promise<boolean> {
  let lista = await leerParaModificar();
  if (!lista) return false;
  // Abrir una hora que se había quitado "solo este día" para ese servicio:
  // se borra la excepción (si no, la hora abierta quedaba escondida).
  if (servicioId) lista = lista.filter(h => !(h.quitar && h.fecha === fecha && h.hora === hora && h.servicioId === servicioId));
  const repetida = lista.some(h => !h.quitar && h.fecha === fecha && h.hora === hora &&
    (servicioId ? h.servicioId === servicioId : (!h.servicioId && (h.modalidad === modalidad || h.modalidad === 'ambos'))));
  if (repetida) return true;
  lista.push({ id: crypto.randomUUID(), fecha, hora, modalidad, ...(servicioId ? { servicioId } : {}) });
  return guardar(lista);
}

export async function quitarHoraExtra(id: string): Promise<boolean> {
  const lista = await leerParaModificar();
  if (!lista) return false;
  return guardar(lista.filter(h => h.id !== id));
}

/** ¿La hora extra aplica a este servicio (por servicio o por su modalidad)? */
export function aplicaA(h: HoraExtra, modalidadServicio: string | null | undefined, serviceId?: string | null): boolean {
  if (h.servicioId) return h.servicioId === serviceId; // hora solo para un servicio
  if (!modalidadServicio || modalidadServicio === 'ambos' || h.modalidad === 'ambos') return true;
  return h.modalidad === modalidadServicio;
}

/** Quita una hora de un servicio SOLO en esa fecha (su horario semanal no cambia). */
export async function quitarHoraDelDia(fecha: string, hora: string, servicioId: string): Promise<boolean> {
  if (fecha < todayCL()) return false; // un día que ya pasó no se guarda
  const lista = await leerParaModificar();
  if (!lista) return false;
  if (lista.some(h => h.quitar && h.fecha === fecha && h.hora === hora && h.servicioId === servicioId)) return true;
  lista.push({ id: crypto.randomUUID(), fecha, hora, modalidad: 'ambos', servicioId, quitar: true });
  return guardar(lista);
}

/** ¿Esa hora de ese servicio está quitada ese día? */
export function estaQuitada(lista: HoraExtra[], fecha: string, hora: string, servicioId: string | null | undefined): boolean {
  return !!servicioId && lista.some(h => h.quitar && h.fecha === fecha && h.hora === hora && h.servicioId === servicioId);
}
