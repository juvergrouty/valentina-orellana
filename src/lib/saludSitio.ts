import { supabase } from './supabase';
import { todayCL } from './dateUtils';

// Salud de la página (8 oct 2026): avisos en el panel cuando algo hay que
// renovar o reconectar (dominio, Resend, WhatsApp, Instagram, tareas
// automáticas, reseñas) antes de que la página o los correos dejen de
// funcionar. Valentina no revisa paneles externos: el aviso tiene que llegarle
// acá. El aviso de Google Calendar NO va aquí: ya lo muestra estadoGoogle()
// en AdminLayout.

const CLAVE_LATIDO   = 'cron_latido';            // ISO: última vez que corrió el cron de 5 minutos
const CLAVE_REVISION = 'salud_ultima_revision';  // ISO: última revisión diaria (freno de 12 h)
const CLAVE_SALUD    = 'salud_sitio';            // JSON SaludSitio
const DOMINIO        = 'valentinaorellana.cl';
const CADA_MS        = 12 * 60 * 60 * 1000;
const TIMEOUT_MS     = 8_000;
const DIA_MS         = 24 * 60 * 60 * 1000;

// Resultado de un chequeo. `valor` y `revisado` son del último chequeo que SÍ
// corrió; si uno falla (red caída, NIC lento) se conserva el valor anterior y
// el fallo se anota aparte, para no borrar lo que ya se sabía.
type Chequeo<T> = {
  valor?: T;
  revisado?: string;                                      // ISO del último chequeo exitoso
  fallo?: { at: string; desde: string; error: string };   // desde = primer fallo seguido
};
type EstadoWhatsapp = { ok: boolean; codigo?: number; mensaje?: string };
export type SaludSitio = {
  dominio?:  Chequeo<string>;          // fecha de expiración YYYY-MM-DD
  resend?:   Chequeo<string>;          // status de Resend ('verified', 'pending', …) o 'clave_invalida' / 'no_encontrado' / 'clave_restringida'
  whatsapp?: Chequeo<EstadoWhatsapp>;
};

export type AvisoSalud = { nivel: 'urgente' | 'aviso'; texto: string; accion?: string };

async function guardarSetting(key: string, value: string) {
  const { error } = await supabase.from('settings').upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  );
  if (error) throw new Error(error.message);
}

/** Lo llama el cron de 5 minutos: deja constancia de que las tareas automáticas corren. */
export async function registrarLatido(): Promise<void> {
  try { await guardarSetting(CLAVE_LATIDO, new Date().toISOString()); }
  catch (e) { console.warn('[saludSitio] no se pudo guardar el latido:', String(e)); }
}

// Error "no corrió" (lanzado) vs resultado definitivo (devuelto): solo lo lanzado
// cuenta como fallo y conserva el valor anterior.
async function revisarDominio(): Promise<string> {
  const res = await fetch(`https://www.nic.cl/registry/Whois.do?d=${DOMINIO}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`nic.cl respondió ${res.status}`);
  const texto = (await res.text()).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const m = texto.match(/Fecha de expiraci(?:ó|&oacute;|&#243;|o)n:\s*(\d{4}-\d{2}-\d{2})/i);
  if (!m) throw new Error('no se encontró "Fecha de expiración" en la respuesta de nic.cl');
  return m[1];
}

function dominioRemitente(): string | null {
  const from = String(import.meta.env.EMAIL_FROM ?? '').trim();
  const correo = from.match(/<([^>]+)>/)?.[1] ?? from;
  const dom = correo.split('@')[1]?.trim().toLowerCase();
  return dom || null;
}

async function revisarResend(clave: string, dominio: string): Promise<string> {
  const res = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${clave}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j: any = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    // Una clave "solo envío" no puede listar dominios (Resend: restricted_api_key):
    // la clave sirve, solo no deja revisar. No es un problema que avisar.
    return j?.name === 'restricted_api_key' ? 'clave_restringida' : 'clave_invalida';
  }
  if (!res.ok) throw new Error(`Resend respondió ${res.status}`);
  const lista: Array<{ name?: string; status?: string }> = Array.isArray(j?.data) ? j.data : [];
  const d = lista.find((x) => String(x.name ?? '').toLowerCase() === dominio);
  return d ? String(d.status ?? 'desconocido') : 'no_encontrado';
}

// Errores de Graph que son pasajeros (límite de uso, falla de Meta): no dicen
// nada del token, cuentan como "no corrió".
const GRAPH_PASAJEROS = new Set([1, 2, 4, 17, 32, 341, 613]);

async function revisarWhatsapp(token: string, phoneId: string): Promise<EstadoWhatsapp> {
  // El token va en la cabecera (no en la URL) para que no quede en ningún log de URLs.
  const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneId)}?fields=id`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j: any = await res.json().catch(() => ({}));
  if (res.ok && j?.id) return { ok: true };
  const codigo = typeof j?.error?.code === 'number' ? j.error.code : undefined;
  if (res.status >= 500 || (codigo !== undefined && GRAPH_PASAJEROS.has(codigo)) || (!j?.error && !res.ok)) {
    throw new Error(`Graph respondió ${res.status}${codigo !== undefined ? ` (código ${codigo})` : ''}`);
  }
  const mensaje = String(j?.error?.message ?? `respuesta inesperada (${res.status})`).split(token).join('[token]').slice(0, 300);
  return { ok: false, codigo, mensaje };
}

async function correrChequeo<T>(previo: Chequeo<T> | undefined, fn: () => Promise<T>, secreto?: string): Promise<Chequeo<T>> {
  const ahora = new Date().toISOString();
  try {
    return { valor: await fn(), revisado: ahora };
  } catch (e) {
    let error = String(e instanceof Error ? e.message : e);
    if (secreto) error = error.split(secreto).join('[token]');
    return { ...previo, fallo: { at: ahora, desde: previo?.fallo?.desde ?? ahora, error: error.slice(0, 300) } };
  }
}

/**
 * Lo llama el cron de 5 minutos: corre los chequeos diarios como máximo una vez
 * cada 12 h y guarda el resultado en settings.salud_sitio. Nunca lanza.
 */
export async function revisarSaludSiToca(): Promise<void> {
  try {
    const { data: filas, error } = await supabase.from('settings').select('key, value')
      .in('key', [CLAVE_REVISION, CLAVE_SALUD, 'whatsapp_access_token', 'whatsapp_phone_number_id']);
    // Si no se pudo leer, no se escribe nada: un salud_sitio vacío borraría lo ya sabido.
    if (error) { console.warn('[saludSitio] no se pudo leer settings:', error.message); return; }
    const m: Record<string, string> = {};
    (filas ?? []).forEach((r: { key: string; value: string }) => { m[r.key] = r.value; });

    const ultima = Date.parse(m[CLAVE_REVISION] ?? '');
    if (!isNaN(ultima) && Date.now() - ultima < CADA_MS) return;
    // Se marca ANTES de revisar: si algo se cuelga, el cron de 5 minutos no reintenta cada vez.
    await guardarSetting(CLAVE_REVISION, new Date().toISOString());

    let previo: SaludSitio = {};
    try { const p = JSON.parse(m[CLAVE_SALUD] || '{}'); if (p && typeof p === 'object') previo = p; } catch { /* ilegible: se parte de cero */ }

    const claveResend = import.meta.env.RESEND_API_KEY as string | undefined;
    const domResend = dominioRemitente();
    const waToken = m['whatsapp_access_token']?.trim();
    const waPhone = m['whatsapp_phone_number_id']?.trim();

    const [dominio, resend, whatsapp] = await Promise.all([
      correrChequeo(previo.dominio, revisarDominio),
      claveResend && domResend && domResend !== 'resend.dev'
        ? correrChequeo(previo.resend, () => revisarResend(claveResend, domResend), claveResend)
        : Promise.resolve(undefined),
      waToken && waPhone
        ? correrChequeo(previo.whatsapp, () => revisarWhatsapp(waToken, waPhone), waToken)
        : Promise.resolve(undefined),
    ]);

    const salud: SaludSitio = { dominio, resend, whatsapp };
    await guardarSetting(CLAVE_SALUD, JSON.stringify(salud));
  } catch (e) {
    console.warn('[saludSitio] revisión falló:', String(e));
  }
}

const fechaLargaCL = (iso: string) =>
  new Date(iso + 'T12:00:00Z').toLocaleDateString('es-CL', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
const horaCL = (iso: string) =>
  new Date(iso).toLocaleString('es-CL', { timeZone: 'America/Santiago', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/** Avisos de mantención para el panel, calculados con lo guardado en settings y los logs recientes. */
export async function avisosSalud(): Promise<AvisoSalud[]> {
  const ahora = Date.now();
  const [{ data: filas, error }, igErrores, resenasErrores] = await Promise.all([
    supabase.from('settings').select('key, value, updated_at').in('key', [
      CLAVE_SALUD, CLAVE_LATIDO, 'instagram_token_renovado', 'instagram_token_expira',
      'instagram_access_token', 'whatsapp_access_token', 'whatsapp_phone_number_id',
    ]),
    supabase.from('admin_logs').select('id', { count: 'exact', head: true })
      .eq('context', 'instagram/refresh-token').eq('level', 'error')
      .gt('created_at', new Date(ahora - 7 * DIA_MS).toISOString()),
    supabase.from('admin_logs').select('id', { count: 'exact', head: true })
      .eq('context', 'reviews/refresh-cache').eq('level', 'error')
      .gt('created_at', new Date(ahora - 3 * DIA_MS).toISOString()),
  ]);
  if (error) throw new Error(error.message);
  const m: Record<string, { value: string; updated_at?: string }> = {};
  (filas ?? []).forEach((r: { key: string; value: string; updated_at?: string }) => { m[r.key] = r; });
  const val = (k: string) => m[k]?.value?.trim() || '';

  let salud: SaludSitio = {};
  try { const p = JSON.parse(val(CLAVE_SALUD) || '{}'); if (p && typeof p === 'object') salud = p; } catch { /* ilegible */ }

  const avisos: AvisoSalud[] = [];

  // Dominio: si vence, se caen la página y los correos.
  const exp = salud.dominio?.valor;
  if (exp && /^\d{4}-\d{2}-\d{2}$/.test(exp)) {
    const [hy, hm, hd] = todayCL().split('-').map(Number);
    const [ey, em, ed] = exp.split('-').map(Number);
    const dias = Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(hy, hm - 1, hd)) / DIA_MS);
    if (dias < 0) {
      avisos.push({ nivel: 'urgente', accion: 'https://www.nic.cl',
        texto: `El dominio ${DOMINIO} venció el ${fechaLargaCL(exp)}: renuévalo hoy en NIC Chile (nic.cl → Mis dominios → Renovar). Mientras esté vencido, la página y los correos dejan de funcionar.` });
    } else if (dias <= 45) {
      avisos.push({ nivel: dias <= 15 ? 'urgente' : 'aviso', accion: 'https://www.nic.cl',
        texto: `Renueva el dominio ${DOMINIO} en NIC Chile antes del ${fechaLargaCL(exp)} (nic.cl → Mis dominios → Renovar). Si vence, la página y los correos dejan de funcionar.` });
    }
  }
  // Sin una revisión exitosa en 10+ días no se sabe la fecha real: revisar a mano.
  const okDom = Date.parse(salud.dominio?.revisado ?? '') || Date.parse(salud.dominio?.fallo?.desde ?? '');
  if (salud.dominio?.fallo && okDom && ahora - okDom >= 10 * DIA_MS) {
    avisos.push({ nivel: 'aviso', accion: 'https://www.nic.cl',
      texto: `No se ha podido revisar el vencimiento del dominio ${DOMINIO} hace más de 10 días: revísalo tú en nic.cl → Mis dominios.` });
  }

  // Resend: cualquier estado distinto de 'verified' (o clave inválida) puede dejar sin correos.
  const r = salud.resend?.valor;
  if (r && r !== 'verified' && r !== 'clave_restringida') {
    avisos.push({ nivel: 'urgente', accion: 'https://resend.com/domains',
      texto: 'Los correos automáticos (confirmaciones, boletas, recordatorios) podrían no estar llegando: revisa el dominio en Resend.' });
  }

  // WhatsApp: solo si sigue configurado y el token no se cambió después de la revisión
  // (si Valentina ya lo reconectó, el aviso viejo no debe seguir apareciendo 12 h).
  const wa = salud.whatsapp;
  if (wa?.valor && !wa.valor.ok && val('whatsapp_access_token') && val('whatsapp_phone_number_id')) {
    const tokenCambiado = Date.parse(m['whatsapp_access_token']?.updated_at ?? '') > Date.parse(wa.revisado ?? '');
    if (!tokenCambiado) {
      avisos.push({ nivel: 'urgente', accion: '/admin/whatsapp-conectar',
        texto: 'WhatsApp se desconectó: vuelve a conectarlo en el panel (WhatsApp).' });
    }
  }

  // Instagram: el token dura 60 días y lo renueva el cron mensual.
  const igConfigurado = !!val('instagram_access_token') || !!import.meta.env.INSTAGRAM_ACCESS_TOKEN;
  if (igConfigurado) {
    const renovado = Date.parse(val('instagram_token_renovado'));
    const expira = Date.parse(val('instagram_token_expira'));
    const conError = (igErrores.count ?? 0) > 0;
    const vencido = !isNaN(renovado) && (ahora - renovado > 45 * DIA_MS || (!isNaN(expira) && expira - ahora < 10 * DIA_MS));
    // Si Valentina guardó un token nuevo en Configuración hace menos de 7 días,
    // el aviso se oculta (el panel no marca la fecha de renovación; 9 oct 2026).
    const tokenGuardado = Date.parse(m['instagram_access_token']?.updated_at ?? '');
    const recienGuardado = !isNaN(tokenGuardado) && ahora - tokenGuardado < 7 * DIA_MS && (isNaN(renovado) || tokenGuardado > renovado);
    if ((conError || vencido) && !recienGuardado) {
      avisos.push({ nivel: 'aviso', accion: '/admin/configuracion',
        texto: 'Las fotos de Instagram de tu página dejarán de verse: hay que renovar el acceso a Instagram (Configuración → Instagram).' });
    }
  }

  // Tareas automáticas: el cron de 5 minutos deja un latido. Si nunca se escribió, no se avisa.
  const latido = Date.parse(val(CLAVE_LATIDO));
  if (!isNaN(latido) && ahora - latido > 30 * 60 * 1000) {
    avisos.push({ nivel: 'urgente',
      texto: `Las tareas automáticas (recordatorios, envíos después del pago, boletas pendientes) no están corriendo desde el ${horaCL(val(CLAVE_LATIDO))}. Avísame o revisa Supabase → Integrations → Cron.` });
  }

  // Reseñas de Google: un fallo aislado es normal; dos o más en 3 días, no.
  if ((resenasErrores.count ?? 0) >= 2) {
    avisos.push({ nivel: 'aviso', accion: '/admin/logs?filtro=error',
      texto: 'Las reseñas de Google de tu página no se están actualizando.' });
  }

  return avisos.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === 'urgente' ? -1 : 1));
}
