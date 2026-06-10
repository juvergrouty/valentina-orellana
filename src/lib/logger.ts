import { supabase } from './supabase';

type Level = 'info' | 'warn' | 'error';

export async function log(level: Level, context: string, message: string, data?: unknown): Promise<void> {
  const { error } = await supabase.from('admin_logs').insert({
    level,
    context,
    message,
    data: data !== undefined ? data : null,
  });
  if (error) console.warn('[logger] could not write log:', error.message);
}

export const logInfo  = (ctx: string, msg: string, data?: unknown) => log('info',  ctx, msg, data);
export const logWarn  = (ctx: string, msg: string, data?: unknown) => log('warn',  ctx, msg, data);
export const logError = (ctx: string, msg: string, data?: unknown) => log('error', ctx, msg, data);
