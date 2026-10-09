import { createHmac, timingSafeEqual } from 'node:crypto';

// Sesión del panel (3 oct 2026). Antes la cookie era el propio ADMIN_SECRET:
// igual para siempre, así que una cookie robada servía indefinidamente.
// Ahora es un token firmado con vencimiento de 8 horas: "v1.<vence>.<firma>".

export const COOKIE_ADMIN = 'vo_admin_token';
export const DURACION_SESION_MS = 8 * 60 * 60 * 1000;

function firmar(payload: string): string {
  return createHmac('sha256', `panel:${import.meta.env.ADMIN_SECRET ?? ''}`).update(payload).digest('hex');
}

export function crearTokenAdmin(): string {
  const payload = `v1.${Date.now() + DURACION_SESION_MS}`;
  return `${payload}.${firmar(payload)}`;
}

export function tokenAdminValido(token: string | undefined | null): boolean {
  if (!token || !import.meta.env.ADMIN_SECRET) return false;
  const partes = token.split('.');
  if (partes.length !== 3 || partes[0] !== 'v1') return false;
  const vence = Number(partes[1]);
  if (!Number.isFinite(vence) || vence < Date.now()) return false;
  const esperada = Buffer.from(firmar(`v1.${partes[1]}`));
  const recibida = Buffer.from(partes[2]);
  return esperada.length === recibida.length && timingSafeEqual(esperada, recibida);
}

/** Compara dos textos en tiempo constante (para la contraseña). */
export function igualesSeguro(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'cmp').update(a).digest();
  const hb = createHmac('sha256', 'cmp').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ── Sesiones cerradas ("Cerrar sesión") ───────────────────────────────────────
// Antes, cerrar sesión solo borraba la cookie de ESE navegador: si alguien
// había copiado el token, seguía sirviendo hasta que venciera (8 h). Ahora la
// firma del token queda en una lista de revocados (settings) hasta su
// vencimiento, y el middleware la rechaza. La lista se cachea 30 s por instancia.
const SETTING_REVOCADOS = 'admin_tokens_revocados';
let cacheRevocados: { firmas: Set<string>; leido: number } | null = null;

async function leerRevocados(): Promise<{ firma: string; vence: number }[]> {
  const { supabase } = await import('./supabase');
  const { data } = await supabase.from('settings').select('value').eq('key', SETTING_REVOCADOS).maybeSingle();
  try { const l = JSON.parse(data?.value || '[]'); return Array.isArray(l) ? l : []; } catch { return []; }
}

export async function tokenRevocado(token: string): Promise<boolean> {
  const firma = token.split('.')[2] ?? '';
  if (!cacheRevocados || Date.now() - cacheRevocados.leido > 30_000) {
    try {
      const lista = await leerRevocados();
      cacheRevocados = { firmas: new Set(lista.map(r => r.firma)), leido: Date.now() };
    } catch { return false; } // si no se puede leer, no se bloquea el panel
  }
  return cacheRevocados.firmas.has(firma);
}

export async function revocarTokenAdmin(token: string): Promise<void> {
  const partes = token.split('.');
  if (partes.length !== 3) return;
  const { supabase } = await import('./supabase');
  const ahora = Date.now();
  // Lectura con revisión de error (8 oct 2026): leerRevocados() devuelve []
  // si Supabase falla, y escribir esa lista reabría todas las sesiones ya
  // cerradas. Si no se puede leer, se lanza sin escribir (logout lo atrapa).
  const { data, error: errLeer } = await supabase.from('settings').select('value').eq('key', SETTING_REVOCADOS).maybeSingle();
  if (errLeer) throw new Error(errLeer.message);
  let actual: unknown;
  try { actual = JSON.parse(data?.value || '[]'); } catch { throw new Error('admin_tokens_revocados ilegible'); }
  if (!Array.isArray(actual)) throw new Error('admin_tokens_revocados ilegible');
  const lista = (actual as { firma: string; vence: number }[]).filter(r => r.vence > ahora); // los vencidos ya no sirven igual
  lista.push({ firma: partes[2], vence: Number(partes[1]) || ahora + DURACION_SESION_MS });
  const { error: errGuardar } = await supabase.from('settings').upsert(
    { key: SETTING_REVOCADOS, value: JSON.stringify(lista), updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  cacheRevocados = null;
  if (errGuardar) throw new Error(errGuardar.message);
}
