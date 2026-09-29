import { supabase } from './supabase';
import { sendBoletaEmail, ADMIN_EMAIL_FALLBACK } from './email';
import { todayCL } from './dateUtils';
import { logError, logWarn } from './logger';
import { upsertPatientFromBooking } from './patients';

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
        FchEmis:       params.fecha ?? todayCL(),
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
  // Antes solo miraba la página 1 del listado: si el mes ya tenía más boletas
  // de las que caben en una página, el folio nuevo no aparecía y el correo no
  // salía. Se recorren páginas hasta encontrarlo o hasta una página vacía.
  for (let pagina = 1; pagina <= 5; pagina++) {
    const r = await bheEmitidas(emisor, periodo, pagina, cfg) as { data?: { boletas?: Array<{ numero: number; codigo: string }> } };
    const boletas = r?.data?.boletas ?? [];
    const found = boletas.find(b => Number(b.numero) === folio);
    if (found?.codigo) return found.codigo;
    if (boletas.length === 0) break;
  }
  return null;
}

/**
 * Igual que codigoDeFolio, pero reintenta: justo después de emitir, el SII a
 * veces todavía no lista el folio nuevo. Antes, si no aparecía al primer
 * intento, el correo de la boleta simplemente no se enviaba.
 */
async function codigoDeFolioConReintentos(emisor: string, periodo: string, folio: number, cfg: AgwConfig): Promise<string | null> {
  const esperas = [0, 1500, 3000];
  let ultimoError: unknown = null;
  for (const ms of esperas) {
    if (ms) await new Promise(r => setTimeout(r, ms));
    try {
      const c = await codigoDeFolio(emisor, periodo, folio, cfg);
      if (c) return c;
    } catch (e) { ultimoError = e; }
  }
  if (ultimoError) throw ultimoError;
  return null;
}

// Marcas en bookings.notes que siguen el estado del envío de la boleta.
// `BoletaPendienteEnvio` la deja una emisión cuyo correo no se pudo mandar; el
// cron /api/cron/boletas-pendientes la reintenta hasta que salga.
export const MARCA_PENDIENTE = 'BoletaPendienteEnvio';
const quitarPendiente = (notes: string) =>
  notes.split('\n').filter(l => !l.startsWith(MARCA_PENDIENTE)).join('\n');

/**
 * Boleta vigente de la reserva: la ÚLTIMA línea "Boleta Folio N..." de notes,
 * salvo que esté ANULADA — mismo criterio que el panel del calendario y la
 * ficha del paciente, para que servidor y pantallas digan siempre lo mismo.
 */
function folioVigente(notes: string | null): { folio: number; codigo: string | null } | null {
  const lineas = [...(notes ?? '').matchAll(/Boleta\s+Folio\s+(\d+)[^\n]*/gi)];
  const ultima = lineas.at(-1);
  if (!ultima || /ANULADA/i.test(ultima[0])) return null;
  return { folio: parseInt(ultima[1]), codigo: /Cod ([\w-]+)/i.exec(ultima[0])?.[1] ?? null };
}

/**
 * Envía la boleta ya emitida de una reserva: al paciente (PDF adjunto desde
 * nuestro correo; si no hay PDF, el correo de apigateway.cl) y copia a
 * Valentina. Deja registro en notes: `BoletaEmailEnviada <iso> <email>` si
 * salió, o `BoletaPendienteEnvio` si no, para que el cron la reintente.
 * Único punto de envío tras emitir — lo usan Flow, "Marcar como pagado",
 * "Emitir boleta" del panel y el cron de reintentos.
 */
export async function enviarBoletaDeReserva(bookingId: string): Promise<{ sent: boolean; email?: string; error?: string }> {
  const cfg = await getAgwConfig();
  if (!cfg) return { sent: false, error: 'API Gateway no configurado.' };

  const { data: b } = await supabase
    .from('bookings').select('patient_name, patient_email, session_date, notes').eq('id', bookingId).single();
  if (!b) return { sent: false, error: 'Reserva no encontrada.' };

  const marcarPendiente = async (error: string) => {
    const { data: cur } = await supabase.from('bookings').select('notes').eq('id', bookingId).single();
    const base = quitarPendiente(cur?.notes ?? '');
    await supabase.from('bookings').update({ notes: `${base ? base + '\n' : ''}${MARCA_PENDIENTE} ${new Date().toISOString()}` }).eq('id', bookingId);
    await logError('boleta/envio', `Boleta emitida pero NO enviada a ${b.patient_email ?? '(sin email)'} — se reintentará automáticamente`, { bookingId, error });
    return { sent: false, error };
  };

  // Casos sin reintento posible: se saca la marca de pendiente para que el
  // cron no insista para siempre.
  const descartarPendiente = async () => {
    if (b.notes?.includes(MARCA_PENDIENTE)) await supabase.from('bookings').update({ notes: quitarPendiente(b.notes) }).eq('id', bookingId);
  };
  const vigente = folioVigente(b.notes);
  if (!vigente) {
    await descartarPendiente();
    return { sent: false, error: 'Esta sesión no tiene una boleta vigente (sin emitir o anulada).' };
  }
  const folio = vigente.folio;
  if (!b.patient_email) {
    // Sin email no hay a quién reintentar: se avisa una vez.
    await descartarPendiente();
    await logError('boleta/envio', 'Boleta emitida pero la reserva no tiene email del paciente — no se pudo enviar', { bookingId, folio });
    return { sent: false, error: 'La reserva no tiene email del paciente.' };
  }

  let codigo = vigente.codigo;
  if (!codigo) {
    try {
      codigo = await codigoDeFolioConReintentos(cfg.siiRut, periodoDeFecha(fechaBoletaDesdeSesion(b.session_date)), folio, cfg);
    } catch (e) {
      return marcarPendiente(`No se pudo resolver el código de la boleta: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!codigo) return marcarPendiente(`El SII aún no lista el folio ${folio}.`);
  }

  let pdfBase64: string | null = null;
  try { pdfBase64 = await bhePdf(codigo, cfg); } catch (e) {
    await logWarn('boleta/pdf', 'No se pudo descargar el PDF; se usa el correo de apigateway.cl', { bookingId, folio, error: e instanceof Error ? e.message : String(e) });
  }

  // Envío al paciente — lo que cuenta como "enviada".
  try {
    if (pdfBase64) {
      const r = await sendBoletaEmail({ to: b.patient_email, patientName: b.patient_name, folio, pdfBase64 });
      if (!r.sent) throw new Error(r.reason ?? 'Resend rechazó el envío');
    } else {
      await bheEmail(codigo, b.patient_email, cfg);
    }
  } catch (e) {
    return marcarPendiente(e instanceof Error ? e.message : String(e));
  }

  {
    const { data: cur } = await supabase.from('bookings').select('notes').eq('id', bookingId).single();
    let notes = quitarPendiente(cur?.notes ?? '');
    notes = notes.replace(new RegExp(`(Boleta Folio ${folio})(?!\\d)(?! · Cod)`), `$1 · Cod ${codigo}`);
    notes = `${notes ? notes + '\n' : ''}BoletaEmailEnviada ${new Date().toISOString()} ${b.patient_email}`;
    await supabase.from('bookings').update({ notes }).eq('id', bookingId);
  }

  // Copia para Valentina — no afecta el resultado (el paciente ya la recibió).
  try {
    const { data: notifRow } = await supabase.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
    const adminEmail = notifRow?.value || ADMIN_EMAIL_FALLBACK;
    if (adminEmail.toLowerCase() !== b.patient_email.toLowerCase()) {
      if (pdfBase64) await sendBoletaEmail({ to: adminEmail, patientName: b.patient_name, folio, pdfBase64 });
      else await bheEmail(codigo, adminEmail, cfg);
    }
  } catch (e) {
    await logError('boleta/copia-admin', 'Falló el envío de la copia de la boleta a Valentina', { bookingId, folio, error: e instanceof Error ? e.message : String(e) });
  }

  return { sent: true, email: b.patient_email };
}

// Causales oficiales del SII para anular una BHE (guía SII "Anular boletas de
// honorarios electrónicas"). El nombre exacto del campo que espera el API
// Gateway para esto NO está confirmado contra la documentación de la cuenta
// (developers.apigateway.cl) — se envía con el nombre más probable según el
// patrón del resto del API, pero si el formato real es distinto, el API
// devolverá un error explícito en vez de fallar en silencio.
export type BheCausal = 'no_pago' | 'no_prestacion' | 'error_digitacion';
const CAUSAL_LABEL: Record<BheCausal, string> = {
  no_pago:          'No se efectuó el pago de los servicios por parte del receptor',
  no_prestacion:    'No se efectuó la prestación de servicios',
  error_digitacion: 'Error en la digitación',
};

/** Anula una BHE emitida. POST /api/v2/sii/bhe/emitidas/anular/{emisor}/{folio} */
export async function bheAnular(emisor: string, folio: string | number, causal: BheCausal, cfg?: AgwConfig) {
  return agwPost(`/api/v2/sii/bhe/emitidas/anular/${emisor}/${folio}`, {
    causal,
    causal_glosa: CAUSAL_LABEL[causal],
  }, cfg);
}

// Normaliza RUT a "XXXXXXXX-X" (sin puntos, con guion antes del dígito verificador)
export function normalizeRut(rut: string): string {
  const clean = rut.replace(/\./g, '').replace(/\s/g, '').replace(/-/g, '').trim();
  if (clean.length < 2) return rut.trim();
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`;
}

/** YYYYMM a partir de una fecha YYYY-MM-DD. */
function periodoDeFecha(ymd: string): string {
  return ymd.slice(0, 7).replace('-', '');
}

/**
 * Fecha de emisión (FchEmis) de la boleta a partir de la fecha de la sesión.
 * Usa la fecha de la sesión para que el reembolso en la isapre calce con el día
 * de atención. El SII NO acepta fechas futuras, así que si la sesión aún no
 * ocurre (o es el marcador 2099 de un cobro sin fecha), cae a la fecha de hoy.
 */
export function fechaBoletaDesdeSesion(sessionDate?: string | null): string {
  const hoy = todayCL();
  if (!sessionDate) return hoy;
  if (sessionDate === '2099-12-31') return hoy;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) return hoy;
  return sessionDate <= hoy ? sessionDate : hoy;
}

/**
 * Emite la boleta de una reserva de punta a punta: resuelve paciente, glosa del
 * servicio, emite, resuelve el código y lo guarda en bookings.notes.
 * Reutilizable desde el admin (manual) y desde la confirmación de pago (automática).
 */
export async function emitBoletaParaReserva(
  bookingId: string,
  opts: { rutOverride?: string; enviarEmail?: boolean } = {},
): Promise<{ ok: boolean; folio?: number | null; codigo?: string | null; error?: string; alreadyEmitted?: boolean; enviada?: boolean; enviadaA?: string; errorEnvio?: string }> {
  const cfg = await getAgwConfig();
  if (!cfg) return { ok: false, error: 'API Gateway no configurado.' };

  const { data: b } = await supabase
    .from('bookings').select('patient_name, patient_email, amount, session_type, session_date, notes, service_id').eq('id', bookingId).single();
  if (!b) return { ok: false, error: 'Reserva no encontrada.' };

  // Una boleta anulada no cuenta: se puede emitir una nueva para esa sesión.
  const already = folioVigente(b.notes);
  if (already) return { ok: true, folio: already.folio, alreadyEmitted: true };

  const { data: p } = await supabase
    .from('patients').select('rut, name, address').eq('email', (b.patient_email ?? '').toLowerCase()).maybeSingle();
  const rutRaw = (opts.rutOverride ?? '').trim() || p?.rut || '';
  if (!rutRaw) return { ok: false, error: 'Falta el RUT del paciente.' };
  if (!b.amount) return { ok: false, error: 'La reserva no tiene monto.' };

  // CORREGIDO: este es el punto único por donde pasan TODAS las emisiones de
  // boleta (manual desde "Marcar como pagado", automática al confirmarse el
  // pago por Flow, etc.). Antes, un RUT escrito a mano (rutOverride) se usaba
  // solo para esa boleta puntual y se perdía — nunca quedaba en la ficha del
  // paciente. Por eso Valentina "siempre lo ponía" al emitir, pero la próxima
  // vez (sobre todo la boleta automática, que no pasa por ningún formulario)
  // no lo encontraba en ningún lado. Ahora se guarda acá, una sola vez, para
  // que beneficie a todos los flujos que llaman esta función.
  if (b.patient_email && (!p?.rut || p.rut !== normalizeRut(rutRaw))) {
    try {
      await upsertPatientFromBooking({ patient_name: p?.name ?? b.patient_name, patient_email: b.patient_email, rut: normalizeRut(rutRaw) });
    } catch (e) {
      await logError('boleta/guardar-rut', 'No se pudo guardar el RUT en la ficha del paciente', { bookingId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  let glosa = 'Atención psicológica';
  if (b.service_id) {
    const { data: svc } = await supabase
      .from('services_catalog').select('fonasa_description').eq('id', b.service_id).maybeSingle();
    if (svc?.fonasa_description) glosa = svc.fonasa_description as string;
  }

  // FchEmis = fecha de la sesión (para que el reembolso calce con el día de atención)
  const fecha = fechaBoletaDesdeSesion(b.session_date);

  try {
    const result = await emitirBHE({
      fecha,
      receptor: { rut: normalizeRut(rutRaw), razonSocial: p?.name ?? b.patient_name, direccion: p?.address ?? '' },
      detalle:  [{ nombre: glosa, monto: b.amount }],
    }, cfg) as { data?: { Encabezado?: { IdDoc?: { Folio?: number } } } };

    const folio = result?.data?.Encabezado?.IdDoc?.Folio ?? null;

    // ENCONTRADO (24 sep 2026, caso real de Werner Lange): si apigateway.cl
    // respondía 200 (sin lanzar excepción) pero SIN folio en el lugar
    // esperado — una respuesta "exitosa" pero vacía/con otra forma — el resto
    // de esta función se saltaba entero en silencio (el bloque de abajo nunca
    // corría) y esto igual devolvía { ok: true, folio: null }. El llamador
    // (flow/confirm.ts) solo revisa `.ok`, así que veía éxito y no avisaba
    // nada — la boleta jamás se emitió ni se envió a nadie, sin ningún rastro
    // en los logs. Ahora una respuesta sin folio se trata como el error real
    // que es, con el cuerpo de la respuesta guardado para poder diagnosticarlo.
    if (!folio) {
      await logError('boleta/emision', 'apigateway.cl respondió sin folio — la boleta probablemente no se generó', { bookingId, response: JSON.stringify(result ?? null).slice(0, 800) });
      return { ok: false, error: 'La emisión no devolvió folio (respuesta inesperada de apigateway.cl).' };
    }

    // Se guarda el folio de inmediato (aunque el envío falle después) para que
    // nunca se vuelva a emitir una segunda boleta por la misma sesión. Si hay
    // que enviarla, queda marcada como pendiente ANTES de intentarlo: si la
    // función se corta a medio camino (timeout de Vercel), el cron la recoge.
    {
      const pendiente = opts.enviarEmail ? `\n${MARCA_PENDIENTE} ${new Date().toISOString()}` : '';
      const nota = `${b.notes ? b.notes + '\n' : ''}Boleta Folio ${folio}${pendiente}`;
      await supabase.from('bookings').update({ notes: nota }).eq('id', bookingId);
    }
    // El envío (código SII con reintentos, PDF, paciente + copia a Valentina)
    // vive en enviarBoletaDeReserva. Si falla, deja la reserva marcada como
    // pendiente y el cron boletas-pendientes la reintenta — antes, cualquier
    // falla en este tramo dejaba la boleta emitida y sin enviar para siempre.
    let envio: { sent: boolean; email?: string; error?: string } = { sent: false };
    if (opts.enviarEmail) {
      try { envio = await enviarBoletaDeReserva(bookingId); } catch (e) {
        envio = { sent: false, error: e instanceof Error ? e.message : String(e) };
        await logError('boleta/envio', 'Excepción al enviar la boleta', { bookingId, folio, error: envio.error });
      }
    }
    const { data: after } = await supabase.from('bookings').select('notes').eq('id', bookingId).single();
    const codigo = folioVigente(after?.notes ?? null)?.codigo ?? null;
    return { ok: true, folio, codigo, enviada: envio.sent, enviadaA: envio.email, errorEnvio: envio.error };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Error al emitir';
    // Centralizado aquí (no solo en el llamador) para que ningún caller que
    // olvide revisar `.ok` deje una boleta fallida sin registro visible.
    await logError('boleta/emision', 'Falló la emisión de la boleta ante el SII', { bookingId, error: msg });
    return { ok: false, error: msg };
  }
}

export function clearAgwCache() { _cache = null; }
