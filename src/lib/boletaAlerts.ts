import { supabase } from './supabase';
import { folioVigente, mensajeErrorSii, MARCA_PENDIENTE, MARCA_PENDIENTE_EMISION, MARCA_EMITIENDO, EMISION_CANDADO_MS } from './apigateway';

// Aviso rojo de boletas en todas las páginas del admin — a pedido de
// Valentina (3 oct 2026): si el envío o la emisión automática de una boleta
// falla, quiere verlo apenas abra el panel, con el error. A diferencia del
// aviso genérico de errores, este NO se apaga al abrir /admin/logs: sigue
// visible mientras el problema exista, y desaparece solo cuando la boleta se
// emite o se envía.

export interface BoletaAlert {
  bookingId:   string;
  patientName: string;
  sessionDate: string | null;
  message:     string;
  href:        string;
  registrarFolio?: { sugerido: number | null }; // ofrecer "Registrar folio" (boleta posiblemente emitida sin registrar)
}

// Contextos de log que significan "la boleta no se emitió".
const CTX_EMISION = ['boleta/emision', 'flow/boleta-automatica', 'boleta/confirmar-manual', 'boleta/marcar-pagado', 'boleta/folio-no-guardado'];
// Contextos que significan "se emitió pero no se envió".
const CTX_ENVIO = ['boleta/envio'];

const DIAS = 14;

function ultimoEnvio(notes: string | null): number {
  const marcas = [...(notes ?? '').matchAll(/BoletaEmailEnviada (\S+)/g)].map(m => Date.parse(m[1])).filter(t => !isNaN(t));
  return marcas.length ? Math.max(...marcas) : 0;
}

export async function getBoletaAlerts(): Promise<BoletaAlert[]> {
  const desde = new Date(Date.now() - DIAS * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: logs }, { data: pendientes }] = await Promise.all([
    supabase.from('admin_logs')
      .select('context, message, data, created_at')
      .in('context', [...CTX_EMISION, ...CTX_ENVIO])
      .in('level', ['warn', 'error'])
      .gt('created_at', desde)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase.from('bookings').select('id')
      .or(`notes.ilike.%${MARCA_PENDIENTE}%,notes.ilike.%${MARCA_PENDIENTE_EMISION}%,notes.ilike.%${MARCA_EMITIENDO}%`).limit(50),
  ]);

  // Último fallo registrado por reserva (los logs vienen del más nuevo al más viejo).
  const fallo = new Map<string, { tipo: 'emision' | 'envio'; error: string; at: number; ctx: string; folio: number | null }>();
  for (const l of logs ?? []) {
    const d = (l.data ?? {}) as Record<string, unknown>;
    const id = typeof d.bookingId === 'string' ? d.bookingId : null;
    if (!id || fallo.has(id)) continue;
    const error = typeof d.error === 'string' && d.error ? d.error : l.message;
    const folio = typeof d.folio === 'number' ? d.folio : (typeof d.folio === 'string' && /^\d+$/.test(d.folio) ? parseInt(d.folio, 10) : null);
    fallo.set(id, { tipo: CTX_ENVIO.includes(l.context) ? 'envio' : 'emision', error, at: Date.parse(l.created_at), ctx: l.context, folio });
  }

  const ids = [...new Set([...fallo.keys(), ...(pendientes ?? []).map(p => p.id)])];
  if (!ids.length) return [];

  const { data: bookings } = await supabase
    .from('bookings').select('id, patient_name, patient_email, session_date, status, notes').in('id', ids);
  const emails = [...new Set((bookings ?? []).map(b => b.patient_email).filter(Boolean))];
  const { data: patients } = emails.length
    ? await supabase.from('patients').select('id, email').in('email', emails)
    : { data: [] as { id: string; email: string }[] };
  const fichaDe = new Map((patients ?? []).map(p => [String(p.email).toLowerCase(), p.id]));

  const alerts: BoletaAlert[] = [];
  for (const b of bookings ?? []) {
    if (b.status === 'cancelled' || b.status === 'expired') continue;
    const vigente = folioVigente(b.notes);
    const f = fallo.get(b.id);
    let message: string | null = null;

    const emitiendo = new RegExp(`${MARCA_EMITIENDO} (\\S+)`).exec(b.notes ?? '');
    const pendEm = new RegExp(`${MARCA_PENDIENTE_EMISION} (\\S+)`).exec(b.notes ?? '');

    let registrarFolio: BoletaAlert['registrarFolio'];
    if (!vigente && f?.ctx === 'boleta/folio-no-guardado') {
      message = `La boleta Folio ${f.folio ?? '?'} SÍ se emitió en el SII, pero no quedó registrada en la sesión. No la emitas de nuevo: usa "Registrar folio".`;
      registrarFolio = { sugerido: f.folio };
    } else if (!vigente && emitiendo && Date.now() - Date.parse(emitiendo[1]) > EMISION_CANDADO_MS) {
      message = 'La emisión de la boleta se interrumpió. Revisa en el SII si quedó emitida: si está, usa "Registrar folio"; si no, emítela desde el calendario (te pedirá confirmar).';
      registrarFolio = { sugerido: null };
    } else if (!vigente && pendEm) {
      const dias = (Date.now() - Date.parse(pendEm[1])) / 86400000;
      message = dias > 7
        ? `Boleta NO emitida: el SII no respondió durante 7 días. Emítela a mano desde el calendario.`
        : `Boleta pendiente: el SII no respondió${f ? ` (${mensajeErrorSii(f.error)})` : ''}. Se reintenta sola automáticamente.`;
    } else if (b.notes?.includes(MARCA_PENDIENTE) && vigente) {
      message = `Boleta Folio ${vigente.folio} emitida pero NO enviada al paciente${f ? `: ${mensajeErrorSii(f.error)}` : '.'} Se reintenta sola.`;
    } else if (f?.tipo === 'emision' && !vigente) {
      message = `Boleta NO emitida: ${mensajeErrorSii(f.error)}`;
    } else if (f?.tipo === 'envio' && vigente && ultimoEnvio(b.notes) < f.at) {
      message = `Boleta Folio ${vigente.folio} emitida pero NO enviada: ${mensajeErrorSii(f.error)}`;
    }
    if (!message) continue;

    const ficha = b.patient_email ? fichaDe.get(String(b.patient_email).toLowerCase()) : undefined;
    alerts.push({
      bookingId:   b.id,
      patientName: b.patient_name ?? '(sin nombre)',
      sessionDate: b.session_date ?? null,
      message,
      registrarFolio,
      href: ficha ? `/admin/pacientes/${ficha}?tab=sesiones` : '/admin/logs?filtro=error',
    });
  }
  return alerts.sort((a, b) => (b.sessionDate ?? '').localeCompare(a.sessionDate ?? ''));
}
