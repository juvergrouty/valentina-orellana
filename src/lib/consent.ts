import { createHash, randomBytes } from 'node:crypto';
import { supabase } from './supabase';

// Consentimiento informado de tratamiento de datos personales y de salud
// (Ley 21.719, que modifica la Ley 19.628). Pedido por Valentina el 3 oct
// 2026: un texto simple, que ella decide cuándo enviar (WhatsApp o correo),
// que queda guardado en la ficha y que dispara un aviso permanente en el
// admin mientras un paciente activo no lo haya firmado.
//
// Si se cambia el texto, subir CONSENT_VERSION: los ya firmados conservan el
// texto exacto que aceptaron (text_snapshot), así que nunca se reescribe la
// prueba de un consentimiento anterior.
// v2 (12 oct 2026, pedido de Valentina): agrega "Sobre la atención psicológica"
// (proceso, reagendamiento, derivación, urgencias) y los límites del secreto
// profesional, para que el consentimiento también respalde la terapia.
// v3 (16 oct 2026, pedido de Valentina): versión amplia para pacientes nuevos.
// Sin nombres de proveedores en la autorización 2 (la lista vive en
// /condiciones#privacidad); agrega audio/transcripción, IA sin decisiones
// clínicas, borrado del audio y pareja. La v2 sigue vigente para quienes ya
// firmaron (decisión 9 del 16 oct): su texto queda en su text_snapshot.
export const CONSENT_VERSION = '2026-10-v3';

export const RESPONSABLE = {
  nombre: 'Valentina Orellana',
  profesion: 'Psicóloga',
  rut: '16.768.831-4',
  registro: '360070',
};

export interface ConsentSection { titulo: string; parrafos: string[] }

export function consentSections(contactEmail: string): ConsentSection[] {
  return [
    {
      titulo: 'Quién trata tus datos',
      parrafos: [
        `${RESPONSABLE.nombre}, ${RESPONSABLE.profesion}, RUT ${RESPONSABLE.rut}, N° de registro ${RESPONSABLE.registro} de la Superintendencia de Salud, es la responsable de tus datos. Puedes escribirle por cualquier tema de tus datos a ${contactEmail}.`,
      ],
    },
    {
      titulo: 'Sobre la atención psicológica',
      parrafos: [
        'La psicoterapia es un proceso colaborativo: sus resultados dependen de muchos factores y no pueden garantizarse. Es normal que en algunos momentos aparezcan emociones difíciles. Puedes terminar la terapia cuando quieras.',
        'Las sesiones duran 50 minutos. Puedes reagendar sin costo avisando con al menos 24 horas de anticipación; con menos de 24 horas de aviso, la sesión se considera realizada.',
        'Si la psicóloga considera que te ayudaría el apoyo de otro profesional (por ejemplo, psiquiatría u otra especialidad), te lo sugerirá. Y si la terapia no está siendo efectiva para ti, te propondrá una derivación a otro profesional calificado.',
        'Este espacio no atiende urgencias. Si estás en crisis o piensas en hacerte daño, llama al *4141 (gratis, 24/7), a Salud Responde 600 360 7777 o al SAMU 131, o acude al servicio de urgencia más cercano.',
      ],
    },
    {
      titulo: 'Qué datos y para qué',
      parrafos: [
        'Tus datos de identificación y contacto, y los datos de salud que surgen de la terapia (motivo de consulta, notas clínicas y evolución). Si autorizas la grabación (autorización 2), también el audio de tus sesiones y su transcripción escrita. Los datos de salud son datos sensibles: por eso se te pide este consentimiento expreso.',
        'Se usan solo para tu atención psicológica, para llevar tu ficha clínica, agendar tus sesiones, cobrarlas y emitir tus boletas. Nunca se venden ni se usan para publicidad.',
        'Algunas herramientas tecnológicas que uso, incluidas herramientas de inteligencia artificial, me ayudan a transcribir y ordenar la información de las sesiones. Ninguna herramienta toma decisiones sobre ti ni sobre tu tratamiento: no diagnostican ni evalúan tu riesgo, y no deciden derivaciones ni altas. Todas las decisiones clínicas las tomo yo, como psicóloga responsable. Tus datos nunca se usan para entrenar sistemas de inteligencia artificial, ni para investigación, docencia o publicidad.',
      ],
    },
    {
      titulo: 'Quién más puede verlos',
      parrafos: [
        'Nadie fuera de la psicóloga, salvo los servicios tecnológicos que hacen funcionar la consulta, que actúan por encargo mío y solo pueden usar tus datos para eso: almacenamiento de la ficha clínica y del sitio web, herramientas de transcripción y de apoyo para las notas clínicas (incluida inteligencia artificial), correo, calendario y videollamada, pago en línea y emisión de boletas ante el SII. Algunos de estos servicios procesan o guardan la información en servidores fuera de Chile (principalmente en Estados Unidos), bajo contratos que los obligan a mantenerla segura y confidencial. La lista actualizada de estos servicios y de los países donde operan está en la política de privacidad (valentinaorellana.cl/condiciones#privacidad), y puedes pedírmela cuando quieras.',
        'Todo lo que conversas en terapia está protegido por el secreto profesional. Las únicas excepciones son un riesgo grave para tu vida o la de otras personas, la vulneración de derechos de niños, niñas o adolescentes, y una orden judicial o los demás casos que la ley establece. En esos casos se comparte solo lo estrictamente necesario y, cuando sea posible, se te avisa antes.',
      ],
    },
    {
      titulo: 'Cuánto tiempo se guardan',
      parrafos: [
        'La ley obliga a conservar la ficha clínica por al menos 15 años desde la última anotación (Ley 20.584 y su reglamento), aunque hayas terminado la terapia. Después de ese plazo se elimina o se anonimiza. Los datos de pago y boletas se guardan el tiempo que exige la ley tributaria.',
        'Si autorizas la grabación, el audio se borra apenas se transcribe: no guardo grabaciones de audio. La transcripción y las notas que se elaboran a partir de ella se guardan cifradas como parte de tu ficha clínica, por el mismo plazo legal. Los servicios que procesan el audio o el texto solo pueden guardar copias temporales por el tiempo limitado que fijan sus contratos, que está indicado en la política de privacidad.',
      ],
    },
    {
      titulo: 'Tus derechos',
      parrafos: [
        'Puedes pedir en cualquier momento acceder a tus datos, corregirlos, eliminarlos, oponerte a un uso, pedir una copia para llevártela o que se bloqueen, escribiendo al correo de arriba. La eliminación tiene un límite: la ficha clínica debe conservarse el plazo legal.',
        'Puedes retirar este consentimiento cuando quieras, sin dar explicaciones. Retirarlo no afecta lo que ya se hizo antes, y retirar las autorizaciones 2 o 3 no cambia en nada tu atención. Puedes retirar la autorización de grabación por el mismo link de este consentimiento, por correo o por WhatsApp. Desde ese momento dejo de grabar, y lo ya transcrito queda en tu ficha con la misma confidencialidad.',
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
    texto: 'Declaro haber leído la información sobre la atención psicológica y autorizo el tratamiento de mis datos personales y de salud para mi atención, en los términos descritos arriba.',
    obligatoria: true,
  },
  {
    key: 'accept_recording',
    titulo: '2. Grabación de sesiones (opcional)',
    texto: 'Autorizo que se grabe el audio de mis sesiones para transcribirlo y procesarlo con herramientas tecnológicas de transcripción y de apoyo, incluida la inteligencia artificial, con el único fin de elaborar las notas clínicas de mi ficha y preparar mi atención. Sé que este procesamiento lo hacen proveedores que actúan por encargo de la psicóloga, algunos de ellos fuera de Chile (principalmente en Estados Unidos). También sé que el audio se borra después de transcribirse, que la transcripción se conserva como parte de mi ficha con la misma confidencialidad y que ninguna herramienta toma decisiones clínicas. Es voluntario: si no lo autorizo, me atienden igual. Puedo pedir que una sesión o un momento de la sesión no se grabe, y puedo retirar esta autorización cuando quiera. En sesiones de pareja, cada persona firma su propio consentimiento, y solo se graba si todas las personas presentes lo autorizaron.',
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
  return `Consentimiento informado para la atención psicológica y el tratamiento de datos personales y de salud (versión ${CONSENT_VERSION})\n\n${s}\n\nAutorizaciones\n\n${o}`;
}

export const sha256 = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

// Correo público de contacto para temas de datos (mismo que /condiciones).
// No usa `notification_email`: ese es el buzón interno de avisos a Valentina.
// Las firmas antiguas no se ven afectadas: su integridad se verifica contra
// el text_snapshot guardado, no contra el texto actual.
export async function consentContactEmail(): Promise<string> {
  return 'consulta@valentinaorellana.cl';
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
