import type { APIRoute } from 'astro';
import { supabase } from '../../../../lib/supabase';
import { CLAVES_GMAIL } from '../../../../lib/gmailBanco';

export const prerender = false;

// Desconecta solo el permiso de lectura de Gmail (transferencias, 22 nov 2026). Calendar sigue igual.
// Sin Gmail, las transferencias quedan en el Inicio para revisarlas a mano («Ya la revisé»).
export const POST: APIRoute = async () => {
  for (const key of CLAVES_GMAIL) await supabase.from('settings').delete().eq('key', key);
  return new Response(null, { status: 302, headers: { Location: '/admin/configuracion?gmail=disconnected#gmail-banco' } });
};
