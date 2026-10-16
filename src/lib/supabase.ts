import { createClient } from '@supabase/supabase-js';
import { secreto } from './secretos';

const supabaseUrl  = import.meta.env.SUPABASE_URL;
const supabaseKey  = secreto('SUPABASE_SERVICE_ROLE_KEY'); // runtime: nunca incrustada en el build (src/lib/secretos.ts)

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Faltan variables de entorno SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
}

export const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface AvailabilitySlot {
  id: string;
  day_of_week: number; // 0=domingo … 6=sábado
  start_time: string;  // HH:MM
  active: boolean;
}

export interface Booking {
  id: string;
  session_type: 'online' | 'presencial' | 'pareja';
  session_date: string;  // YYYY-MM-DD
  session_time: string;  // HH:MM
  patient_name: string;
  patient_email: string;
  patient_phone: string;
  notes?: string;
  status: 'pending_payment' | 'confirmed' | 'cancelled';
  amount: number;
  mp_preference_id?: string;
  mp_payment_id?: string;
  created_at: string;
}
