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
export async function bheEmitidas(emisor: string, periodo: string, pagina = 1, cfg?: AgwConfig) {
  return agwPost(`/api/v2/sii/bhe/emitidas/documentos/${emisor}/${periodo}?pagina=${pagina}`, {}, cfg);
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
 * Payload confirmado con la doc de la cuenta (POST /api/v2/sii/bhe/emitidas/emitir):
 *   { auth, boleta: { Encabezado: { IdDoc{FchEmis,TipoRetencion}, Emisor{RUTEmisor}, Receptor{...} }, Detalle:[{NmbItem,MontoItem}] } }
 * `auth` lo agrega agwPost automáticamente.
 * TipoRetencion: 2 = retención la efectúa el emisor (caso boletas a personas naturales, ej. pacientes).
 * Por seguridad NO se dispara automáticamente — se invoca on-demand desde el admin.
 */
export async function emitirBHE(params: {
  receptor: BheReceptor;
  detalle:  BheDetalleItem[];
  fecha?:   string;      // FchEmis YYYY-MM-DD (default: hoy)
  tipoRetencion?: 1 | 2; // default 2 (emisor retiene)
}, cfg?: AgwConfig) {
  const c = cfg ?? (await getAgwConfig());
  if (!c) throw new Error('API Gateway no configurado.');

  const boleta = {
    Encabezado: {
      IdDoc: {
        FchEmis:       params.fecha ?? new Date().toISOString().slice(0, 10),
        TipoRetencion: params.tipoRetencion ?? 2,
      },
      Emisor: { RUTEmisor: c.siiRut },
      Receptor: {
        RUTRecep:    params.receptor.rut,
        RznSocRecep: params.receptor.razonSocial,
        DirRecep:    params.receptor.direccion ?? '',
        CmnaRecep:   params.receptor.comuna ?? '',
      },
    },
    Detalle: params.detalle.map(d => ({ NmbItem: d.nombre, MontoItem: d.monto })),
  };

  return agwPost('/api/v2/sii/bhe/emitidas/emitir', { boleta }, c);
}

/**
 * Descarga el PDF de una BHE emitida y devuelve base64 limpio.
 * POST /api/v2/sii/bhe/emitidas/pdf/{codigo}
 * El endpoint puede responder el PDF binario o un JSON con el base64 — se manejan ambos.
 */
export async function bhePdf(codigo: string, cfg?: AgwConfig): Promise<string | null> {
  const c = cfg ?? (await getAgwConfig());
  if (!c) throw new Error('API Gateway no configurado.');

  const body: Record<string, unknown> = {};
  if (c.siiRut && c.siiClave) body.auth = { pass: { rut: c.siiRut, clave: c.siiClave } };

  const res = await fetch(`${c.baseUrl}/api/v2/sii/bhe/emitidas/pdf/${codigo}`, {
    method: 'POST', headers: authHeaders(c), body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`API Gateway ${res.status}: ${t.slice(0, 200)}`);
  }

  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const j = await res.json();
    if (typeof j === 'string') return j;                 // base64 como string JSON
    return (j?.data ?? j?.pdf ?? j?.pdf_bytes ?? null);  // o dentro de un objeto
  }
  // Binario → base64
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

/** Envía por email una BHE emitida. POST /api/v2/sii/bhe/emitidas/email/{codigo} */
export async function bheEmail(codigo: string, email: string, cfg?: AgwConfig) {
  return agwPost(`/api/v2/sii/bhe/emitidas/email/${codigo}`, { destinatario: { email } }, cfg);
}

/** Lista emitidas del período y devuelve el `codigo` de una boleta por su folio (numero). */
export async function codigoDeFolio(emisor: string, periodo: string, folio: number, cfg?: AgwConfig): Promise<string | null> {
  const r = await bheEmitidas(emisor, periodo, 1, cfg) as { data?: { boletas?: Array<{ numero: number; codigo: string }> } };
  const found = r?.data?.boletas?.find(b => b.numero === folio);
  return found?.codigo ?? null;
}

/** Anula una BHE emitida. POST /api/v2/sii/bhe/emitidas/anular/{emisor}/{folio} */
export async function bheAnular(emisor: string, folio: string | number, cfg?: AgwConfig) {
  return agwPost(`/api/v2/sii/bhe/emitidas/anular/${emisor}/${folio}`, {}, cfg);
}

// Normaliza RUT a "XXXXXXXX-X" (sin puntos, con guion antes del dígito verificador)
export function normalizeRut(rut: string): string {
  const clean = rut.replace(/\./g, '').replace(/\s/g, '').replace(/-/g, '').trim();
  if (clean.length < 2) return rut.trim();
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`;
}

function periodoActualYM(): string {
  const n = new Date();
  return `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Emite la boleta de una reserva de punta a punta: resuelve paciente, glosa del
 * servicio, emite, resuelve el código y lo guarda en bookings.notes.
 * Reutilizable desde el admin (manual) y desde la confirmación de pago (automática).
 */
export async function emitBoletaParaReserva(
  bookingId: string,
  opts: { rutOverride?: string; enviarEmail?: boolean } = {},
): Promise<{ ok: boolean; folio?: number | null; codigo?: string | null; error?: string; alreadyEmitted?: boolean }> {
  const cfg = await getAgwConfig();
  if (!cfg) return { ok: false, error: 'API Gateway no configurado.' };

  const { data: b } = await supabase
    .from('bookings').select('patient_name, patient_email, amount, session_type, notes, service_id').eq('id', bookingId).single();
  if (!b) return { ok: false, error: 'Reserva no encontrada.' };

  const already = /Boleta Folio (\d+)/.exec(b.notes ?? '');
  if (already) return { ok: true, folio: parseInt(already[1]), alreadyEmitted: true };

  const { data: p } = await supabase
    .from('patients').select('rut, name, address').eq('email', (b.patient_email ?? '').toLowerCase()).maybeSingle();
  const rutRaw = (opts.rutOverride ?? '').trim() || p?.rut || '';
  if (!rutRaw) return { ok: false, error: 'Falta el RUT del paciente.' };
  if (!b.amount) return { ok: false, error: 'La reserva no tiene monto.' };

  let glosa = 'Atención psicológica';
  if (b.service_id) {
    const { data: svc } = await supabase
      .from('services_catalog').select('fonasa_description').eq('id', b.service_id).maybeSingle();
    if (svc?.fonasa_description) glosa = svc.fonasa_description as string;
  }

  try {
    const result = await emitirBHE({
      receptor: { rut: normalizeRut(rutRaw), razonSocial: p?.name ?? b.patient_name, direccion: p?.address ?? '' },
      detalle:  [{ nombre: glosa, monto: b.amount }],
    }, cfg) as { data?: { Encabezado?: { IdDoc?: { Folio?: number } } } };

    const folio = result?.data?.Encabezado?.IdDoc?.Folio ?? null;
    let codigo: string | null = null;
    if (folio) {
      try { codigo = await codigoDeFolio(cfg.siiRut, periodoActualYM(), folio, cfg); } catch { /* opcional */ }
      const nota = `${b.notes ? b.notes + '\n' : ''}Boleta Folio ${folio}${codigo ? ' · Cod ' + codigo : ''}`;
      await supabase.from('bookings').update({ notes: nota }).eq('id', bookingId);
    }
    if (opts.enviarEmail && codigo && b.patient_email) {
      try { await bheEmail(codigo, b.patient_email, cfg); } catch { /* no bloquear */ }
    }
    return { ok: true, folio, codigo };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Error al emitir' };
  }
}

export function clearAgwCache() { _cache = null; }
