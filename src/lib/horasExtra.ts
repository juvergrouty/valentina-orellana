import { supabase } from './supabase';
import { todayCL } from './dateUtils';

// Horas extra en un día específico — a pedido de Valentina (3 oct 2026): abrir
// una hora solo para una fecha (ej. para recuperar las horas que se pierden por
// un feriado) sin que se repita todas las semanas como el horario normal.
// Se guardan en settings ('horas_extra', JSON) para no necesitar tablas nuevas.
// La agenda pública y la de reagendar las suman al horario de ese día. Un día
// bloqueado (feriado, vacaciones) sigue cerrado aunque tenga horas extra.

export type ModalidadExtra = 'presencial' | 'online' | 'ambos';
export interface HoraExtra { id: string; fecha: string; hora: string; modalidad: ModalidadExtra }

const KEY = 'horas_extra';

export async function leerHorasExtra(): Promise<HoraExtra[]> {
  const { data } = await supabase.from('settings').select('value').eq('key', KEY).maybeSingle();
  try {
    const lista = JSON.parse(data?.value || '[]');
    return Array.isArray(lista) ? lista.filter((h: HoraExtra) => h?.fecha && h?.hora) : [];
  } catch { return []; }
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

export async function agregarHoraExtra(fecha: string, hora: string, modalidad: ModalidadExtra): Promise<boolean> {
  const lista = await leerHorasExtra();
  if (lista.some(h => h.fecha === fecha && h.hora === hora && (h.modalidad === modalidad || h.modalidad === 'ambos'))) return true;
  lista.push({ id: crypto.randomUUID(), fecha, hora, modalidad });
  return guardar(lista);
}

export async function quitarHoraExtra(id: string): Promise<boolean> {
  const lista = await leerHorasExtra();
  return guardar(lista.filter(h => h.id !== id));
}

/** ¿La hora extra aplica a un servicio de esta modalidad? */
export function aplicaA(h: HoraExtra, modalidadServicio: string | null | undefined): boolean {
  if (!modalidadServicio || modalidadServicio === 'ambos' || h.modalidad === 'ambos') return true;
  return h.modalidad === modalidadServicio;
}
