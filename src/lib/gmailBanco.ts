// Transferencias: la boleta sale cuando el correo del banco confirma el dinero (22 nov 2026).
//
// Vale: "la boleta no se genera hasta que la foto esté arriba" y después "se revisa mi correo
// buscando la notificación del banco que coincida (monto, nombre y fecha)". Así:
//   1. La paciente sube el comprobante → la sesión queda pagada y recibe todo al instante
//      (como siempre, comprobante-transferencia.ts), pero con la marca BoletaEsperaBanco:
//      la tarea "boleta" no emite mientras la marca esté (tareasEnvio.ts).
//   2. Cada 5 min (cron boletas-pendientes) se busca en el Gmail de Vale, con permiso de SOLO
//      LECTURA (gmail.readonly, conexión aparte de la de Calendar), un correo con el monto exacto
//      entre 2 días antes y 3 días después del comprobante, que parezca aviso de transferencia.
//      - Monto + nombre (de la paciente o del titular que escribió) → BancoConfirmado, se marca
//        revisada la tarea del Inicio y se emite la boleta.
//      - Monto sin nombre → BancoDudoso: el Inicio le muestra el caso a Vale; ella decide.
//      - Nada en 48 h → BancoNoEncontrado: el Inicio le avisa; la boleta NO se emite.
//   3. Sin Gmail conectado, todo queda en la tarea del Inicio «Revisar en tu banco…»: al apretar
//      «Ya la revisé» se emite la boleta (transferencia-revisada.ts).
// El texto de los correos nunca se guarda: solo el id del mensaje que calzó.
import { supabase } from './supabase';
import { refreshAccessToken } from './googleCalendar';
import { logError, logInfo, logWarn } from './logger';
import { agregarLineaNotas } from './apigateway';
import { MARCA_TRANSFERENCIA_POR_REVISAR, MARCA_TRANSFERENCIA_REVISADA } from './comprobantes';
import {
  MARCA_ESPERA_BANCO, MARCA_BANCO_OK, MARCA_BANCO_DUDOSO, MARCA_BANCO_NO, MARCA_TITULAR, PLAZO_BANCO_MS,
  compararCorreo, consultaGmail, textoDeMensaje, remitenteDe, remitenteDelBanco,
} from './gmailBancoUtil';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const CLAVES_GMAIL = ['gmail_access_token', 'gmail_refresh_token', 'gmail_token_expiry', 'gmail_user_email'] as const;
export const CLAVE_REMITENTE = 'gmail_banco_remitente';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export async function gmailConectado(): Promise<{ conectado: boolean; correo: string | null }> {
  const { data } = await supabase.from('settings').select('key, value').in('key', ['gmail_refresh_token', 'gmail_user_email']);
  const m = Object.fromEntries((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
  return { conectado: !!m['gmail_refresh_token'], correo: m['gmail_user_email'] || null };
}

async function tokenGmail(): Promise<string | null> {
  const { data } = await supabase.from('settings').select('key, value').in('key', [...CLAVES_GMAIL]);
  const m = Object.fromEntries((data ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));
  if (!m['gmail_refresh_token']) return null;
  if (m['gmail_access_token'] && Date.now() < Number(m['gmail_token_expiry'] ?? 0) - 60_000) return m['gmail_access_token'];
  const r = await refreshAccessToken(m['gmail_refresh_token']);
  const ahora = new Date().toISOString();
  await supabase.from('settings').upsert([
    { key: 'gmail_access_token', value: r.access_token, updated_at: ahora },
    { key: 'gmail_token_expiry', value: String(Date.now() + r.expires_in * 1000), updated_at: ahora },
  ], { onConflict: 'key' });
  return r.access_token;
}

async function gmail<T>(token: string, ruta: string): Promise<T> {
  const r = await fetch(`${API}${ruta}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Gmail ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<T>;
}

/** Busca el correo del banco. 'ok' + id, 'dudoso' + id, o 'no'. */
export async function buscarCorreoBanco(token: string, o: { monto: number; subidoMs: number; nombres: string[]; remitente?: string | null; excluir: string[] }): Promise<{ resultado: 'ok' | 'dudoso' | 'no'; id?: string }> {
  const q = encodeURIComponent(consultaGmail(o.monto, o.subidoMs, o.remitente));
  const lista = await gmail<{ messages?: { id: string }[] }>(token, `/messages?q=${q}&maxResults=15`);
  let dudoso: string | undefined;
  for (const { id } of lista.messages ?? []) {
    const msg = await gmail<{ snippet?: string; payload?: any }>(token, `/messages/${encodeURIComponent(id)}?format=full`);
    const de = remitenteDe(msg).toLowerCase();
    // Ni la paciente ni el propio sitio pueden "confirmar" su transferencia con un correo.
    if (o.excluir.some((x) => x && de.includes(x))) continue;
    const r = compararCorreo(textoDeMensaje(msg), o.monto, o.nombres, remitenteDelBanco(de, o.remitente));
    if (r === 'ok') return { resultado: 'ok', id };
    if (r === 'dudoso' && !dudoso) dudoso = id;
  }
  return dudoso ? { resultado: 'dudoso', id: dudoso } : { resultado: 'no' };
}

type Fila = { id: string; patient_name: string; patient_email: string | null; amount: number; notes: string | null; paid_at: string | null; status: string };
const marca = (n: string | null, m: string) => new RegExp(`^${m}(?: (\\S+))?(?: (.*))?$`, 'm').exec(n ?? '');

/** Transferencias que esperan el correo del banco, agrupadas por comprobante (una transferencia puede pagar varias sesiones). */
export async function transferenciasEsperandoBanco(): Promise<{ path: string; subidoEl: string; ids: string[]; correos: string[]; total: number; paciente: string; titular: string | null; estado: 'buscando' | 'dudoso' | 'no' }[]> {
  const { data, error } = await supabase.from('bookings')
    .select('id, patient_name, patient_email, amount, notes, paid_at, status')
    .ilike('notes', `%${MARCA_ESPERA_BANCO}%`).not('paid_at', 'is', null)
    .not('status', 'in', '(cancelled,expired)').limit(100);
  if (error) throw new Error(error.message);
  const grupos = new Map<string, { path: string; subidoEl: string; ids: string[]; correos: string[]; total: number; paciente: string; titular: string | null; estado: 'buscando' | 'dudoso' | 'no' }>();
  for (const b of (data ?? []) as Fila[]) {
    if (marca(b.notes, MARCA_BANCO_OK) || marca(b.notes, MARCA_TRANSFERENCIA_REVISADA)) continue;
    const m = new RegExp(`^${MARCA_TRANSFERENCIA_POR_REVISAR} (\\S+) (\\S+)`, 'm').exec(b.notes ?? '');
    if (!m) continue;
    const g = grupos.get(m[2]) ?? { path: m[2], subidoEl: m[1], ids: [], correos: [], total: 0, paciente: b.patient_name, titular: marca(b.notes, MARCA_TITULAR)?.[1] ? `${marca(b.notes, MARCA_TITULAR)![1]} ${marca(b.notes, MARCA_TITULAR)![2] ?? ''}`.trim() : null, estado: 'buscando' as const };
    g.ids.push(b.id);
    if (b.patient_email) g.correos.push(b.patient_email.toLowerCase());
    g.total += b.amount ?? 0;
    if (marca(b.notes, MARCA_BANCO_NO)) g.estado = 'no';
    else if (marca(b.notes, MARCA_BANCO_DUDOSO) && g.estado === 'buscando') g.estado = 'dudoso';
    grupos.set(m[2], g);
  }
  return [...grupos.values()];
}

/**
 * Cron: revisa el Gmail de Vale para las transferencias que esperan el correo del banco.
 * `emitirBoleta` lo pasa el cron (evita importar tareasEnvio aquí y un ciclo de imports).
 */
export async function revisarTransferenciasEnBanco(emitirBoleta: (ids: string[], motivo: string) => Promise<void>, hastaMs = Date.now() + 25_000): Promise<{ revisadas: number; confirmadas: number }> {
  let grupos: Awaited<ReturnType<typeof transferenciasEsperandoBanco>>;
  try { grupos = await transferenciasEsperandoBanco(); } catch { return { revisadas: 0, confirmadas: 0 }; }
  // 'dudoso' se sigue buscando hasta el plazo: el correo correcto puede llegar después.
  const pendientes = grupos.filter((g) => g.estado === 'buscando' || g.estado === 'dudoso');
  if (!pendientes.length) return { revisadas: 0, confirmadas: 0 };
  let token: string | null = null;
  try { token = await tokenGmail(); }
  catch (e) {
    await logError('transferencia/gmail', 'No se pudo entrar al Gmail para revisar transferencias. Reconéctalo en Configuración.', { error: e instanceof Error ? e.message : String(e) });
    return { revisadas: 0, confirmadas: 0 };
  }
  if (!token) return { revisadas: 0, confirmadas: 0 }; // sin Gmail: Vale lo revisa con «Ya la revisé»
  const { data: cfgRows } = await supabase.from('settings').select('key, value').in('key', [CLAVE_REMITENTE, 'email_from', 'notification_email']);
  const cfg = Object.fromEntries((cfgRows ?? []).map((r: { key: string; value: string }) => [r.key, (r.value ?? '').toLowerCase()]));
  const sitio = ['valentinaorellana.cl', cfg['email_from'] ?? ''].filter(Boolean);

  let revisadas = 0, confirmadas = 0;
  for (const g of pendientes) {
    if (Date.now() > hastaMs) break;
    revisadas++;
    const subidoMs = Date.parse(g.subidoEl);
    let r: { resultado: 'ok' | 'dudoso' | 'no'; id?: string };
    try {
      r = await buscarCorreoBanco(token, { monto: g.total, subidoMs, nombres: [g.paciente, ...(g.titular ? [g.titular] : [])], remitente: cfg[CLAVE_REMITENTE], excluir: [...sitio, ...g.correos] });
    } catch (e) {
      console.error('[gmailBanco] búsqueda:', (e as Error).message);
      // Gmail falla (permiso vencido, sin acceso): pasado el plazo se avisa igual, nunca "buscando" para siempre.
      if (Date.now() - subidoMs > PLAZO_BANCO_MS) {
        const iso = new Date().toISOString();
        for (const id of g.ids) await agregarLineaNotas(id, `${MARCA_BANCO_NO} ${iso}`);
        await logError('transferencia/gmail', `No pude revisar tu correo por la transferencia de ${g.paciente} (reconecta Gmail en Configuración). La boleta no se emitió: revísala tú.`, { ids: g.ids, error: (e as Error).message });
      }
      continue;
    }
    const iso = new Date().toISOString();
    if (r.resultado === 'ok') {
      for (const id of g.ids) {
        await agregarLineaNotas(id, `${MARCA_BANCO_OK} ${iso} ${r.id}`);
        await agregarLineaNotas(id, `${MARCA_TRANSFERENCIA_REVISADA} ${iso}`);
      }
      await logInfo('transferencia/banco', `Encontré en tu correo el aviso del banco por la transferencia de ${g.paciente}: se emite la boleta`, { ids: g.ids, total: g.total });
      await emitirBoleta(g.ids, `banco-${Date.parse(iso)}`);
      confirmadas++;
    } else if (r.resultado === 'dudoso' && g.estado !== 'dudoso') {
      for (const id of g.ids) await agregarLineaNotas(id, `${MARCA_BANCO_DUDOSO} ${iso} ${r.id}`);
      await logWarn('transferencia/banco', `Hay un correo del banco por el monto de la transferencia de ${g.paciente}, pero con otro nombre. Revísalo en el Inicio.`, { ids: g.ids, total: g.total });
    } else if (Date.now() - subidoMs > PLAZO_BANCO_MS) {
      for (const id of g.ids) await agregarLineaNotas(id, `${MARCA_BANCO_NO} ${iso}`);
      await logWarn('transferencia/banco', `No encontré en tu correo el aviso del banco por la transferencia de ${g.paciente}. La boleta no se emitió.`, { ids: g.ids, total: g.total });
    }
  }
  return { revisadas, confirmadas };
}
