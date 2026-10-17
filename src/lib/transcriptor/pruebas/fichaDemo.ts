// Datos de prueba de la ficha del paciente (SOLO `astro dev`, ?demo=ia): nombres y contenido inventados.
// Movido desde pacientes/[id].astro (17 oct) para que la ficha y su historial (carga bajo demanda)
// usen exactamente los mismos datos. Parámetros (solo demo):
//   ?pareja=falta  → la sesión se llama "Sesión de pareja" y falta la firma de la segunda persona.
//   ?n=40          → agrega sesiones antiguas archivadas (para medir el tamaño de la página).
//   ?falta=0020    → aviso de la migración 0020 pendiente.
import type { GrabFicha, ResFicha } from '../fichaNotas';

const res = (puntos: string, tareas: string, proxima: string) => `## Resumen automático (IA)\n*Sesión individual · presencial · 50 min · Generado automáticamente a partir de la transcripción. No revisado. No constituye la evolución clínica.*\n\n### Puntos más importantes\n${puntos}\n\n### Tareas\n${tareas}\n\n### Para trabajar en la próxima sesión\n${proxima}`;
const G = (n: number) => `00000000-0000-4000-8000-${`a${n}`.padStart(12, '0')}`;

export interface FichaDemo {
  patient: Record<string, unknown>;
  notas: Record<string, unknown>[];
  reservas: Record<string, unknown>[];
  grabaciones: GrabFicha[];
  resumenes: ResFicha[];
  archivados: Record<string, string>;
  consentRows: Record<string, unknown>[];
  falta0020: boolean;
}

export function fichaDemo(id: string, params: URLSearchParams): FichaDemo {
  const parejaFalta = params.get('pareja') === 'falta';
  const extra = Math.min(Math.max(Number(params.get('n') ?? 0) || 0, 0), 200);
  const patient = { id, name: 'Camila Rojas', email: 'camila@example.com', phone: '+56911112222', active: true, birthdate: '1993-04-02', rut: null, notes: '', address: 'Av. Siempre Viva 123', comuna: 'Ñuñoa', steps_sent_at: '2026-09-10T12:00:00Z' };
  const notas: Record<string, unknown>[] = [
    { id: 'n1', patient_id: id, booking_id: 'b1', session_date: '2026-10-15', session_type: 'presencial', content: 'Buena adherencia. Trabajar asertividad con la jefa. Retomar registro de pensamientos.', deleted_at: null },
    { id: 'n3', patient_id: id, booking_id: 'b3', session_date: '2026-10-01', session_type: 'presencial', content: 'Se trabaja motivo de consulta: ansiedad laboral. Acuerdo de frecuencia semanal.', deleted_at: null },
    { id: 'n5', patient_id: id, booking_id: 'b5', session_date: '2026-09-17', session_type: 'presencial', content: 'Primera sesión. Entrevista inicial.', deleted_at: null },
  ];
  const rv = (bid: string, fecha: string, tipo = 'presencial', titulo: string | null = null) =>
    ({ id: bid, session_date: fecha, session_time: '16:00:00', session_type: tipo, status: 'confirmed', amount: 45000, paid_at: `${fecha}T19:00:00Z`, notes: '', patient_email: 'camila@example.com', custom_title: titulo });
  const reservas: Record<string, unknown>[] = [
    rv('b1', '2026-10-15', 'presencial', parejaFalta ? 'Sesión de pareja' : null), rv('b2', '2026-10-08'), rv('b3', '2026-10-01'),
    rv('b4', '2026-09-24', 'online'), rv('b5', '2026-09-17'), rv('b6', '2026-09-10'),
  ];
  const dg = (n: number, b: string, fecha: string, origen: 'presencial' | 'online' = 'presencial'): GrabFicha =>
    ({ id: G(n), booking_id: b, origen, tipo: 'individual', estado: 'lista', estado_antes_error: null, session_date: fecha, inicio_at: `${fecha}T19:00:00Z`, duracion_seg: 3000, nota_sistema: null, created_at: `${fecha}T19:00:00Z` });
  const grabaciones = [dg(1, 'b1', '2026-10-15'), dg(2, 'b2', '2026-10-08'), dg(3, 'b3', '2026-10-01'), dg(4, 'b4', '2026-09-24', 'online'), dg(5, 'b5', '2026-09-17'), dg(6, 'b6', '2026-09-10')];
  const dr = (n: number, contenido: string | null, archivado = false): ResFicha =>
    ({ id: `00000000-0000-4000-8000-${`r${n}`.padStart(12, '0')}`, grabacion_id: G(n), version: 1, autor: 'ia', estado: 'listo', rotulo: null, modelo: 'claude-sonnet-5-5', listo_at: '2026-10-15T20:10:00Z', created_at: '2026-10-15T20:00:00Z', contenido: archivado ? null : contenido, archivado_at: archivado ? '2026-10-16T03:00:00Z' : null, archivo_r2_key: archivado ? 't/demo.bin' : null });
  const r1 = res(
    '- Se habló de no dar más con el trabajo — Dicho por: Camila — [23:40]\n  «a veces siento que no doy más»\n_Mención consignada automáticamente. No es una evaluación de riesgo; revisar la transcripción completa._\n- Refiere dormir mejor desde que deja el celular fuera de la pieza [05:12].\n- La conversación pendiente con su jefa sigue siendo lo que más le preocupa [18:30].\n- Cuenta que el registro de pensamientos le ayudó a notar que se anticipa a lo peor [31:05].',
    '- Camila: registro de pensamientos 3 veces — antes de la próxima sesión [41:00].\n- Camila: pedir la reunión con su jefa para el jueves [44:10].',
    '- Cómo le fue con la conversación con su jefa.\n- Retomar "siempre tengo que poder con todo", que quedó abierto [47:00].',
  );
  const r2 = res('- Cuenta que discutió con su hermana por el cuidado de su mamá [08:15].\n- Dice que el fin de semana pudo descansar sin revisar correos [22:40].', '- No consta en la transcripción.', '- Cómo sigue la conversación con su hermana.');
  const r3 = res('- Describe el motivo de consulta: ansiedad antes de las reuniones [04:00].\n- Acuerdan frecuencia semanal [49:00].', '- Camila: anotar los momentos de ansiedad de la semana [45:30].', '- Revisar el registro de ansiedad.');
  const r4 = res('- Habla de la mudanza y de cómo le afecta el ruido del edificio [12:00].', '- No consta en la transcripción.', '- No consta en la transcripción.');
  const r5 = res('- Entrevista inicial: historia laboral y familiar [03:00].', '- No consta en la transcripción.', '- Profundizar en el trabajo actual.');
  const r6 = res('- Llamada de contacto previa: horarios y valores [01:00].', '- No consta en la transcripción.', '- No consta en la transcripción.');
  const resumenes = [dr(1, r1), dr(2, r2), dr(3, r3), dr(4, r4), dr(5, r5, true), dr(6, r6, true)];
  const archivados: Record<string, string> = { [dr(5, null, true).id]: r5, [dr(6, null, true).id]: r6 };
  // Sesiones antiguas extra (archivadas, con nota de evolución) para medir cómo crece la página.
  for (let k = 0; k < extra; k++) {
    const n = 100 + k;
    const d = new Date(Date.UTC(2026, 8, 3) - k * 7 * 86_400_000).toISOString().slice(0, 10);
    const bid = `bx${k}`;
    reservas.push(rv(bid, d));
    grabaciones.push(dg(n, bid, d));
    const r = dr(n, null, true);
    resumenes.push(r);
    archivados[r.id] = res(`- Sesión de seguimiento ${k + 1}: se revisa la semana y lo que costó [10:00].\n- Practica la respiración antes de las reuniones [25:00].\n- Nota que pide ayuda con más facilidad [38:00].`, '- Camila: registro diario de ansiedad [44:00].', '- Revisar el registro y lo que le costó.');
    notas.push({ id: `nx${k}`, patient_id: id, booking_id: bid, session_date: d, session_type: 'presencial', content: `Sesión de seguimiento ${k + 1}. Se revisa la semana, registro de ansiedad y estrategias de afrontamiento. Buena adherencia a las tareas; se acuerda continuar con el plan.`, deleted_at: null });
  }
  const consentRows: Record<string, unknown>[] = [
    { id: '00000000-0000-4000-8000-0000000000c1', patient_id: id, token: 't1', version: '2026-10-v3', created_at: '2026-10-01T12:00:00Z', signed_at: '2026-10-01T12:05:00Z', signer_name: 'Camila Rojas', signer_rut: '12.345.678-5', accept_treatment: true, accept_recording: true, accept_case_review: false, revoked_at: null, recording_revoked_at: null, persona: 1 },
    { id: '00000000-0000-4000-8000-0000000000c3', patient_id: id, token: 't0', version: '2026-09-v1', created_at: '2026-09-10T12:00:00Z', signed_at: '2026-09-10T12:05:00Z', signer_name: 'Camila Rojas', signer_rut: '12.345.678-5', accept_treatment: true, accept_recording: false, accept_case_review: false, revoked_at: '2026-10-01T12:04:00Z', recording_revoked_at: null, persona: 1 },
  ];
  if (!parejaFalta) {
    consentRows.push({ id: '00000000-0000-4000-8000-0000000000c2', patient_id: id, token: 't2', version: '2026-10-v2', created_at: '2026-09-20T12:00:00Z', signed_at: '2026-09-20T12:05:00Z', signer_name: 'Tomás Fuentes', signer_rut: '15.555.555-5', accept_treatment: true, accept_recording: true, accept_case_review: true, revoked_at: null, recording_revoked_at: '2026-10-12T15:00:00Z', recording_revoked_via: 'whatsapp', persona: 2 });
  } else {
    consentRows.push({ id: '00000000-0000-4000-8000-0000000000c4', patient_id: id, token: 'demo-pareja-Xx7Qm2LpR4vN9sKe1Tz0aB3c', version: '2026-10-v3', created_at: '2026-10-14T12:00:00Z', signed_at: null, sent_at: '2026-10-14T12:01:00Z', sent_via: 'whatsapp', persona: 2 });
  }
  return { patient, notas, reservas, grabaciones, resumenes, archivados, consentRows, falta0020: params.get('falta') === '0020' };
}
