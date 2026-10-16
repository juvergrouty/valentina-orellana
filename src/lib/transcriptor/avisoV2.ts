// Transcriptor IA — aviso único a pacientes con consentimiento v2 (decisión 13 de 01-decisiones-16oct;
// 81-revision-etica-clinica H4; texto de 12-consentimiento-nuevo.md §c adaptado a "cambié de herramienta").
//   • Se muestra UNA sola vez por firma, escrito abajo en el correo de confirmación de su siguiente hora.
//   • Solo si transcriptor_activo = 'true' (el transcriptor está en uso).
//   • Solo a firmas cuya ÚLTIMA versión por persona es la v2, con accept_recording = true, sin revocar
//     y sin retiro de la grabación. Las v3 ya describen el sistema nuevo: no lo necesitan.
//   • Queda constancia en consent_avisos (0019: consent_id único, canal, texto_version, fecha).
// Nunca rompe el correo de confirmación: cualquier error → sin aviso (se intenta en el próximo correo).
import type { SupabaseClient } from '@supabase/supabase-js';
import { identidadFirmante, numeroVersion, transcriptorActivo, type FilaConsentimiento } from './consentimiento';

export const TEXTO_AVISO_V2_VERSION = 'aviso-v2-2026-10-16';

/** Texto (12-consentimiento-nuevo §c, adaptado por 81-revision H4). Sin nombres: va en un correo ya personalizado. */
export const TEXTO_AVISO_V2 = [
  'Un cambio en cómo llevo las notas de nuestras sesiones: cuando firmaste el consentimiento autorizaste que grabara el audio para transcribirlo como notas de tu ficha. Eso sigue igual. Lo que cambió es la herramienta: ya no uso Encuadrado, sino un sistema propio de mi sitio que transcribe el audio con apoyo de herramientas tecnológicas, incluida inteligencia artificial, algunas de ellas fuera de Chile (principalmente en Estados Unidos), por encargo mío y con contratos de confidencialidad.',
  'El audio se borra apenas se transcribe, la transcripción queda cifrada en tu ficha y ninguna herramienta toma decisiones sobre tu tratamiento.',
  'No tienes que firmar nada. Si prefieres que no grabe, respóndeme por aquí o por WhatsApp y desde ese momento tomo notas a mano; nada cambia en tu atención. La lista de servicios está en valentinaorellana.cl/condiciones#privacidad.',
] as const;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Bloque HTML del correo (mismo estilo sobrio que el resto de la confirmación). */
export function htmlAvisoV2(): string {
  const parrafos = TEXTO_AVISO_V2.map((p) => esc(p).replace('valentinaorellana.cl/condiciones#privacidad',
    '<a href="https://www.valentinaorellana.cl/condiciones#privacidad" style="color:#576352;">valentinaorellana.cl/condiciones#privacidad</a>'));
  return `
        <div style="border-top:1px solid #DDD8CF;margin-top:2rem;padding-top:1.25rem;">
          <p style="font-family:'Inter',sans-serif;font-size:0.8rem;font-weight:600;color:#1A1A18;margin:0 0 0.6rem;">Sobre las notas de tus sesiones</p>
          ${parrafos.map((p) => `<p style="font-family:'Inter',sans-serif;font-size:0.8rem;color:#6B6860;line-height:1.6;margin:0 0 0.6rem;">${p}</p>`).join('\n          ')}
        </div>`;
}

type Fila = FilaConsentimiento & { patient_id?: string | null };

/** Firmas que deben recibir el aviso (función pura, con pruebas). */
export function firmasParaAviso(filas: Fila[], yaAvisadas: ReadonlySet<string>): Fila[] {
  const ultimas = new Map<string, Fila>();
  for (const f of filas) {
    if (!f.signed_at) continue;
    const k = identidadFirmante(f);
    const prev = ultimas.get(k);
    if (!prev || String(f.signed_at) > String(prev.signed_at)) ultimas.set(k, f);
  }
  return [...ultimas.values()].filter((f) =>
    numeroVersion(f.version) === 2 && f.accept_recording === true && !f.revoked_at && !f.recording_revoked_at && !yaAvisadas.has(f.id));
}

export interface AvisoPendiente { patientId: string; consentIds: string[]; html: string }

async function db(cliente?: SupabaseClient): Promise<SupabaseClient> {
  return cliente ?? (await import('../supabase')).supabase;
}

/** ¿Corresponde el aviso en la confirmación que va a este correo? null si no (o si algo falla). */
export async function avisoV2ParaCorreo(email: string, cliente?: SupabaseClient): Promise<AvisoPendiente | null> {
  try {
    const correo = String(email ?? '').trim();
    if (!correo.includes('@')) return null;
    const c = await db(cliente);
    if (!(await transcriptorActivo(c))) return null;
    const { data: ps, error: ep } = await c.from('patients').select('id')
      .ilike('email', correo.replace(/[\\%_]/g, (m) => `\\${m}`)).limit(2);
    if (ep || !ps || ps.length !== 1) return null; // sin ficha o ambiguo: no se arriesga
    const patientId = (ps[0] as { id: string }).id;
    const { data: filas, error: ec } = await c.from('consents')
      .select('id, patient_id, version, signed_at, signer_name, signer_rut, signer_email, accept_recording, revoked_at, recording_revoked_at')
      .eq('patient_id', patientId);
    if (ec || !filas?.length) return null;
    const ids = (filas as Fila[]).map((f) => f.id);
    const { data: avisos, error: ea } = await c.from('consent_avisos').select('consent_id').in('consent_id', ids);
    if (ea) return null; // sin tabla (0019) o error: sin aviso
    const ya = new Set(((avisos ?? []) as { consent_id: string }[]).map((a) => a.consent_id));
    const pendientes = firmasParaAviso(filas as Fila[], ya);
    if (!pendientes.length) return null;
    return { patientId, consentIds: pendientes.map((f) => f.id), html: htmlAvisoV2() };
  } catch {
    return null;
  }
}

/** Constancia de que se mostró (después de que el correo salió). Idempotente por consent_id. */
export async function registrarAvisoMostrado(a: AvisoPendiente, bookingId: string | null | undefined, cliente?: SupabaseClient): Promise<number> {
  try {
    const c = await db(cliente);
    let n = 0;
    for (const consentId of a.consentIds) {
      const { error } = await c.from('consent_avisos').insert({
        consent_id: consentId, patient_id: a.patientId, booking_id: bookingId ?? null, canal: 'correo', texto_version: TEXTO_AVISO_V2_VERSION,
      });
      if (!error) n++;
      else if (error.code !== '23505') console.warn('[transcriptor/avisoV2] no se pudo registrar el aviso:', error.code);
    }
    return n;
  } catch {
    return 0;
  }
}
