// Lectura de variables de entorno del transcriptor (paquete P1).
// Primero process.env (runtime de Vercel y pruebas con node:test). Solo para nombres NO
// secretos hay respaldo en import.meta.env.X (astro dev). Las llaves (KEK, secretos de R2/B2)
// se leen SOLO de process.env en tiempo de ejecución: así Vite nunca las incrusta en el
// bundle del build. Cada nombre va escrito literal (nunca se serializa import.meta.env entero).
// Nunca registrar los valores: solo el nombre de la variable que falta.

type Nombre =
  | 'R2_ACCOUNT_ID' | 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY' | 'R2_BUCKET_AUDIO'
  | 'R2_BUCKET_TRANSCRIPCIONES' | 'R2_JURISDICCION'
  | 'B2_ENDPOINT' | 'B2_REGION' | 'B2_KEY_ID' | 'B2_APPLICATION_KEY' | 'B2_BUCKET'
  | 'TRANSCRIPTOR_KEK_ACTIVA'
  | 'TRANSCRIPTOR_KEK_V1' | 'TRANSCRIPTOR_KEK_V2' | 'TRANSCRIPTOR_KEK_V3' | 'TRANSCRIPTOR_KEK_V4' | 'TRANSCRIPTOR_KEK_V5';

function desdeImportMeta(n: Nombre): string | undefined {
  try {
    switch (n) {
      // Sin casos para llaves secretas a propósito (ver arriba).
      case 'R2_ACCOUNT_ID': return import.meta.env.R2_ACCOUNT_ID;
      case 'R2_BUCKET_AUDIO': return import.meta.env.R2_BUCKET_AUDIO;
      case 'R2_BUCKET_TRANSCRIPCIONES': return import.meta.env.R2_BUCKET_TRANSCRIPCIONES;
      case 'R2_JURISDICCION': return import.meta.env.R2_JURISDICCION;
      case 'B2_ENDPOINT': return import.meta.env.B2_ENDPOINT;
      case 'B2_REGION': return import.meta.env.B2_REGION;
      case 'B2_BUCKET': return import.meta.env.B2_BUCKET;
      case 'TRANSCRIPTOR_KEK_ACTIVA': return import.meta.env.TRANSCRIPTOR_KEK_ACTIVA;
      default: return undefined;
    }
  } catch {
    return undefined; // fuera de Vite (tsx/node:test) import.meta.env no existe
  }
}

/** Valor de la variable o undefined (cadena vacía cuenta como ausente). */
export function variable(n: Nombre): string | undefined {
  const v = (typeof process !== 'undefined' ? process.env?.[n] : undefined) ?? desdeImportMeta(n);
  const limpio = typeof v === 'string' ? v.trim() : undefined;
  return limpio ? limpio : undefined;
}

export class ConfiguracionFaltanteError extends Error {
  constructor(public readonly variables: string[]) {
    super(`Falta configurar en Vercel: ${variables.join(', ')}`);
    this.name = 'ConfiguracionFaltanteError';
  }
}

/** Devuelve las variables pedidas o lanza ConfiguracionFaltanteError con TODAS las que faltan. */
export function requeridas<const T extends readonly Nombre[]>(nombres: T): Record<T[number], string> {
  const faltan: string[] = [];
  const out = {} as Record<T[number], string>;
  for (const n of nombres) {
    const v = variable(n);
    if (v === undefined) faltan.push(n);
    else out[n as T[number]] = v;
  }
  if (faltan.length) throw new ConfiguracionFaltanteError(faltan);
  return out;
}
