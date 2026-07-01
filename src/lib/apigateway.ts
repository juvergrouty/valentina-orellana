import { supabase } from './supabase';

/**
 * Integración con API Gateway (apigateway.cl) — Boletas de Honorarios Electrónicas (BHE).
 *
 * Autenticación (confirmado en docs públicas):
 *   - Las credenciales SII van en el BODY: { auth: { pass: { rut, clave } } }
 *   - La cuenta de API Gateway se autentica con un apikey (header).
 *
 * PENDIENTE de confirmar desde la doc de tu cuenta (developers.apigateway.cl):
 *   - Nombre exacto del header del apikey (por defecto usamos "apikey").
 *   - URL base exacta (se configura en Admin → Configuración).
 *   - Endpoint y payload exactos de EMISIÓN de BHE.
 *
 * Todo es configurable vía settings/env para no hardcodear suposiciones.
 */

export interface AgwConfig {
  apikey:   string;
  baseUrl:  string;
  siiRut:   string;
  siiClave: string;
}

let _cache: AgwConfig | null = null;

export async function getAgwConfig(): Promise<AgwConfig | null> {
  if (_cache) return _cache;

  const { data } = await supabase
    .from('settings').select('key, value')
    .in('key', ['apigateway_apikey', 'apigateway_base_url', 'sii_rut', 'sii_clave']);
  const s: Record<string, string> = {};
  (data ?? []).forEach((r: { key: string; value: string }) => { s[r.key] = r.value; });

  const apikey   = import.meta.env.APIGATEWAY_APIKEY   || s.apigateway_apikey   || '';
  const baseUrl  = (import.meta.env.APIGATEWAY_BASE_URL || s.apigateway_base_url || 'https://app.apigateway.cl').replace(/\/$/, '');
  const siiRut   = import.meta.env.SII_RUT             || s.sii_rut             || '';
  const siiClave = import.meta.env.SII_CLAVE           || s.sii_clave           || '';

  // La cuenta se autentica solo con el token; el RUT/clave SII se necesitan
  // únicamente para acciones sobre la cuenta SII (ej. emitir boleta).
  if (!apikey) return null;

  _cache = { apikey, baseUrl, siiRut, siiClave };
  return _cache;
}

function authHeaders(c: AgwConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Token ${c.apikey}`,
  };
}

async function handle(res: Response) {
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) {
    throw new Error(`API Gateway ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  }
  return json;
}

/** GET autenticado (solo token de cuenta). */
export async function agwGet(path: string, cfg?: AgwConfig) {
  const c = cfg ?? (await getAgwConfig());
  if (!c) throw new Error('API Gateway no configurado (falta el token).');
  return handle(await fetch(`${c.baseUrl}${path}`, { method: 'GET', headers: authHeaders(c) }));
}

/** POST autenticado: token en header + credenciales SII en el body (si existen). */
export async function agwPost(path: string, body: Record<string, unknown> = {}, cfg?: AgwConfig) {
  const c = cfg ?? (await getAgwConfig());
  if (!c) throw new Error('API Gateway no configurado (falta el token).');

  const payload: Record<string, unknown> = { ...body };
  if (c.siiRut && c.siiClave) {
    payload.auth = { pass: { rut: c.siiRut, clave: c.siiClave } };
  }

  return handle(await fetch(`${c.baseUrl}${path}`, {
    method: 'POST', headers: authHeaders(c), body: JSON.stringify(payload),
  }));
}

/**
 * Consulta la situación tributaria de un contribuyente (dato público del SII).
 * OJO: requiere que la conexión tenga habilitada esa operación (algunas no).
 * GET /api/v2/sii/contribuyentes/situacion_tributaria/tercero/{rut}
 */
export async function situacionTributaria(rut: string, cfg?: AgwConfig) {
  return agwGet(`/api/v2/sii/contribuyentes/situacion_tributaria/tercero/${rut}`, cfg);
}

/**
 * Lista las BHE emitidas por un emisor en un período (YYYY-MM).
 * Requiere token + credenciales SII (auth.pass). Sirve como prueba real del
 * producto de Boletas de Honorarios.
 * ⚠️ Verificar versión/endpoint exacto en la doc de tu conexión (v1 vs v2).
 */
export async function bheEmitidas(emisor: string, periodo: string, cfg?: AgwConfig) {
  return agwPost(`/api/v2/sii/bhe/emitidas/documentos/${emisor}/${periodo}`, {}, cfg);
}

export interface BheReceptor {
  rut:        string; // RUTRecep
  razonSocial: string; // RznSocRecep
  direccion?: string; // DirRecep
  comuna?:    string; // CmnaRecep
}
export interface BheDetalleItem { nombre: string; monto: number; }

/**
 * Emite una Boleta de Honorarios Electrónica.
 *
 * ⚠️ El ENDPOINT y el envoltorio exacto del payload deben confirmarse en la doc
 * de tu cuenta de API Gateway. La estructura del documento (Encabezado/Detalle)
 * sí está alineada con el formato SII publicado. Por seguridad, esta función NO
 * se dispara automáticamente: se invoca de forma explícita desde el admin.
 */
export async function emitirBHE(params: {
  receptor: BheReceptor;
  detalle:  BheDetalleItem[];
  emitePor?: 0 | 1; // 0 = el emisor retiene, 1 = el receptor retiene (según giro)
}, cfg?: AgwConfig) {
  const c = cfg ?? (await getAgwConfig());
  if (!c) throw new Error('API Gateway no configurado.');

  const documento = {
    Encabezado: {
      IdDoc: { TipoDTE: 'boleta de honorarios' },
      Emisor: { RUTEmisor: c.siiRut },
      Receptor: {
        RUTRecep:    params.receptor.rut,
        RznSocRecep: params.receptor.razonSocial,
        DirRecep:    params.receptor.direccion ?? '',
        CmnaRecep:   params.receptor.comuna ?? '',
      },
    },
    Detalle: params.detalle.map((d, i) => ({
      NroLinDet: i + 1,
      NmbItem:   d.nombre,
      MontoItem: d.monto,
    })),
  };

  // TODO: confirmar path exacto de emisión en developers.apigateway.cl
  const emitPath = '/api/v1/sii/bhe/emitir';
  return agwPost(emitPath, { documento }, c);
}

export function clearAgwCache() { _cache = null; }
