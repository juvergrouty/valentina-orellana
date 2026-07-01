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
  headerName: string;
}

let _cache: AgwConfig | null = null;

export async function getAgwConfig(): Promise<AgwConfig | null> {
  if (_cache) return _cache;

  const { data } = await supabase
    .from('settings').select('key, value')
    .in('key', ['apigateway_apikey', 'apigateway_base_url', 'apigateway_header_name', 'sii_rut', 'sii_clave']);
  const s: Record<string, string> = {};
  (data ?? []).forEach((r: { key: string; value: string }) => { s[r.key] = r.value; });

  const apikey   = import.meta.env.APIGATEWAY_APIKEY   || s.apigateway_apikey   || '';
  const baseUrl  = (import.meta.env.APIGATEWAY_BASE_URL || s.apigateway_base_url || 'https://api.apigateway.cl').replace(/\/$/, '');
  const siiRut   = import.meta.env.SII_RUT             || s.sii_rut             || '';
  const siiClave = import.meta.env.SII_CLAVE           || s.sii_clave           || '';
  const headerName = s.apigateway_header_name || 'apikey';

  if (!apikey || !siiRut || !siiClave) return null;

  _cache = { apikey, baseUrl, siiRut, siiClave, headerName };
  return _cache;
}

/** POST autenticado a API Gateway: agrega apikey en header y auth.pass en el body. */
export async function agwPost(path: string, body: Record<string, unknown> = {}, cfg?: AgwConfig) {
  const c = cfg ?? (await getAgwConfig());
  if (!c) throw new Error('API Gateway no configurado (falta apikey o credenciales SII).');

  const payload = {
    auth: { pass: { rut: c.siiRut, clave: c.siiClave } },
    ...body,
  };

  const res = await fetch(`${c.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [c.headerName]: c.apikey,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }

  if (!res.ok) {
    throw new Error(`API Gateway ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  }
  return json;
}

/**
 * Lista las BHE emitidas por un emisor en un período (YYYY-MM).
 * Endpoint confirmado: POST /api/v1/sii/bhe/emitidas/documentos/{emisor}/{periodo}
 * Sirve también como prueba de conexión end-to-end.
 */
export async function bheEmitidas(emisor: string, periodo: string, cfg?: AgwConfig) {
  return agwPost(`/api/v1/sii/bhe/emitidas/documentos/${emisor}/${periodo}`, {}, cfg);
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
