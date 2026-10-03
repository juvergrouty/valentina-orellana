import { createHash, randomBytes } from 'node:crypto';
import { supabase } from './supabase';
import { ADMIN_EMAIL_FALLBACK } from './email';

// Consentimiento informado de tratamiento de datos personales y de salud
// (Ley 21.719, que modifica la Ley 19.628). Pedido por Valentina el 3 oct
// 2026: un texto simple, que ella decide cuándo enviar (WhatsApp o correo),
// que queda guardado en la ficha y que dispara un aviso permanente en el
// admin mientras un paciente activo no lo haya firmado.
//
// Si se cambia el texto, subir CONSENT_VERSION: los ya firmados conservan el
// texto exacto que aceptaron (text_snapshot), así que nunca se reescribe la
// prueba de un consentimiento anterior.
export const CONSENT_VERSION = '2026-10-v1';

export const RESPONSABLE = {
  nombre: 'Valentina Orellana',
  profesion: 'Psicóloga',
  rut: '16.768.831-4',
};

export interface ConsentSection { titulo: string; parrafos: string[] }

export function consentSections(contactEmail: string): ConsentSection[] {
  return [
    {
      titulo: 'Quién trata tus datos',
      parrafos: [
        `${RESPONSABLE.nombre}, ${RESPONSABLE.profesion}, RUT ${RESPONSABLE.rut}, es la responsable de tus datos. Puedes escribirle por cualquier tema de tus datos a ${contactEmail}.`,
      ],
    },
    {
      titulo: 'Qué datos y para qué',
      parrafos: [
        'Tus datos de identificación y contacto, y los datos de salud que surgen de la terapia (motivo de consulta, notas clínicas y evolución). Los datos de salud son datos sensibles: por eso se te pide este consentimiento expreso.',
        'Se usan solo para tu atención psicológica, para llevar tu ficha clínica, agendar tus sesiones, cobrarlas y emitir tus boletas. Nunca se venden ni se usan para publicidad.',
      ],
    },
    {
      titulo: 'Quién más puede verlos',
      parrafos: [
        'Nadie fuera de la psicóloga, salvo los servicios tecnológicos que hacen funcionar la consulta y que solo pueden usar tus datos para eso: Encuadrado (plataforma clínica donde se transcriben y guardan las notas de sesión), almacenamiento de la ficha y del sitio web, correo, calendario y videollamada, pago en línea y emisión de boletas ante el SII. Algunos de estos servicios guardan la información en servidores fuera de Chile (principalmente en Estados Unidos), bajo contratos que los obligan a mantenerla segura y confidencial.',
        'La ley obliga a entregar información solo ante una orden judicial o en los demás casos que la ley establece.',
      ],
    },
    {
      titulo: 'Cuánto tiempo se guardan',
      parrafos: [
        'La ley obliga a conservar la ficha clínica por al menos 15 años desde la última anotación (Ley 20.584 y su reglamento), aunque hayas terminado la terapia. Después de ese plazo se elimina o se anonimiza. Los datos de pago y boletas se guardan el tiempo que exige la ley tributaria.',
      ],
    },
    {
      titulo: 'Tus derechos',
      parrafos: [
        'Puedes pedir en cualquier momento acceder a tus datos, corregirlos, eliminarlos, oponerte a un uso, pedir una copia para llevártela o que se bloqueen, escribiendo al correo de arriba. La eliminación tiene un límite: la ficha clínica debe conservarse el plazo legal.',
        'Puedes retirar este consentimiento cuando quieras, sin dar explicaciones. Retirarlo no afecta lo que ya se hizo antes, y retirar las autorizaciones 2 o 3 no cambia en nada tu atención.',
        'Si sientes que tus derechos no fueron respetados, puedes reclamar ante la Agencia de Protección de Datos Personales.',
      ],
    },
  ];
}

export interface ConsentOption { key: 'accept_treatment' | 'accept_recording' | 'accept_case_review'; titulo: string; texto: string; obligatoria: boolean }

export const CONSENT_OPTIONS: ConsentOption[] = [
  {
    key: 'accept_treatment',
    titulo: '1. Tratamiento de mis datos (necesaria para atenderte)',
    texto: 'Autorizo el tratamiento de mis datos personales y de salud para mi atención psicológica, en los términos descritos arriba.',
    obligatoria: true,
  },
  {
    key: 'accept_recording',
    titulo: '2. Grabación de sesiones (opcional)',
    texto: 'Autorizo que se grabe el audio de mis sesiones con el único fin de transcribirlo como notas clínicas de mi ficha, usando la plataforma clínica Encuadrado. La grabación y su transcripción forman parte de mi ficha, con la misma confidencialidad, y no se comparten con nadie. Puedo pedir que una sesión en particular no se grabe.',
    obligatoria: false,
  },
  {
    key: 'accept_case_review',
    titulo: '3. Revisión anónima de casos con otros psicólogos (opcional)',
    texto: 'Autorizo que mi caso, sin mi nombre, RUT ni ningún dato que permita reconocerme, se analice con otros psicólogos en un espacio de trabajo comunitario de casos complejos, con el fin de mejorar mi atención. Todos los participantes están sujetos al secreto profesional.',
    obligatoria: false,
  },
];

// Texto plano completo, tal como lo ve el paciente: es lo que se guarda como
// prueba (text_snapshot) junto con su hash.
export function consentPlainText(contactEmail: string): string {
  const s = consentSections(contactEmail).map(x => `${x.titulo}\n${x.parrafos.join('\n')}`).join('\n\n');
  const o = CONSENT_OPTIONS.map(x => `${x.titulo}\n${x.texto}`).join('\n\n');
  return `Consentimiento informado para el tratamiento de datos personales y de salud (versión ${CONSENT_VERSION})\n\n${s}\n\nAutorizaciones\n\n${o}`;
}

export const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

export async function consentContactEmail(): Promise<string> {
  const { data } = await supabase.from('settings').select('value').eq('key', 'notification_email').maybeSingle();
  return data?.value?.trim() || ADMIN_EMAIL_FALLBACK;
}

export function consentUrl(origin: string, token: string) {
  return `${origin.replace(/\/$/, '')}/consentimiento/${token}`;
}

// Link pendiente del paciente: reutiliza el último sin firmar (para que un
// link ya enviado siga sirviendo) o crea uno nuevo.
export async function getOrCreatePendingConsent(patientId: string): Promise<{ id: string; token: string }> {
  const { data: existing } = await supabase.from('consents')
    .select('id, token').eq('patient_id', patientId).is('signed_at', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (existing) return existing;
  const token = randomBytes(24).toString('base64url');
  const { data, error } = await supabase.from('consents')
    .insert({ patient_id: patientId, token, version: CONSENT_VERSION })
    .select('id, token').single();
  if (error || !data) throw new Error(error?.message ?? 'No se pudo crear el consentimiento.');
  return data;
}

export interface ConsentRow {
  id: string; patient_id: string | null; token: string; version: string;
  created_at: string; sent_at: string | null; sent_via: string | null;
  signed_at: string | null; signer_name: string | null; signer_rut: string | null;
  accept_treatment: boolean; accept_recording: boolean; accept_case_review: boolean;
  revoked_at: string | null; revoked_note: string | null;
}

// Consentimiento vigente = el último firmado, aceptando el tratamiento, y no
// revocado. Si el último firmado fue revocado, el paciente vuelve a quedar
// pendiente (hay que pedirle uno nuevo).
export function vigente(rows: ConsentRow[]): ConsentRow | null {
  const firmados = rows.filter(r => r.signed_at && r.accept_treatment)
    .sort((a, b) => (b.signed_at ?? '').localeCompare(a.signed_at ?? ''));
  const ultimo = firmados[0];
  return ultimo && !ultimo.revoked_at ? ultimo : null;
}

export interface ConsentAlert { patientId: string; name: string; sentAt: string | null }

// Pacientes activos sin consentimiento vigente — aviso permanente del admin.
export async function getConsentAlerts(): Promise<ConsentAlert[]> {
  const [{ data: patients, error: pErr }, { data: consents, error: cErr }] = await Promise.all([
    supabase.from('patients').select('id, name').eq('active', true).order('name'),
    supabase.from('consents').select('*').not('patient_id', 'is', null),
  ]);
  // Si la tabla aún no existe (migración sin correr) no avisar en falso a todos.
  if (pErr || cErr) return [];
  const porPaciente = new Map<string, ConsentRow[]>();
  for (const c of (consents ?? []) as ConsentRow[]) {
    const l = porPaciente.get(c.patient_id!) ?? [];
    l.push(c); porPaciente.set(c.patient_id!, l);
  }
  const alerts: ConsentAlert[] = [];
  for (const p of patients ?? []) {
    const rows = porPaciente.get(p.id) ?? [];
    if (vigente(rows)) continue;
    const enviado = rows.filter(r => !r.signed_at && r.sent_at).map(r => r.sent_at!).sort().pop() ?? null;
    alerts.push({ patientId: p.id, name: p.name, sentAt: enviado });
  }
  return alerts;
}

export function whatsappConsentMessage(firstName: string, url: string) {
  return `Hola ${firstName}, te comparto el consentimiento informado para el tratamiento de tus datos en la terapia, que pide la nueva ley de protección de datos. Son 2 minutos: lo lees, marcas lo que autorizas y firmas con tu nombre y RUT.\n\n${url}\n\nCualquier duda me escribes. Valentina`;
}
