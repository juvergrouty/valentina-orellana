// Cifrado por sobre (envelope) del transcriptor — paquete P1 (30-seguridad.md §3).
//
// • KEK (llave maestra, 32 bytes base64) en Vercel: TRANSCRIPTOR_KEK_V1, _V2… y
//   TRANSCRIPTOR_KEK_ACTIVA = 'v1' (con cuál se cifra lo nuevo). Al descifrar se usa la
//   versión escrita en la cabecera del objeto → la rotación no rompe lo antiguo.
// • DEK nueva de 32 bytes por CADA objeto; cifra el contenido con AES-256-GCM.
// • La DEK va envuelta (AES-256-GCM con la KEK) DENTRO de la cabecera: el objeto es
//   autocontenido y se recupera solo con la KEK aunque se pierda Supabase.
//
// Formato VOT1 (binario, application/octet-stream):
//   offset largo campo
//   0      4     magia "VOT1"
//   4      1     versión de formato (= 1)
//   5      1     versión de KEK (1…255)
//   6      12    iv_envoltura (aleatorio)
//   18     48    DEK envuelta (32 + tag 16)
//   66     12    iv_contenido (aleatorio, nunca repetido)
//   78     n+16  contenido cifrado + tag GCM de 128 bits
// AAD envoltura = "VOT1|kek=v<n>|" + claveObjeto
// AAD contenido = cabecera (bytes 0–77) + "|" + claveObjeto + "|" + tipo
// → copiar el objeto a otra llave, cambiar el tipo o alterar un byte de la cabecera hace
//   fallar el descifrado.
//
// Usa Web Crypto (globalThis.crypto.subtle, Node ≥ 20 y Vercel). Nunca registra llaves
// ni contenido; los errores solo dicen qué falló.
import { FORMATO_CIFRADO_MAGIA, FORMATO_CIFRADO_VERSION, type Cifrado, type ContextoCifrado } from './tipos';
import { variable } from './entorno';

export const LARGO_CABECERA = 78;
const LARGO_IV = 12;
const LARGO_TAG = 16;
const LARGO_LLAVE = 32;
const LARGO_DEK_ENVUELTA = LARGO_LLAVE + LARGO_TAG; // 48
const MAX_KEK_V = 5; // variables TRANSCRIPTOR_KEK_V1…V5 (ver entorno.ts)

const MAGIA = new TextEncoder().encode(FORMATO_CIFRADO_MAGIA);
const enc = new TextEncoder();

export type CodigoErrorCifrado = 'formato' | 'version' | 'kek_ausente' | 'kek_invalida' | 'autenticacion' | 'contexto';

export class ErrorCifrado extends Error {
  constructor(public readonly codigo: CodigoErrorCifrado, mensaje: string) {
    super(mensaje);
    this.name = 'ErrorCifrado';
  }
}

/** Fuente de KEK: versión activa + función que entrega los 32 bytes de una versión. */
export interface LlavesKEK {
  activa: number;
  obtener(version: number): Uint8Array | undefined;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new ErrorCifrado('contexto', 'Web Crypto no disponible en este entorno');
  return s;
}

function aleatorio(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function unir(...partes: Uint8Array[]): Uint8Array {
  const total = partes.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of partes) { out.set(p, o); o += p.length; }
  return out;
}

/** Decodifica una KEK en base64 y exige exactamente 32 bytes. */
export function decodificarKEK(base64: string): Uint8Array {
  const limpio = base64.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(limpio)) throw new ErrorCifrado('kek_invalida', 'La KEK no es base64 válido');
  const bytes = Uint8Array.from(Buffer.from(limpio, 'base64'));
  if (bytes.length !== LARGO_LLAVE) throw new ErrorCifrado('kek_invalida', `La KEK debe tener 32 bytes (tiene ${bytes.length})`);
  return bytes;
}

/** Interpreta 'v1', 'V2' o '3' como número de versión. */
export function parsearVersionKEK(texto: string | undefined): number {
  const m = /^v?(\d{1,3})$/i.exec((texto ?? '').trim());
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 255) {
    throw new ErrorCifrado('kek_ausente', 'TRANSCRIPTOR_KEK_ACTIVA debe ser v1, v2…');
  }
  return n;
}

/** Llaves desde las variables de entorno (se leen en cada uso: un redeploy con KEK nueva basta). */
export function llavesDesdeEntorno(): LlavesKEK {
  return {
    get activa() { return parsearVersionKEK(variable('TRANSCRIPTOR_KEK_ACTIVA') ?? 'v1'); },
    obtener(v: number) {
      if (v < 1 || v > MAX_KEK_V) return undefined;
      const b64 = variable(`TRANSCRIPTOR_KEK_V${v}` as 'TRANSCRIPTOR_KEK_V1');
      return b64 ? decodificarKEK(b64) : undefined;
    },
  };
}

function aadEnvoltura(kekV: number, claveObjeto: string): Uint8Array {
  return enc.encode(`${FORMATO_CIFRADO_MAGIA}|kek=v${kekV}|${claveObjeto}`);
}

function aadContenido(cabecera: Uint8Array, ctx: ContextoCifrado): Uint8Array {
  return unir(cabecera, enc.encode(`|${ctx.claveObjeto}|${ctx.tipo}`));
}

function validarContexto(ctx: ContextoCifrado): void {
  if (!ctx || typeof ctx.claveObjeto !== 'string' || ctx.claveObjeto.length === 0 || ctx.claveObjeto.length > 512) {
    throw new ErrorCifrado('contexto', 'claveObjeto inválida');
  }
  if (!['transcripcion', 'pregunta', 'respuesta'].includes(ctx.tipo)) {
    throw new ErrorCifrado('contexto', 'tipo de objeto inválido');
  }
}

async function importarAES(bytes: Uint8Array, usos: KeyUsage[]): Promise<CryptoKey> {
  return subtle().importKey('raw', bytes as BufferSource, { name: 'AES-GCM' }, false, usos);
}

function kekDe(llaves: LlavesKEK, v: number): Uint8Array {
  const k = llaves.obtener(v);
  if (!k) throw new ErrorCifrado('kek_ausente', `No está configurada TRANSCRIPTOR_KEK_V${v}`);
  if (k.length !== LARGO_LLAVE) throw new ErrorCifrado('kek_invalida', `TRANSCRIPTOR_KEK_V${v} no tiene 32 bytes`);
  return k;
}

/** Cabecera leída (sin descifrar nada). Útil para la rotación: saber qué KEK usa un objeto. */
export interface CabeceraVOT1 {
  formatoV: number;
  kekV: number;
  ivEnvoltura: Uint8Array;
  dekEnvuelta: Uint8Array;
  ivContenido: Uint8Array;
}

export function leerCabecera(datos: Uint8Array): CabeceraVOT1 {
  if (!(datos instanceof Uint8Array) || datos.length < LARGO_CABECERA + LARGO_TAG) {
    throw new ErrorCifrado('formato', 'Objeto demasiado corto para ser VOT1');
  }
  for (let i = 0; i < MAGIA.length; i++) {
    if (datos[i] !== MAGIA[i]) throw new ErrorCifrado('formato', 'El objeto no tiene la magia VOT1');
  }
  const formatoV = datos[4];
  if (formatoV !== FORMATO_CIFRADO_VERSION) {
    throw new ErrorCifrado('version', `Versión de formato no soportada: ${formatoV}`);
  }
  const kekV = datos[5];
  if (kekV < 1) throw new ErrorCifrado('version', 'Versión de KEK inválida en la cabecera');
  return {
    formatoV,
    kekV,
    ivEnvoltura: datos.subarray(6, 18),
    dekEnvuelta: datos.subarray(18, 66),
    ivContenido: datos.subarray(66, 78),
  };
}

async function cifrarCon(llaves: LlavesKEK, claro: Uint8Array, ctx: ContextoCifrado) {
  validarContexto(ctx);
  const kekV = llaves.activa;
  if (kekV < 1 || kekV > 255) throw new ErrorCifrado('version', 'Versión de KEK activa fuera de rango');
  const kek = await importarAES(kekDe(llaves, kekV), ['encrypt']);

  const dek = aleatorio(LARGO_LLAVE);
  const ivEnv = aleatorio(LARGO_IV);
  const ivCont = aleatorio(LARGO_IV);
  try {
    const dekEnvuelta = new Uint8Array(await subtle().encrypt(
      { name: 'AES-GCM', iv: ivEnv as BufferSource, additionalData: aadEnvoltura(kekV, ctx.claveObjeto) as BufferSource, tagLength: 128 },
      kek, dek as BufferSource,
    ));
    if (dekEnvuelta.length !== LARGO_DEK_ENVUELTA) throw new ErrorCifrado('formato', 'DEK envuelta con largo inesperado');

    const cabecera = unir(MAGIA, Uint8Array.of(FORMATO_CIFRADO_VERSION, kekV), ivEnv, dekEnvuelta, ivCont);
    const llaveDek = await importarAES(dek, ['encrypt']);
    const cifrado = new Uint8Array(await subtle().encrypt(
      { name: 'AES-GCM', iv: ivCont as BufferSource, additionalData: aadContenido(cabecera, ctx) as BufferSource, tagLength: 128 },
      llaveDek, claro as BufferSource,
    ));
    // dekEnvuelta que se guarda en Supabase = iv_envoltura ‖ DEK envuelta (60 bytes): con la
    // KEK basta para desenvolverla. Ponerla en null es el borrado criptográfico (§3.6).
    return { datos: unir(cabecera, cifrado), kekV, dekEnvuelta: unir(ivEnv, dekEnvuelta) };
  } finally {
    dek.fill(0);
  }
}

async function descifrarCon(llaves: LlavesKEK, datos: Uint8Array, ctx: ContextoCifrado): Promise<Uint8Array> {
  validarContexto(ctx);
  const cab = leerCabecera(datos);
  const kek = await importarAES(kekDe(llaves, cab.kekV), ['decrypt']);
  let dek: Uint8Array;
  try {
    dek = new Uint8Array(await subtle().decrypt(
      { name: 'AES-GCM', iv: cab.ivEnvoltura as BufferSource, additionalData: aadEnvoltura(cab.kekV, ctx.claveObjeto) as BufferSource, tagLength: 128 },
      kek, cab.dekEnvuelta as BufferSource,
    ));
  } catch {
    throw new ErrorCifrado('autenticacion', 'No se pudo desenvolver la DEK (KEK incorrecta, otra llave de objeto o cabecera alterada)');
  }
  try {
    const llaveDek = await importarAES(dek, ['decrypt']);
    const cabecera = datos.subarray(0, LARGO_CABECERA);
    return new Uint8Array(await subtle().decrypt(
      { name: 'AES-GCM', iv: cab.ivContenido as BufferSource, additionalData: aadContenido(cabecera, ctx) as BufferSource, tagLength: 128 },
      llaveDek, datos.subarray(LARGO_CABECERA) as BufferSource,
    ));
  } catch {
    throw new ErrorCifrado('autenticacion', 'El contenido no se autenticó (alterado, otra llave de objeto u otro tipo)');
  } finally {
    dek.fill(0);
  }
}

export interface CifradoVOT1 extends Cifrado {
  /**
   * Rotación de KEK (§3.6): descifra con la KEK de la cabecera y vuelve a cifrar con la KEK
   * activa y una DEK NUEVA (sirve también ante filtración). Los objetos son pequeños.
   * Si el objeto ya usa la KEK activa, lo devuelve igual con `cambio: false`.
   */
  reenvolver(datos: Uint8Array, ctx: ContextoCifrado, forzar?: boolean): Promise<{ datos: Uint8Array; kekV: number; dekEnvuelta: Uint8Array; cambio: boolean }>;
  /** Cifra texto UTF-8 (p. ej. pregunta/respuesta de Q&A) y lo devuelve en base64 para Supabase. */
  cifrarTexto(texto: string, ctx: ContextoCifrado): Promise<{ base64: string; kekV: number }>;
  descifrarTexto(base64: string, ctx: ContextoCifrado): Promise<string>;
}

/** Crea un cifrador. Sin argumentos lee las KEK de Vercel; las pruebas pasan llaves propias. */
export function crearCifrado(llaves: LlavesKEK = llavesDesdeEntorno()): CifradoVOT1 {
  return {
    cifrar: (claro, ctx) => cifrarCon(llaves, claro, ctx),
    descifrar: (datos, ctx) => descifrarCon(llaves, datos, ctx),
    async reenvolver(datos, ctx, forzar = false) {
      const cab = leerCabecera(datos);
      if (cab.kekV === llaves.activa && !forzar) {
        return { datos, kekV: cab.kekV, dekEnvuelta: unir(cab.ivEnvoltura, cab.dekEnvuelta), cambio: false };
      }
      const claro = await descifrarCon(llaves, datos, ctx);
      try {
        return { ...(await cifrarCon(llaves, claro, ctx)), cambio: true };
      } finally {
        claro.fill(0);
      }
    },
    async cifrarTexto(texto, ctx) {
      const r = await cifrarCon(llaves, enc.encode(texto), ctx);
      return { base64: Buffer.from(r.datos).toString('base64'), kekV: r.kekV };
    },
    async descifrarTexto(base64, ctx) {
      const claro = await descifrarCon(llaves, Uint8Array.from(Buffer.from(base64, 'base64')), ctx);
      return new TextDecoder('utf-8', { fatal: true }).decode(claro);
    },
  };
}

/** Instancia por defecto (KEK desde el entorno). */
export const cifrado: CifradoVOT1 = crearCifrado();

/** SHA-256 en hex (integridad de objetos cifrados: `sha256_cifrado`). */
export async function sha256Hex(datos: Uint8Array): Promise<string> {
  const h = new Uint8Array(await subtle().digest('SHA-256', datos as BufferSource));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}
