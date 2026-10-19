import { createHash, randomBytes } from 'node:crypto';
import { supabase } from './supabase';
import { FaltaMigracion0021, pendienteOCrear, personaDe } from './transcriptor/pareja';
import { vigentePropio } from './transcriptor/estadoConsentimiento';
import { tieneSesionVigente } from './transcriptor/etiquetaConsentimiento';

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
// firmaron (decisión 9 del 16 oct; desde el 19 oct, decisión de Vale, también la v1 con grabación
// autorizada habilita grabar): su texto queda en su text_snapshot.
// v4 (17 oct 2026, aprobada por Valentina): versión corta por capas
// (docs/transcriptor/14-consentimiento-corto.md). La capa 1 es este texto; el
// detalle (proveedores con país, plazos de copias temporales, derechos uno por
// uno, grabación y pareja) vive en /condiciones#privacidad (versión 5). La v2 y
// la v3 (y la v1, decisión de Vale del 19 oct) siguen vigentes para quienes ya
// firmaron: su texto queda en su text_snapshot, y con accept_recording = true
// siguen habilitando grabar.
export const CONSENT_VERSION = '2026-10-v4';

export const RESPONSABLE = {
  nombre: 'Valentina Orellana',
  profesion: 'Psicóloga',
  rut: '16.768.831-4',
  registro: '360070',
};

// WhatsApp de contacto (el mismo de /condiciones#privacidad). Va fijo en el
// texto porque consentSections solo recibe el correo.
export const CONSENT_WHATSAPP = '+56 9 7273 5696';

export interface ConsentSection { titulo: string; parrafos: string[] }

export function consentSections(contactEmail: string): ConsentSection[] {
  return [
    {
      titulo: 'Quién trata tus datos',
      parrafos: [
        `${RESPONSABLE.nombre}, psicóloga (RUT ${RESPONSABLE.rut}, registro N° ${RESPONSABLE.registro} de la Superintendencia de Salud), es la responsable de tus datos. Contacto: ${contactEmail} o WhatsApp ${CONSENT_WHATSAPP}.`,
      ],
    },
    {
      titulo: 'Sobre la atención psicológica',
      parrafos: [
        'La terapia es un proceso colaborativo: no garantiza resultados, puede traer emociones difíciles y puedes dejarla cuando quieras. Las sesiones duran 50 minutos; reagendar es gratis avisando con 24 horas; con menos aviso, la sesión se considera realizada. Si otro profesional te ayudaría o la terapia no te sirve, te propondré una derivación.',
        'Este espacio no atiende urgencias. En crisis, llama al *4141 (gratis, 24/7), a Salud Responde 600 360 7777 o al SAMU 131, o ve a urgencias.',
      ],
    },
    {
      titulo: 'Tus datos y para qué',
      parrafos: [
        'Trato tus datos de contacto y de salud (y, si lo autorizas, el audio de las sesiones y su transcripción) solo para atenderte: ficha clínica, agenda, cobros y boletas. Por ser datos sensibles, te pido este consentimiento expreso. Uso herramientas tecnológicas, incluida inteligencia artificial (IA), para transcribir y ordenar la información, pero ninguna decide nada sobre ti: las decisiones clínicas las tomo yo. Nunca se venden ni se usan para publicidad, investigación, docencia o entrenar IA.',
      ],
    },
    {
      titulo: 'Quién más puede verlos',
      parrafos: [
        'Solo yo. Los servicios que hacen funcionar la consulta (ficha, transcripción, correo, videollamada, pagos, boletas) actúan por encargo mío, con contrato de confidencialidad; algunos operan fuera de Chile, principalmente en Estados Unidos.',
        'El secreto profesional solo se levanta ante riesgo grave para tu vida o la de otros, vulneración de derechos de niños, niñas o adolescentes, u orden judicial u otro caso legal, y solo en lo necesario, avisándote si es posible.',
      ],
    },
    {
      titulo: 'Cuánto tiempo se guardan',
      parrafos: [
        'La ley obliga a guardar la ficha clínica al menos 15 años desde la última anotación (Ley 20.584), aunque termines la terapia; luego se elimina o anonimiza.',
      ],
    },
    {
      titulo: 'Tus derechos',
      parrafos: [
        'Puedes acceder a tus datos, corregirlos, eliminarlos (salvo la ficha en su plazo legal), oponerte, bloquearlos o llevártelos, y reclamar ante la Agencia de Protección de Datos Personales. Puedes retirar este consentimiento o cualquier autorización cuando quieras, gratis y sin dar razones, por correo o WhatsApp; no afecta lo ya hecho, y retirar la 2 o la 3 no cambia tu atención.',
        'Proveedores, países, plazos y el detalle de tus derechos: valentinaorellana.cl/condiciones#privacidad.',
      ],
    },
  ];
}

export interface ConsentOption { key: 'accept_treatment' | 'accept_recording' | 'accept_case_review'; titulo: string; texto: string; obligatoria: boolean }

export const CONSENT_OPTIONS: ConsentOption[] = [
  {
    key: 'accept_treatment',
    titulo: '1. Tratamiento de mis datos (necesaria para atenderte)',
    texto: 'Leí este documento y autorizo el tratamiento de mis datos personales y de salud para mi atención psicológica, en estos términos.',
    obligatoria: true,
  },
  {
    key: 'accept_recording',
    titulo: '2. Grabación de sesiones (opcional)',
    texto: 'Autorizo grabar el audio de mis sesiones para transcribirlo y procesarlo con herramientas tecnológicas, incluida IA, solo para elaborar las notas de mi ficha y preparar mi atención, mediante proveedores por encargo, algunos fuera de Chile (principalmente Estados Unidos). El audio se borra al transcribirse, la transcripción queda en mi ficha y ninguna herramienta decide sobre mi tratamiento. Es voluntario: sin esto me atienden igual. Puedo pedir en cualquier momento que se deje de grabar o retirar esta autorización; lo ya transcrito queda en mi ficha clínica. En pareja, cada persona firma y solo se graba si todas lo autorizan.',
    obligatoria: false,
  },
  {
    key: 'accept_case_review',
    titulo: '3. Revisión anónima de casos (opcional)',
    texto: 'Autorizo que mi caso, sin ningún dato que permita reconocerme, se analice con otros psicólogos sujetos a secreto profesional, para mejorar mi atención.',
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
// persona (0021, decisión D del 16 oct noche): 1 = la persona agendada (como
// siempre); 2 = la segunda persona de una pareja, con su propio consentimiento
// ligado a la misma ficha. Se lee con select('*') y se filtra aquí para que,
// sin la migración 0021, el link de la persona 1 siga funcionando igual que hoy
// (sin la columna, todas las filas son de la persona 1).
export { FaltaMigracion0021 };

export async function getOrCreatePendingConsent(patientId: string, persona: 1 | 2 = 1): Promise<{ id: string; token: string }> {
  return pendienteOCrear(supabase, patientId, persona, CONSENT_VERSION, () => randomBytes(24).toString('base64url'));
}

/** Persona de una fila de consents (0021). Sin la columna: 1. */
export const personaConsent = (r: { persona?: number | null }): 1 | 2 => personaDe(r);

export interface ConsentRow {
  id: string; patient_id: string | null; token: string; version: string;
  created_at: string; sent_at: string | null; sent_via: string | null;
  signed_at: string | null; signer_name: string | null; signer_rut: string | null;
  accept_treatment: boolean; accept_recording: boolean; accept_case_review: boolean;
  revoked_at: string | null; revoked_note: string | null;
  /** 0021: 1 = persona agendada, 2 = segunda persona de la pareja. Sin la migración: undefined (= 1). */
  persona?: number | null;
}

// Consentimiento vigente = el último firmado, aceptando el tratamiento, y no
// revocado. Si el último firmado fue revocado, el paciente vuelve a quedar
// pendiente (hay que pedirle uno nuevo).
// Solo de la persona agendada (persona 1): la firma de la pareja (persona 2)
// nunca reemplaza ni tapa la falta del consentimiento propio de la paciente.
// La regla vive en transcriptor/estadoConsentimiento.ts (pura, con pruebas) y la usa también el
// indicador "Sin consentimiento firmado" de la lista, la agenda y el grabador.
export function vigente(rows: ConsentRow[]): ConsentRow | null {
  return vigentePropio(rows);
}

export interface ConsentAlert { patientId: string; name: string; sentAt: string | null }

// Pacientes activos sin consentimiento vigente — aviso permanente del admin.
// Solo los que tienen al menos una sesión vigente (por pagar o confirmada): si todas sus horas
// se anularon o vencieron, no hay atención en curso y no se avisa (Vale, 19 oct 2026). Si
// vuelven a agendar, reaparecen solos.

export async function getConsentAlerts(): Promise<ConsentAlert[]> {
  const [{ data: patients, error: pErr }, { data: consents, error: cErr }, { data: reservas, error: bErr }] = await Promise.all([
    supabase.from('patients').select('id, name, email').eq('active', true).order('name'),
    supabase.from('consents').select('*').not('patient_id', 'is', null),
    supabase.from('bookings').select('patient_email, patient_name').not('status', 'in', '(cancelled,expired)').limit(20000), // tope explícito: PostgREST corta en 1000 sin avisar
  ]);
  // Si la tabla aún no existe (migración sin correr) no avisar en falso a todos.
  if (pErr || cErr) return [];
  // Si falla leer las reservas, se avisa como antes (mejor de más que de menos).
  const vigentes = bErr ? null : new Set((reservas ?? []).map((r: { patient_email: string | null }) => String(r.patient_email ?? '').trim().toLowerCase()).filter(Boolean));
  // Ficha SIN correo (se agenda con "Pago en consulta" y la reserva queda con correo vacío): se
  // reconoce por el nombre de sus reservas sin correo. Antes del arreglo no se le avisaba nunca
  // aunque tuviera horas (auditoría 19 oct 2026).
  const nombreClave = (n: unknown) => String(n ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
  const vigentesSinCorreo = new Set((reservas ?? [])
    .filter((r: { patient_email: string | null }) => !String(r.patient_email ?? '').trim())
    .map((r: { patient_name: string | null }) => nombreClave(r.patient_name)).filter(Boolean));
  const porPaciente = new Map<string, ConsentRow[]>();
  for (const c of (consents ?? []) as ConsentRow[]) {
    const l = porPaciente.get(c.patient_id!) ?? [];
    l.push(c); porPaciente.set(c.patient_id!, l);
  }
  const alerts: ConsentAlert[] = [];
  for (const p of patients ?? []) {
    const rows = porPaciente.get(p.id) ?? [];
    if (vigente(rows)) continue;
    const correo = String((p as { email?: string | null }).email ?? '').trim();
    if (vigentes && (correo ? !tieneSesionVigente(correo, vigentes) : !vigentesSinCorreo.has(nombreClave(p.name)))) continue;
    const enviado = rows.filter(r => !r.signed_at && r.sent_at && personaConsent(r) === 1).map(r => r.sent_at!).sort().pop() ?? null;
    alerts.push({ patientId: p.id, name: p.name, sentAt: enviado });
  }
  return alerts;
}

export function whatsappConsentMessage(firstName: string, url: string) {
  return `Hola ${firstName}, te comparto el consentimiento informado para el tratamiento de tus datos en la terapia, que pide la nueva ley de protección de datos. Son 2 minutos: lo lees, marcas lo que autorizas y firmas con tu nombre y RUT.\n\n${url}\n\nCualquier duda me escribes. Valentina`;
}
