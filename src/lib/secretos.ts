// Lectura de llaves secretas en TIEMPO DE EJECUCIÓN (revisión de seguridad 16 oct 2026, A2/M1).
//
// Por qué: en Astro 7 / Vite, `import.meta.env.X` de una variable privada se REEMPLAZA en el
// build por su valor literal. Como Vercel expone las variables también durante el build, cada
// llave leída así quedaba escrita en claro dentro de .vercel/output/functions (y en cada
// despliegue antiguo que se pueda reactivar). Leer `import.meta.env` como objeto entero es peor:
// incrusta TODAS las variables.
//
// Regla: las llaves se leen SOLO con secreto('NOMBRE') → process.env en runtime (Vercel y
// node:test). En `astro dev` hay respaldo en import.meta.env, pero dentro de
// `if (import.meta.env.DEV)`: en el build DEV es `false` y Rollup elimina esa rama completa,
// así que el valor nunca llega al bundle. Lo comprueba scripts/verificar-secretos-build.mjs.
// Nunca registrar los valores: solo el nombre de la variable que falta.

export type NombreSecreto =
  | 'SUPABASE_SERVICE_ROLE_KEY'
  | 'RESEND_API_KEY'
  | 'ANTHROPIC_API_KEY'
  | 'ASSEMBLYAI_API_KEY' | 'ASSEMBLYAI_WEBHOOK_SECRET'
  | 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY'
  | 'B2_KEY_ID' | 'B2_APPLICATION_KEY'
  | 'FLY_API_TOKEN' | 'BOT_TOKEN_SECRET'
  | 'ADMIN_SECRET' | 'ADMIN_PASSWORD' | 'CRON_SECRET';

function desdeDev(n: NombreSecreto): string | undefined {
  try {
    if (import.meta.env.DEV) {
      // Acceso literal por nombre (nunca el objeto entero). Rama eliminada en el build.
      switch (n) {
        case 'SUPABASE_SERVICE_ROLE_KEY': return import.meta.env.SUPABASE_SERVICE_ROLE_KEY;
        case 'RESEND_API_KEY': return import.meta.env.RESEND_API_KEY;
        case 'ANTHROPIC_API_KEY': return import.meta.env.ANTHROPIC_API_KEY;
        case 'ASSEMBLYAI_API_KEY': return import.meta.env.ASSEMBLYAI_API_KEY;
        case 'ASSEMBLYAI_WEBHOOK_SECRET': return import.meta.env.ASSEMBLYAI_WEBHOOK_SECRET;
        case 'R2_ACCESS_KEY_ID': return import.meta.env.R2_ACCESS_KEY_ID;
        case 'R2_SECRET_ACCESS_KEY': return import.meta.env.R2_SECRET_ACCESS_KEY;
        case 'B2_KEY_ID': return import.meta.env.B2_KEY_ID;
        case 'B2_APPLICATION_KEY': return import.meta.env.B2_APPLICATION_KEY;
        case 'FLY_API_TOKEN': return import.meta.env.FLY_API_TOKEN;
        case 'BOT_TOKEN_SECRET': return import.meta.env.BOT_TOKEN_SECRET;
        case 'ADMIN_SECRET': return import.meta.env.ADMIN_SECRET;
        case 'ADMIN_PASSWORD': return import.meta.env.ADMIN_PASSWORD;
        case 'CRON_SECRET': return import.meta.env.CRON_SECRET;
      }
    }
  } catch { /* fuera de Vite (tsx/node:test) import.meta.env no existe */ }
  return undefined;
}

/** Valor de la llave o undefined (cadena vacía = ausente). No recorta: se devuelve tal cual. */
export function secreto(n: NombreSecreto): string | undefined {
  const p = typeof process !== 'undefined' ? process.env?.[n] : undefined;
  if (typeof p === 'string' && p !== '') return p;
  const d = desdeDev(n);
  return typeof d === 'string' && d !== '' ? d : undefined;
}
