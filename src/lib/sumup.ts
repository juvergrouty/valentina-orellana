// Cobros con SumUp (18 nov 2026). Los dos caminos terminan igual que un pago con Flow: sesión
// pagada, boleta de honorarios (paciente, precio y glosa del servicio de esa sesión, como siempre),
// correos, calendario en verde y "Pasos a seguir" + consentimiento si es su primer pago
// (cola de tareasEnvio.ts).
//
//   1. Presencial, tarjeta en la consulta (Tap to Pay en el iPhone de Vale): ella cobra en la app de
//      SumUp el monto de la sesión. La página asocia el cobro a la sesión por monto y hora
//      (sumupMatch.ts, solo cobros presenciales) y, si hay cualquier duda, lo deja "por asociar" en
//      Cobros e Inicio para que ella elija. Si el cobro se inició con «En la consulta» del panel (abre
//      la app con foreign-tx-id = id de la reserva, 20 nov 2026), ese id manda: ver sincronizarSumUp.
//   2. Online: link de pago de SumUp (hosted checkout) creado por la página para esa sesión; al
//      pagarse se asocia por el link, nunca por hora.
//
// Un cobro paga sesiones UNA sola vez: antes de tocar la base se "reserva" el código con una fila
// settings 'sumup_uso_<código>' (insert; la llave primaria impide que dos procesos lo tomen).
// El cron de cada 5 min (cron/boletas-pendientes) llama a sincronizarSumUp(). La API de SumUp se lee
// con la clave secreta SUMUP_API_KEY (variable de entorno; nunca en el código ni en la base).
import { supabase } from './supabase';
import { secreto } from './secretos';
import { logError, logInfo, logWarn } from './logger';
import { encolarTareas, procesarTareas, tareasDePago, sesionVigente, type TareaPago } from './tareasEnvio';
import { upsertPatientFromBooking, fichaDesdePrimerPago } from './patients';
import { agregarLineaNotas } from './apigateway';
import { markBookingPaidInCalendar, syncBookingToCalendar } from './syncCalendar';
import { todayCL } from './dateUtils';
import { NOTA_PAGO_SUMUP, pagoSumUp, sesionParaCobro, esPresencial, sesionCobrable, codigoValido, enHoraChile, type CobroSumUp, type SesionCandidata } from './sumupMatch';

export const SUMUP_MERCHANT = 'M421JSNB';
const API = 'https://api.sumup.com';
// Estado en settings (sin migración). Lista de cobros por asociar: una fila JSON. "No es de una sesión"
// y "pago anulado" son una fila por cobro (insert): nunca se pierden aunque el cron escriba la lista
// al mismo tiempo.
const CLAVE_ESTADO = 'sumup_estado';
const CLAVE_USO = (codigo: string) => `sumup_uso_${codigo}`;
const PREF_MANUAL = 'sumup_manual_';
const PREF_IGNORADO = 'sumup_ignorado_';
const PREF_REEMBOLSO = 'sumup_reembolso_'; // aviso de reembolso ya dado (una vez por cobro)
// "Asociar a un paciente" (20 nov 2026): el cobro queda registrado en una sesión SIN emitir boleta
// (ej. parte de una sesión cuya boleta ya se emitió por otro lado). Una fila por cobro con el detalle.
const PREF_PACIENTE = 'sumup_paciente_';
// En LIKE el "_" es comodín de un carácter: no se escapa (no hay otras llaves "sumup?…" en settings)
// para no depender de cómo PostgREST pasa la barra invertida.
const comoPrefijo = (p: string) => `${p}%`;
export const MARCA_CHECKOUT = 'SumUpCheckout';
const RE_CHECKOUT = /^SumUpCheckout (\S+)/gm;

// manual: cobros cuyo pago Vale anuló ("Anular pago"): nunca más se asocian solos, solo a mano.
export type EstadoSumUp = { ignorados: string[]; manual: string[]; porAsociar: CobroSumUp[]; revisadoEn?: string };

export const sumupConfigurado = () => !!secreto('SUMUP_API_KEY');

async function api<T>(ruta: string, init: RequestInit = {}): Promise<T> {
  const key = secreto('SUMUP_API_KEY');
  if (!key) throw new Error('Falta la clave de SumUp (SUMUP_API_KEY).');
  const r = await fetch(`${API}${ruta}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8_000),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`SumUp respondió ${r.status}: ${txt.slice(0, 200)}`);
  return (txt ? JSON.parse(txt) : {}) as T;
}

type TxApi = {
  transaction_code: string; amount: number; currency: string; status: string; type?: string;
  timestamp: string; card_type?: string; entry_mode?: string; refunded_amount?: number | null;
  foreign_transaction_id?: string | null;
};

const aCobro = (t: TxApi): CobroSumUp => ({
  codigo: t.transaction_code, monto: Math.round(Number(t.amount)), cuando: t.timestamp,
  tarjeta: t.card_type ?? null, estado: t.status, modo: t.entry_mode ?? null,
});
const valido = (t: TxApi) => t.status === 'SUCCESSFUL' && t.currency === 'CLP' && codigoValido(t.transaction_code)
  && !(Number(t.refunded_amount) > 0) && (!t.type || t.type === 'PAYMENT');

/** Cobros exitosos (pagos, no devoluciones ni reembolsados) desde `desde` (ISO), más nuevos primero. */
export async function cobrosExitosos(desde: string): Promise<(CobroSumUp & { foreign?: string | null })[]> {
  const q = new URLSearchParams({ limit: '100', order: 'descending', oldest_time: desde });
  q.append('statuses[]', 'SUCCESSFUL');
  q.append('types[]', 'PAYMENT');
  const d = await api<{ items?: TxApi[] }>(`/v2.1/merchants/${SUMUP_MERCHANT}/transactions/history?${q}`);
  return (d.items ?? []).filter(valido).map((t) => ({ ...aCobro(t), foreign: t.foreign_transaction_id ?? null }));
}

/** Códigos de cobros reembolsados (total o parcial) desde `desde`. */
async function codigosReembolsados(desde: string): Promise<string[]> {
  const q = new URLSearchParams({ limit: '100', order: 'descending', oldest_time: desde });
  q.append('statuses[]', 'REFUNDED');
  q.append('statuses[]', 'SUCCESSFUL');
  q.append('types[]', 'PAYMENT');
  const d = await api<{ items?: TxApi[] }>(`/v2.1/merchants/${SUMUP_MERCHANT}/transactions/history?${q}`);
  return (d.items ?? []).filter((t) => codigoValido(t.transaction_code) && (t.status === 'REFUNDED' || Number(t.refunded_amount) > 0)).map((t) => t.transaction_code);
}

/** Cobro reembolsado en SumUp que ya había pagado una sesión: aviso a Vale (una vez), nunca se
 *  toca la sesión ni la boleta sola (anular una boleta es decisión de ella). */
async function avisarReembolsos(): Promise<void> {
  const reemb = await codigosReembolsados(new Date(Date.now() - 14 * 86400_000).toISOString());
  if (!reemb.length) return;
  const { data } = await supabase.from('bookings').select('id, patient_name, session_date, mp_payment_id').in('mp_payment_id', reemb.map(pagoSumUp));
  const avisados = new Set(await marcados(PREF_REEMBOLSO));
  for (const b of data ?? []) {
    const codigo = String(b.mp_payment_id).slice(6);
    if (avisados.has(codigo)) continue;
    await marcar(PREF_REEMBOLSO, codigo);
    await logError('sumup/reembolso', `El cobro con tarjeta de la sesión de ${b.patient_name} (${String(b.session_date).split('-').reverse().join('/')}) se reembolsó en SumUp, pero la sesión sigue pagada y con boleta. Revisa si hay que anular el pago y la boleta.`, { bookingId: b.id, codigo });
  }
}

/** foreign-tx-id del cobro (lo puso el botón «En la consulta» del panel), leído del detalle. */
async function foreignDeCobro(codigo: string): Promise<string | null> {
  if (!codigoValido(codigo)) return null;
  const t = await api<TxApi>(`/v2.1/merchants/${SUMUP_MERCHANT}/transactions?transaction_code=${encodeURIComponent(codigo)}`);
  return t?.foreign_transaction_id ?? null;
}

/** Un cobro por su código, vuelto a leer en SumUp (para asociarlo a mano). */
export async function cobroPorCodigo(codigo: string): Promise<CobroSumUp | null> {
  if (!codigoValido(codigo)) return null;
  const t = await api<TxApi>(`/v2.1/merchants/${SUMUP_MERCHANT}/transactions?transaction_code=${encodeURIComponent(codigo)}`);
  return t?.transaction_code && valido(t) ? aCobro(t) : null;
}

function parsearEstado(value: unknown): EstadoSumUp {
  try {
    const v = JSON.parse(String(value ?? '{}'));
    return { ignorados: Array.isArray(v.ignorados) ? v.ignorados.filter(codigoValido) : [], manual: Array.isArray(v.manual) ? v.manual.filter(codigoValido) : [], porAsociar: Array.isArray(v.porAsociar) ? v.porAsociar.filter((p: CobroSumUp) => codigoValido(p?.codigo)) : [], revisadoEn: v.revisadoEn };
  } catch { return { ignorados: [], manual: [], porAsociar: [] }; }
}

/** Códigos marcados con una fila settings '<prefijo><código>'. */
async function marcados(prefijo: string): Promise<string[]> {
  const { data, error } = await supabase.from('settings').select('key').like('key', comoPrefijo(prefijo)).limit(2000);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { key: string }) => r.key.slice(prefijo.length)).filter(codigoValido);
}

/** Marca un cobro (fila propia). Lanza error si no quedó guardada: quien llama no sigue sin ella. */
async function marcar(prefijo: string, codigo: string): Promise<void> {
  const { error } = await supabase.from('settings').insert({ key: `${prefijo}${codigo}`, value: new Date().toISOString(), updated_at: new Date().toISOString() });
  if (error && error.code !== '23505') throw new Error(error.message); // 23505 = ya estaba marcado
}

export async function leerEstado(): Promise<EstadoSumUp> {
  const [{ data, error }, manual, ignorados] = await Promise.all([
    supabase.from('settings').select('value').eq('key', CLAVE_ESTADO).maybeSingle(),
    marcados(PREF_MANUAL), marcados(PREF_IGNORADO),
  ]);
  if (error) throw new Error(error.message);
  return { ...parsearEstado(data?.value), manual, ignorados };
}

/** Guarda el estado juntando lo que otro proceso haya cambiado mientras tanto ("no es de una sesión"
 *  marcado durante una revisión no se pierde): `cambio` recibe el estado recién leído. */
async function cambiarEstado(cambio: (e: EstadoSumUp) => EstadoSumUp): Promise<void> {
  const e = cambio(await leerEstado());
  const ign = new Set(e.ignorados);
  const value = JSON.stringify({ porAsociar: e.porAsociar.filter((p) => !ign.has(p.codigo)).slice(0, 50), revisadoEn: e.revisadoEn });
  const { error } = await supabase.from('settings').upsert({ key: CLAVE_ESTADO, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) {
    await logError('sumup/estado', 'No se pudo guardar la lista de cobros de SumUp por asociar', { error: error.message });
    throw new Error(error.message);
  }
}

/** Códigos de SumUp ya usados: pagaron una sesión con boleta (bookings.mp_payment_id = "sumup-<código>")
 *  o se asociaron a un paciente sin boleta (fila 'sumup_paciente_<código>'). Nunca se usan dos veces. */
async function codigosUsados(codigos: string[]): Promise<Set<string>> {
  if (!codigos.length) return new Set();
  const [{ data, error }, sinBoleta] = await Promise.all([
    supabase.from('bookings').select('mp_payment_id').in('mp_payment_id', codigos.map(pagoSumUp)),
    asociacionesSinBoleta(codigos),
  ]);
  if (error) throw new Error(error.message);
  return new Set([...(data ?? []).map((r: { mp_payment_id: string }) => r.mp_payment_id.slice(6)), ...sinBoleta.keys()]);
}

export type AsociacionSinBoleta = { bookingId: string; patient_name: string; session_date: string; session_time: string; monto: number; resto: number; origenResto: string; en: string };

/** Cobros asociados a un paciente sin boleta (código → detalle). Lanza error si no se pudo leer. */
export async function asociacionesSinBoleta(codigos: string[]): Promise<Map<string, AsociacionSinBoleta>> {
  const validos = codigos.filter(codigoValido);
  if (!validos.length) return new Map();
  const { data, error } = await supabase.from('settings').select('key, value').in('key', validos.map((c) => `${PREF_PACIENTE}${c}`));
  if (error) throw new Error(error.message);
  const m = new Map<string, AsociacionSinBoleta>();
  for (const r of data ?? []) {
    let v: any = {};
    try { v = JSON.parse(String(r.value ?? '{}')); } catch { /* fila rara: igual cuenta como usado */ }
    m.set(String(r.key).slice(PREF_PACIENTE.length), v && v.bookingId && v.patient_name ? v : { bookingId: '', patient_name: 'una sesión', session_date: '', session_time: '', monto: 0, resto: 0, origenResto: '', en: '' });
  }
  return m;
}

/** Reserva el código para este proceso. false = otro proceso ya lo tomó (o ya pagó una sesión). */
async function reservarCodigo(codigo: string): Promise<boolean> {
  const fila = () => ({ key: CLAVE_USO(codigo), value: new Date().toISOString(), updated_at: new Date().toISOString() });
  const { error } = await supabase.from('settings').insert(fila());
  if (!error) return true;
  // Reserva de un proceso que se cortó antes de marcar la sesión (más de 10 min y ninguna sesión con
  // este cobro): se libera y se intenta una vez más. Si sigue tomada, otro proceso la tiene.
  const { data } = await supabase.from('settings').select('value').eq('key', CLAVE_USO(codigo)).maybeSingle();
  const vieja = Date.now() - Date.parse(String(data?.value ?? '')) > 10 * 60_000;
  if (!vieja || (await codigosUsados([codigo])).size) return false;
  await supabase.from('settings').delete().eq('key', CLAVE_USO(codigo)).eq('value', String(data?.value));
  const r = await supabase.from('settings').insert(fila());
  return !r.error;
}

/** Suelta la reserva del código (el cobro ya quedó en mp_payment_id, o no se pudo usar). */
async function liberarCobroSumUp(codigo: string): Promise<void> {
  if (!codigoValido(codigo)) return;
  await supabase.from('settings').delete().eq('key', CLAVE_USO(codigo));
}

/** Paso 1 de "Anular pago" de una sesión pagada con SumUp, ANTES de quitarle el pago: el cobro ya
 *  nunca se asocia solo (si no, la revisión de cada 5 min lo volvería a poner en la misma sesión).
 *  Lanza error si no se pudo guardar: entonces el pago no se anula. */
export async function marcarManualSumUp(codigo: string): Promise<void> {
  if (!codigoValido(codigo)) throw new Error('Código de SumUp no válido.');
  await marcar(PREF_MANUAL, codigo);
}

/** Paso 2 de "Anular pago" (ya sin pago): el cobro vuelve a "por asociar" para elegir su sesión. */
export async function anularPagoSumUp(codigo: string): Promise<void> {
  if (!codigoValido(codigo)) return;
  // Si el mismo cobro pagó también otra sesión, sigue "usado": hay que anular ese pago también.
  const { data: otras } = await supabase.from('bookings').select('patient_name, session_date').eq('mp_payment_id', pagoSumUp(codigo));
  if (otras?.length) {
    await logWarn('sumup/anular', `Anulaste un pago con tarjeta, pero ese mismo cobro también pagó ${otras.map((o) => `la sesión de ${o.patient_name} (${String(o.session_date).split('-').reverse().join('/')})`).join(' y ')}. Para asociarlo a otra sesión, anula también ese pago.`, { codigo });
    return;
  }
  const cobro = await cobroPorCodigo(codigo).catch(() => null);
  if (!cobro) return; // reembolsado o SumUp no responde: la revisión de cada 5 min lo pone por asociar
  await cambiarEstado((e) => ({ ...e, porAsociar: e.porAsociar.some((p) => p.codigo === codigo) ? e.porAsociar : [cobro, ...e.porAsociar] }));
}

/** Cobros por asociar que siguen sin usar (lo que muestran Inicio y Cobros). */
export async function porAsociarVigentes(): Promise<CobroSumUp[]> {
  const e = await leerEstado();
  const usados = await codigosUsados(e.porAsociar.map((p) => p.codigo)).catch(() => new Set<string>());
  const ignorados = new Set(e.ignorados);
  return e.porAsociar.filter((p) => !usados.has(p.codigo) && !ignorados.has(p.codigo));
}

const COLS = 'id, patient_name, patient_email, patient_phone, patient_rut, session_date, session_time, duration_min, amount, status, paid_at, debt_voided, created_by_admin, notes, mp_payment_id';

/**
 * Marca pagadas con un cobro de SumUp las sesiones indicadas y dispara lo mismo que Flow.
 * La suma de las sesiones debe ser igual al monto cobrado.
 */
export async function registrarPagoSumUp(ids: string[], cobro: CobroSumUp, origen: 'auto' | 'panel', hastaMs = Date.now() + 15_000): Promise<{ ok: boolean; error?: string; pagadas: string[] }> {
  if (!ids.length) return { ok: false, error: 'Elige al menos una sesión.', pagadas: [] };
  const { data: filas, error: e1 } = await supabase.from('bookings').select(COLS).in('id', ids);
  if (e1) { console.error('[sumup] leer sesiones:', e1.message); return { ok: false, error: 'No se pudo leer la sesión. Intenta de nuevo en un minuto.', pagadas: [] }; }
  const sesiones = (filas ?? []) as (SesionCandidata & Record<string, any>)[];
  if (sesiones.length !== new Set(ids).size) return { ok: false, error: 'No se encontró alguna de las sesiones.', pagadas: [] };
  if (sesiones.some((s) => s.paid_at)) return { ok: false, error: 'Alguna de esas sesiones ya estaba pagada.', pagadas: [] };
  if (sesiones.some((s) => !sesionCobrable(s))) return { ok: false, error: 'Alguna de esas sesiones está anulada, cancelada o vencida.', pagadas: [] };
  const suma = sesiones.reduce((t, s) => t + (Number(s.amount) || 0), 0);
  if (suma !== cobro.monto) return { ok: false, error: `El cobro es de $${cobro.monto.toLocaleString('es-CL')} y las sesiones suman $${suma.toLocaleString('es-CL')}.`, pagadas: [] };

  if ((await codigosUsados([cobro.codigo])).size || !(await reservarCodigo(cobro.codigo))) {
    return { ok: false, error: 'Ese cobro de SumUp ya está asociado a una sesión.', pagadas: [] };
  }
  // Otra vuelta después de reservar: otro proceso pudo usarlo y soltar su reserva entremedio.
  if ((await codigosUsados([cobro.codigo])).size) {
    await liberarCobroSumUp(cobro.codigo);
    return { ok: false, error: 'Ese cobro de SumUp ya está asociado a una sesión.', pagadas: [] };
  }
  // Asociación automática: se mira DESPUÉS de lo anterior si Vale anuló este pago o dijo "no es de una
  // sesión" (fila propia, recién leída). "Anular pago" guarda esa marca antes de quitar el pago, así que
  // el cron nunca lo vuelve a poner aunque las dos cosas pasen al mismo tiempo.
  if (origen === 'auto') {
    const { data: marca, error: eMarca } = await supabase.from('settings').select('key')
      .in('key', [`${PREF_MANUAL}${cobro.codigo}`, `${PREF_IGNORADO}${cobro.codigo}`]).limit(1);
    if (eMarca || marca?.length) {
      await liberarCobroSumUp(cobro.codigo);
      return { ok: false, error: 'Ese cobro se asocia a mano.', pagadas: [] };
    }
  }

  const pago = pagoSumUp(cobro.codigo);
  const nuevas = new Set(sesiones.filter((s) => s.status === 'pending_payment' && sesionVigente(s.session_date)).map((s) => s.id));
  const pagadas: any[] = [];
  for (const s of sesiones) {
    // paid_at = ahora (como Flow): el barrido de respaldo de tareasEnvio.ts cuenta con eso.
    const { data, error } = await supabase.from('bookings')
      .update({ status: 'confirmed', paid_at: new Date().toISOString(), payment_note: NOTA_PAGO_SUMUP, mp_payment_id: pago })
      .eq('id', s.id).is('paid_at', null).select(COLS);
    if (error) {
      await logError('sumup/pago', `Cobro de SumUp recibido ($${cobro.monto.toLocaleString('es-CL')}), pero la sesión de ${s.patient_name} no se pudo marcar pagada. Márcala a mano.`, { bookingId: s.id, codigo: cobro.codigo, error: error.message });
      continue;
    }
    if (data?.length) pagadas.push(data[0]);
  }
  // Desde aquí el cobro queda marcado en mp_payment_id: la reserva ya no hace falta (no se acumulan filas).
  await liberarCobroSumUp(cobro.codigo);
  if (!pagadas.length) return { ok: false, error: 'No se pudo marcar ninguna sesión como pagada.', pagadas: [] };
  if (pagadas.length < sesiones.length) {
    await logError('sumup/pago-parcial', `Un cobro de SumUp de $${cobro.monto.toLocaleString('es-CL')} pagó solo ${pagadas.length} de ${sesiones.length} sesiones (otra se pagó por otro medio al mismo tiempo). Revisa si hay que devolver una parte.`, { codigo: cobro.codigo, ids, pagadas: pagadas.map((r) => r.id) });
  }

  // Envíos igual que Flow: reserva nueva → calendario, confirmación, aviso y boleta; sesión ya
  // agendada o deuda → boleta y calendario en verde. "Pasos a seguir": una vez por correo por pago.
  const hora = new Date(cobro.cuando).toLocaleString('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const conPasos = new Set<string>();
  const enCola: string[] = [];
  for (const r of pagadas) {
    const t: TareaPago[] = tareasDePago(nuevas.has(r.id));
    const em = String(r.patient_email ?? '').toLowerCase();
    if (em && !conPasos.has(em)) { conPasos.add(em); t.push('pasos'); }
    if (await encolarTareas(r.id, t, pago)) enCola.push(r.id);
    await agregarLineaNotas(r.id, `Pagada con SumUp: cobro ${cobro.codigo} del ${hora} (${origen === 'auto' ? 'asociado solo' : 'asociado en el panel'})`);
  }
  const idsPagadas = pagadas.map((r) => r.id);
  for (const r of pagadas) {
    await upsertPatientFromBooking({ patient_name: r.patient_name, patient_email: r.patient_email, patient_phone: r.patient_phone, rut: r.patient_rut }).catch(console.error);
    await fichaDesdePrimerPago(r, idsPagadas).catch(console.error);
  }
  // Lo que no alcance ahora lo hace el cron en la próxima pasada (sin duplicar).
  if (enCola.length && Date.now() < hastaMs) await procesarTareas({ bookingIds: enCola, hastaMs }).catch(console.error);
  await logInfo('sumup/pago', `Cobro de SumUp $${cobro.monto.toLocaleString('es-CL')} asociado a ${pagadas.map((r) => r.patient_name).join(', ')}`, { codigo: cobro.codigo, ids: idsPagadas, origen });
  return { ok: true, pagadas: idsPagadas };
}

/** Sesiones sin pagar para elegir a mano: de los últimos 60 días a los próximos 7. */
export async function sesionesParaElegir(): Promise<any[]> {
  const hoy = Date.now();
  const desde = new Date(hoy - 60 * 86400_000).toISOString().slice(0, 10);
  const hasta = new Date(hoy + 7 * 86400_000).toISOString().slice(0, 10);
  const { data } = await supabase.from('bookings').select('id, patient_name, session_date, session_time, amount, status, paid_at, debt_voided')
    .is('paid_at', null).not('status', 'in', '(cancelled,expired)').or('debt_voided.is.null,debt_voided.eq.false')
    .gte('session_date', desde).lte('session_date', hasta).gt('amount', 0)
    .order('session_date', { ascending: false }).order('session_time', { ascending: false }).limit(200);
  return data ?? [];
}

const checkoutsDe = (notas: string | null | undefined) => [...String(notas ?? '').matchAll(RE_CHECKOUT)].map((m) => m[1]);

/** Link de pago de SumUp (online) para una sesión. */
export async function crearLinkSumUp(bookingId: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const { data: b } = await supabase.from('bookings').select('id, session_date, amount, paid_at, status, debt_voided, notes').eq('id', bookingId).maybeSingle();
  if (!b) return { ok: false, error: 'No se encontró la sesión.' };
  if (b.paid_at) return { ok: false, error: 'Esa sesión ya está pagada.' };
  if (b.status === 'cancelled' || b.status === 'expired' || b.debt_voided) return { ok: false, error: 'Esa sesión está cancelada, vencida o anulada.' };
  if (!(Number(b.amount) > 0)) return { ok: false, error: 'Esa sesión no tiene monto.' };
  if (!b.session_date || b.session_date === '2099-12-31') return { ok: false, error: 'El link de SumUp es para una sesión con fecha. Para un cobro sin fecha usa el link de pago de siempre.' };
  // El último link vigente de esta sesión (mismo monto) se reutiliza: nunca dos links pagables a la vez.
  const ultimo = checkoutsDe(b.notes).at(-1);
  if (ultimo) {
    try {
      const c = await api<{ status: string; amount: number; hosted_checkout_url?: string }>(`/v0.1/checkouts/${encodeURIComponent(ultimo)}`);
      if (c.status === 'PENDING' && Math.round(c.amount) === Number(b.amount) && c.hosted_checkout_url) return { ok: true, url: c.hosted_checkout_url };
      if (c.status === 'PENDING') await api(`/v0.1/checkouts/${encodeURIComponent(ultimo)}`, { method: 'DELETE' }).catch(() => {});
      if (c.status === 'PAID') return { ok: false, error: 'Ese link ya se pagó: en unos minutos la sesión queda pagada sola.' };
    } catch { /* vencido o borrado: se crea otro */ }
  }
  const fecha = ` ${b.session_date.split('-').reverse().join('/')}`;
  const c = await api<{ id: string; hosted_checkout_url?: string }>('/v0.1/checkouts', {
    method: 'POST',
    body: JSON.stringify({
      checkout_reference: `${bookingId}-${Date.now().toString(36)}`, amount: Number(b.amount), currency: 'CLP',
      merchant_code: SUMUP_MERCHANT, description: `Sesión de psicoterapia${fecha}`, hosted_checkout: { enabled: true },
    }),
  });
  if (!c.hosted_checkout_url) return { ok: false, error: 'SumUp no devolvió el link de pago.' };
  await agregarLineaNotas(bookingId, `${MARCA_CHECKOUT} ${c.id}`);
  return { ok: true, url: c.hosted_checkout_url };
}

/**
 * Página /hora/<token> (22 nov 2026): al volver del link de SumUp la paciente no espera al cron de
 * 5 min. Revisa SOLO los links de esa sesión y, si uno está pagado, lo registra con el mismo
 * registrarPagoSumUp del cron (el código se reserva una sola vez: nunca paga dos veces). Cualquier
 * caso dudoso (cobro anulado por Vale, ignorado, sesión ya pagada) se deja al cron, que avisa.
 */
export async function revisarLinkSumUpDeSesion(bookingId: string): Promise<boolean> {
  if (!sumupConfigurado()) return false;
  const { data: b } = await supabase.from('bookings').select('id, notes, paid_at, status').eq('id', bookingId).maybeSingle();
  if (!b || b.paid_at || b.status === 'cancelled') return !!b?.paid_at;
  const estado = await leerEstado();
  for (const id of checkoutsDe(b.notes).slice(-2)) {
    let c: { status: string; transactions?: TxApi[] };
    try { c = await api(`/v0.1/checkouts/${encodeURIComponent(id)}`); } catch { continue; }
    const tx = (c.transactions ?? []).find(valido);
    if (c.status !== 'PAID' || !tx) continue;
    if (estado.ignorados.includes(tx.transaction_code) || estado.manual.includes(tx.transaction_code)) return false;
    const r = await registrarPagoSumUp([b.id], aCobro(tx), 'auto');
    return r.ok;
  }
  return false;
}

/**
 * Links de SumUp pagados. Devuelve los códigos de cobro que vinieron de un link (esos nunca se
 * asocian por hora). Un link pagado de una sesión ya pagada por otro medio o cancelada queda por
 * asociar y con aviso (posible pago doble), como en Flow.
 */
async function revisarLinks(hastaMs: number, porAsociar: CobroSumUp[], estado: EstadoSumUp): Promise<{ codigos: Set<string>; asociados: number }> {
  const ignorados = new Set(estado.ignorados);
  const manual = new Set(estado.manual);
  const yaAvisados = new Set(estado.porAsociar.map((p) => p.codigo));
  const codigos = new Set<string>();
  let asociados = 0;
  const desde = new Date(Date.now() - 21 * 86400_000).toISOString().slice(0, 10);
  const { data } = await supabase.from('bookings').select('id, patient_name, notes, paid_at, status, mp_payment_id')
    .ilike('notes', `%${MARCA_CHECKOUT}%`).gte('session_date', desde).neq('session_date', '2099-12-31')
    .order('session_date', { ascending: false }).limit(40);
  for (const b of data ?? []) {
    // Solo los dos últimos links: crear uno nuevo borra el anterior sin pagar (crearLinkSumUp).
    for (const id of checkoutsDe(b.notes).slice(-2)) {
      if (Date.now() > hastaMs) return { codigos, asociados };
      let c: { status: string; transactions?: TxApi[] };
      try { c = await api(`/v0.1/checkouts/${encodeURIComponent(id)}`); } catch (e) { console.error('[sumup] link:', (e as Error).message); continue; }
      const tx = (c.transactions ?? []).find(valido);
      if (c.status !== 'PAID' || !tx) continue;
      codigos.add(tx.transaction_code);
      if (b.mp_payment_id === pagoSumUp(tx.transaction_code)) continue; // ya asociado a esta sesión
      if (ignorados.has(tx.transaction_code)) continue; // Vale dijo "no es de una sesión"
      const cobro = aCobro(tx);
      // Vale anuló su pago: nunca se asocia solo, pero sigue "por asociar" para que elija la sesión.
      if (manual.has(cobro.codigo)) {
        if (!yaAvisados.has(cobro.codigo) && !(await codigosUsados([cobro.codigo])).size) porAsociar.push(cobro);
        continue;
      }
      const r = b.paid_at ? { ok: false, error: 'la sesión ya figuraba pagada' } : await registrarPagoSumUp([b.id], cobro, 'auto', hastaMs);
      if (r.ok) { asociados++; continue; }
      // Ya por asociar (aviso dado en una pasada anterior) o ya usado: no se repite el aviso.
      if (yaAvisados.has(cobro.codigo) || r.error === 'Ese cobro se asocia a mano.' || (await codigosUsados([cobro.codigo])).size) continue;
      await logError('sumup/link', `${b.patient_name} pagó un link de SumUp de $${cobro.monto.toLocaleString('es-CL')}, pero no se pudo asociar a su sesión (${String(r.error ?? '').replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase())}). Revisa si hay que devolver el pago o asignarlo a otra sesión en Cobros.`, { bookingId: b.id, codigo: cobro.codigo });
      porAsociar.push(cobro);
    }
  }
  return { codigos, asociados };
}

/**
 * Cron cada 5 min (y botón "Revisar"): lee los cobros de SumUp de los últimos 14 días y asocia solos
 * los que no tienen duda. Los demás quedan "por asociar" (Inicio y Cobros), sin duplicar avisos.
 */
export async function sincronizarSumUp(opts: { hastaMs?: number } = {}): Promise<{ asociados: number; porAsociar: number } | null> {
  if (!sumupConfigurado()) return null;
  const hastaMs = opts.hastaMs ?? Date.now() + 40_000;
  // Reservas que quedaron de un proceso cortado (normalmente se sueltan al terminar cada pago).
  await supabase.from('settings').delete().like('key', comoPrefijo('sumup_uso_')).lt('updated_at', new Date(Date.now() - 86400_000).toISOString());
  const nuevosPend: CobroSumUp[] = [];
  const estado = await leerEstado();
  const links = await revisarLinks(hastaMs, nuevosPend, estado).catch((e) => { console.error('[sumup] links:', e); return { codigos: new Set<string>(), asociados: 0 }; });
  const cobros = await cobrosExitosos(new Date(Date.now() - 14 * 86400_000).toISOString());
  const manual = new Set(estado.manual);
  const usados = await codigosUsados(cobros.map((c) => c.codigo));
  const ignorados = new Set(estado.ignorados);
  let asociados = links.asociados;
  const foreignPrevio = new Map(estado.porAsociar.filter((p) => 'foreign' in p).map((p) => [p.codigo, p.foreign ?? null]));

  for (const c of cobros) {
    if (usados.has(c.codigo) || ignorados.has(c.codigo) || links.codigos.has(c.codigo)) continue;
    if (manual.has(c.codigo)) { nuevosPend.push({ codigo: c.codigo, monto: c.monto, cuando: c.cuando, tarjeta: c.tarjeta, modo: c.modo }); continue; }
    if (Date.now() > hastaMs) break;
    let elegida: string | null = null;
    // La lista de SumUp (transactions/history) NO trae foreign_transaction_id: solo el detalle lo trae
    // (verificado 20 nov 2026 con el cobro de prueba TAAA7LS7VTB). Se lee el detalle de cada cobro
    // todavía sin asociar (pocos por pasada); si la lectura falla, se sigue con hora y monto.
    //    Se guarda en la lista "por asociar" para no volver a leerlo en cada pasada. Si la lectura
    //    falla, el cobro se salta esta pasada (no se asocia por hora a otra sesión) y se reintenta.
    if (!c.foreign && esPresencial(c)) {
      if (foreignPrevio.has(c.codigo)) c.foreign = foreignPrevio.get(c.codigo) ?? null;
      else {
        try { c.foreign = await foreignDeCobro(c.codigo); }
        catch (e) { console.error('[sumup] detalle del cobro:', (e as Error).message); continue; }
      }
    }
    // 1) foreign-tx-id = id de la reserva (si el cobro se inició desde el panel).
    //    El panel lo manda como "<id>.<hora>" (SumUp exige que sea único por cobro, y así se puede
    //    reintentar un cobro fallido): manda el id de 36 caracteres del inicio.
    const idBoton = /^[0-9a-f-]{36}(\.[0-9a-z]{1,12})?$/i.test(String(c.foreign ?? '')) ? String(c.foreign).slice(0, 36) : null;
    if (idBoton) {
      const { data: s } = await supabase.from('bookings').select(COLS).eq('id', idBoton).maybeSingle();
      if (s && sesionCobrable(s as SesionCandidata) && Number(s.amount) === c.monto) elegida = s.id;
      // Ella lo inició para ESA sesión: si no calza (ya pagada, otro monto), no se busca otra por hora.
      else { nuevosPend.push({ codigo: c.codigo, monto: c.monto, cuando: c.cuando, tarjeta: c.tarjeta, modo: c.modo, foreign: c.foreign ?? null }); continue; }
    }
    // 2) Presencial: por hora y monto. Se leen TODAS las sesiones del día (también las pagadas y las
    //    de otro monto): si otra cae en la misma ventana, hay duda y no se asocia sola.
    if (!elegida && esPresencial(c)) {
      const { data: delDia, error: eDia } = await supabase.from('bookings').select(COLS).eq('session_date', enHoraChile(c.cuando).fecha);
      if (eDia) throw new Error(eDia.message);
      elegida = sesionParaCobro(c, (delDia ?? []) as SesionCandidata[])?.id ?? null;
    }
    // Cobro no presencial que no vino de un link conocido: se espera 2 h antes de pedirle a Vale que lo
    // asocie (si la lectura del link falló una vez, la próxima pasada lo asocia solo).
    if (!elegida && !esPresencial(c) && Date.now() - Date.parse(c.cuando) < 2 * 3600_000) continue;
    if (elegida) {
      const r = await registrarPagoSumUp([elegida], c, 'auto', hastaMs);
      if (r.ok) { asociados++; continue; }
      if ((await codigosUsados([c.codigo])).size) continue;
    }
    nuevosPend.push({ codigo: c.codigo, monto: c.monto, cuando: c.cuando, tarjeta: c.tarjeta, modo: c.modo, foreign: c.foreign ?? null });
  }

  let total = 0;
  let avisar: string[] = [];
  const previos = estado.porAsociar.map((p) => p.codigo);
  // Los "por asociar" anteriores se conservan hasta que Vale los resuelva (salvo los ya usados).
  const usadosPrevios = await codigosUsados(previos);
  await cambiarEstado((fresco) => {
    const ign = new Set(fresco.ignorados);
    const lista = new Map<string, CobroSumUp>();
    for (const p of [...nuevosPend, ...fresco.porAsociar]) if (!ign.has(p.codigo) && !usadosPrevios.has(p.codigo) && !lista.has(p.codigo)) lista.set(p.codigo, p);
    avisar = [...lista.keys()].filter((k) => !previos.includes(k));
    total = lista.size;
    return { ...fresco, porAsociar: [...lista.values()].sort((a, b) => b.cuando.localeCompare(a.cuando)), revisadoEn: new Date().toISOString() };
  });
  if (Date.now() < hastaMs) await avisarReembolsos().catch((e) => console.error('[sumup] reembolsos:', (e as Error).message));
  if (avisar.length) await logWarn('sumup/por-asociar', avisar.length === 1 ? 'Hay 1 cobro de SumUp sin sesión asociada. Asócialo en Cobros.' : `Hay ${avisar.length} cobros de SumUp sin sesión asociada. Asócialos en Cobros.`, { codigos: avisar });
  return { asociados, porAsociar: total };
}

/** Revisiones del cron seguidas que fallaron (SumUp caído o la clave dejó de servir). A la 6.ª
 *  (media hora) Vale recibe UN aviso; al volver a funcionar, la cuenta vuelve a cero. */
export async function anotarRevisionSumUp(ok: boolean): Promise<void> {
  const { data } = await supabase.from('settings').select('value').eq('key', 'sumup_fallas').maybeSingle();
  const antes = Number(data?.value) || 0;
  const ahora = ok ? 0 : antes + 1;
  if (ahora === antes) return;
  await supabase.from('settings').upsert({ key: 'sumup_fallas', value: String(ahora), updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (ahora === 6) await logWarn('sumup/caida', 'La página no ha podido leer los cobros de SumUp en la última media hora. Los cobros con tarjeta se asocian solos cuando SumUp vuelva a responder.', {});
}

/** Sesiones para "Asociar a un paciente": pagadas o no (también las ya pagadas por otro medio, cuya
 *  boleta ya se emitió), de los últimos 60 días a los próximos 7. */
export async function sesionesParaAsociar(): Promise<any[]> {
  const hoy = Date.now();
  const desde = new Date(hoy - 60 * 86400_000).toISOString().slice(0, 10);
  const hasta = new Date(hoy + 7 * 86400_000).toISOString().slice(0, 10);
  const { data } = await supabase.from('bookings').select('id, patient_name, session_date, session_time, amount, paid_at, payment_note')
    .not('status', 'in', '(cancelled,expired,pending_payment)').or('debt_voided.is.null,debt_voided.eq.false')
    .gte('session_date', desde).lte('session_date', hasta).gt('amount', 0)
    .order('session_date', { ascending: false }).order('session_time', { ascending: false }).limit(400);
  return data ?? [];
}

const clpTxt = (n: number) => `$${Math.round(n).toLocaleString('es-CL')}`;

/**
 * "Asociar a un paciente" (Vale, 20 nov 2026): el cobro queda en esa sesión SIN emitir boleta ni
 * correos. Si el cobro es menor que la sesión, Vale escribe de dónde vino el resto (transferencia,
 * Encuadrado, efectivo…). Si la sesión estaba sin pagar, queda pagada (calendario en verde) con ese
 * detalle; si ya estaba pagada, solo se anota. Nunca se usa un payment_note que el barrido de
 * tareasEnvio.ts lea como pago con boleta (y no se toca mp_payment_id).
 */
export async function asociarSinBoleta(bookingId: string, cobro: CobroSumUp, origenResto: string): Promise<{ ok: boolean; error?: string; quedoPagada?: boolean }> {
  const { data: s, error: e1 } = await supabase.from('bookings').select(`${COLS}, payment_note`).eq('id', bookingId).maybeSingle();
  if (e1) return { ok: false, error: 'No se pudo leer la sesión. Intenta de nuevo en un minuto.' };
  if (!s) return { ok: false, error: 'No se encontró esa sesión.' };
  if (s.status === 'cancelled' || s.status === 'expired' || s.debt_voided === true) return { ok: false, error: 'Esa sesión está anulada, cancelada o vencida.' };
  // Reserva web que espera su pago: necesita la confirmación y los correos de siempre.
  if (s.status === 'pending_payment' && !s.paid_at) return { ok: false, error: 'Esa reserva web espera su pago: usa "Asociar y emitir boleta".' };
  const montoSesion = Number(s.amount) || 0;
  if (montoSesion <= 0) return { ok: false, error: 'Esa sesión no tiene monto.' };
  const resto = montoSesion - cobro.monto;
  if (resto < 0) return { ok: false, error: `El cobro (${clpTxt(cobro.monto)}) es mayor que la sesión (${clpTxt(montoSesion)}).` };
  const limpio = String(origenResto ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const origen = limpio.charAt(0).toUpperCase() + limpio.slice(1);
  if (resto > 0 && !origen) return { ok: false, error: `Faltan ${clpTxt(resto)}: escribe de dónde vino el resto.` };

  if ((await codigosUsados([cobro.codigo])).size || !(await reservarCodigo(cobro.codigo))) {
    return { ok: false, error: 'Ese cobro de SumUp ya está asociado.' };
  }
  if ((await codigosUsados([cobro.codigo])).size) {
    await liberarCobroSumUp(cobro.codigo);
    return { ok: false, error: 'Ese cobro de SumUp ya está asociado.' };
  }
  const detalle: AsociacionSinBoleta = {
    bookingId: s.id, patient_name: s.patient_name, session_date: s.session_date, session_time: String(s.session_time).slice(0, 5),
    monto: cobro.monto, resto, origenResto: resto > 0 ? origen : '', en: new Date().toISOString(),
  };
  const { error: eIns } = await supabase.from('settings').insert({ key: `${PREF_PACIENTE}${cobro.codigo}`, value: JSON.stringify(detalle), updated_at: new Date().toISOString() });
  await liberarCobroSumUp(cobro.codigo);
  if (eIns) {
    if (eIns.code === '23505') return { ok: false, error: 'Ese cobro de SumUp ya está asociado.' };
    console.error('[sumup] asociar sin boleta:', eIns.message);
    return { ok: false, error: 'No se pudo guardar. Intenta de nuevo en un minuto.' };
  }

  let quedoPagada = false;
  if (!s.paid_at) {
    const nota = (resto > 0 ? `Tarjeta (SumUp) + ${origen}` : 'Tarjeta (SumUp), sin boleta').slice(0, 150);
    const { data: up, error: eUp } = await supabase.from('bookings')
      .update({ status: 'confirmed', paid_at: new Date().toISOString(), payment_note: nota })
      .eq('id', s.id).is('paid_at', null).select('id');
    if (eUp) await logError('sumup/sin-boleta', `El cobro con tarjeta quedó asociado a ${s.patient_name}, pero la sesión no se pudo marcar pagada. Márcala a mano sin boleta.`, { bookingId: s.id, codigo: cobro.codigo, error: eUp.message });
    quedoPagada = !!up?.length;
    if (quedoPagada) {
      const futura = s.session_date !== '2099-12-31' && s.session_date >= todayCL();
      try {
        const { data: row } = await supabase.from('bookings').select('*').eq('id', s.id).maybeSingle();
        if (row && !row.google_event_id && row.session_date !== '2099-12-31') await syncBookingToCalendar(row, futura ? {} : { invite: false });
        await markBookingPaidInCalendar(s.id, true, { invitar: futura });
      } catch (e) { console.error('[sumup] calendario:', (e as Error).message); }
      await upsertPatientFromBooking({ patient_name: s.patient_name, patient_email: s.patient_email, patient_phone: s.patient_phone, rut: s.patient_rut }).catch(console.error);
    }
  }
  const hora = new Date(cobro.cuando).toLocaleString('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  await agregarLineaNotas(s.id, `Cobro con tarjeta SumUp ${cobro.codigo} de ${clpTxt(cobro.monto)} del ${hora}, asociado sin boleta${resto > 0 ? `. Resto (${clpTxt(resto)}): ${origen}` : ''}`);
  await quitarDePorAsociar(cobro.codigo).catch((e) => console.error('[sumup] quitar de la lista:', (e as Error).message));
  await logInfo('sumup/sin-boleta', `Cobro de SumUp ${clpTxt(cobro.monto)} asociado a ${s.patient_name} sin boleta`, { codigo: cobro.codigo, bookingId: s.id, resto, origenResto: detalle.origenResto });
  return { ok: true, quedoPagada };
}

/** "Anular pago", paso 1 (ANTES de quitar el pago): cobros asociados sin boleta a esa sesión; quedan
 *  marcados para no asociarse solos nunca más. Lanza error si no se pudo leer o marcar: el pago no se anula. */
export async function sinBoletaDeSesion(bookingId: string): Promise<string[]> {
  const { data, error } = await supabase.from('settings').select('key, value').like('key', comoPrefijo(PREF_PACIENTE)).limit(2000);
  if (error) throw new Error(error.message);
  const codigos: string[] = [];
  for (const r of data ?? []) {
    let v: any = {};
    try { v = JSON.parse(String(r.value ?? '{}')); } catch { continue; }
    const codigo = String(r.key).slice(PREF_PACIENTE.length);
    if (v.bookingId !== bookingId || !codigoValido(codigo)) continue;
    await marcar(PREF_MANUAL, codigo);
    codigos.push(codigo);
  }
  return codigos;
}

/** "Anular pago", paso 2 (pago ya quitado): el cobro deja de estar asociado y vuelve a "por asociar". */
export async function soltarSinBoleta(codigo: string): Promise<void> {
  if (!codigoValido(codigo)) return;
  const { error } = await supabase.from('settings').delete().eq('key', `${PREF_PACIENTE}${codigo}`);
  if (error) {
    await logError('sumup/anular', 'Anulaste el pago, pero el cobro con tarjeta quedó asociado a esa sesión y no volvió a Cobros. Pídele a Claude que lo libere.', { codigo, error: error.message });
    return;
  }
  await anularPagoSumUp(codigo);
}

/** "No es de una sesión" (Vale): el cobro deja de aparecer por asociar. */
export async function ignorarCobro(codigo: string): Promise<void> {
  await marcar(PREF_IGNORADO, codigo);
  await cambiarEstado((e) => ({ ...e, porAsociar: e.porAsociar.filter((p) => p.codigo !== codigo) }));
}

/** Quita de "por asociar" un cobro ya asociado a mano. */
export async function quitarDePorAsociar(codigo: string): Promise<void> {
  await cambiarEstado((e) => ({ ...e, porAsociar: e.porAsociar.filter((p) => p.codigo !== codigo) }));
}
