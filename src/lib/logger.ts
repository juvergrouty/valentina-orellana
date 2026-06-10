import { supabase } from './supabase';

type Level = 'info' | 'warn' | 'error';

// No bloqueante — falla silenciosamente para no romper el flujo principal
export function log(level: Level, context: string, message: string, data?: unknown) {
  supabase.from('admin_logs').insert({
    level,
    context,
    message,
    data: data !== undefined ? data : null,
  }).then(({ error }) => {
    if (error) console.warn('[logger] could not write log:', error.message);
  });
}

export const logInfo  = (ctx: string, msg: string, data?: unknown) => log('info',  ctx, msg, data);
export const logWarn  = (ctx: string, msg: string, data?: unknown) => log('warn',  ctx, msg, data);
export const logError = (ctx: string, msg: string, data?: unknown) => log('error', ctx, msg, data);
