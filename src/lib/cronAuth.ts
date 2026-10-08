import { timingSafeEqual } from 'node:crypto';
import { supabase } from './supabase';

// ¿Quién puede llamar a las tareas automáticas (cron)?
// - Vercel / GitHub Actions: con CRON_SECRET (variable de entorno).
// - Supabase (pg_cron, cada 5 min): con una clave interna que la propia base
//   generó y guarda en settings.cron_interno_secret. Nadie la escribe ni la ve;
//   la tabla settings no es legible desde afuera (sin políticas para anon).
// Falla cerrado: sin clave válida, no se ejecuta nada.

const igual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function cronAutorizado(request: Request): Promise<boolean> {
  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const dado = auth.slice(7);

  const secret = import.meta.env.CRON_SECRET;
  if (secret && igual(dado, secret)) return true;

  const { data } = await supabase.from('settings').select('value').eq('key', 'cron_interno_secret').maybeSingle();
  const interno = String(data?.value ?? '');
  return interno.length >= 32 && igual(dado, interno);
}
