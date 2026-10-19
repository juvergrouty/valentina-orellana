// Transcriptor IA (P4) — ¿se puede grabar esta sesión? Chequeo EN EL SERVIDOR.
// Decisiones: 01-decisiones-16oct.md (4 y 9: Grabar bloqueado si falta la firma con grabación autorizada de
// cualquiera de los presentes, pareja: ambos; 7: no se graba a menores de 18) y
// 10-etica-legal.md §4.1–4.2. El botón de la interfaz solo refleja este resultado:
// grabacion-iniciar, subida-url y grabacion-finalizar lo vuelven a consultar.
//
// Versiones que habilitan grabar (decisión 9 de 01-decisiones-16oct.md, que manda):
//   - Se lee la misma tabla `consents` (0004). No se agregan columnas.
//   - La versión es el texto `consents.version` con la forma 'AAAA-MM-vN'.
//   - La v2 ('2026-10-v2') con la autorización `accept_recording = true` SÍ habilita grabar
//     (Vale quiere que sirva a quienes ya firmaron; la abogada lo confirmará). La v3 (nueva,
//     amplia, para pacientes nuevos) y posteriores también. La v1 no → 'version_antigua'.
//   - Revocación o `accept_recording = false` bloquea.
//   - Pareja = UNA ficha y cada persona firma su propio formulario (fila propia con el
//     mismo patient_id). Las firmas se agrupan por persona: RUT normalizado, si no hay,
//     correo, si no, nombre. Se exigen 2 personas distintas con firma vigente (v2 o v3+)
//     que autorice la grabación.
//   - De cada persona vale su ÚLTIMA firma: si después firmó sin autorizar la grabación
//     o la revocó (revoked_at), esa persona bloquea la grabación aunque antes aceptara.
//   - Conservador: si CUALQUIER persona de la ficha tiene su última firma revocada, sin
//     autorizar grabación o anterior a la v2, no se graba (aunque se elija 'individual').
//   - H1 (81-revision-etica-clinica): "Retirar solo la grabación" marca `recording_revoked_at`
//     (0019) en la firma de ESA persona; se trata igual que una revocación para grabar
//     (motivo 'revocado'), sin tocar el resto de su consentimiento.
//   - H2: "pareja" lo deduce el SERVIDOR desde la ficha (reservas pareja-*, grabaciones de pareja,
//     2+ personas firmantes o un nombre de ficha "X y Y"). Si la ficha es de pareja, se exigen 2
//     firmas aunque la pantalla (o el evento sin tipo) diga "individual".
//   - D (02-decisiones-16oct-noche, manda): la fuente de verdad de "pareja" es LA RESERVA: su
//     session_type 'pareja-*' o el servicio reservado (services_catalog.type = 'pareja'), ver
//     pareja.ts. Las otras señales se mantienen solo para pedir MÁS firmas, nunca menos. La segunda
//     persona firma por su link (consents.persona = 2, 0021); cuenta como persona distinta solo si su
//     identidad (RUT) es distinta: dos filas de la misma persona nunca suman dos firmas.
import type { SupabaseClient } from '@supabase/supabase-js';
import { AJUSTES, type PuedeGrabar, type ResultadoPuedeGrabar, type TipoSesion } from './tipos';
import { reservasDeFicha, fichaConReservaPareja } from './pareja';

/** Fila mínima de `consents` que se necesita (subconjunto de ConsentRow). */
export interface FilaConsentimiento {
  id: string;
  version: string | null;
  signed_at: string | null;
  signer_name: string | null;
  signer_rut: string | null;
  signer_email?: string | null;
  accept_recording: boolean | null;
  revoked_at: string | null;
  /** 0019: retiro SOLO de la autorización de grabación de esta persona (H1). */
  recording_revoked_at?: string | null;
}

export const EDAD_MINIMA_GRABACION = 18;
/** Decisión de Vale (19 oct, reemplaza la decisión 9): cualquier versión firmada con accept_recording=true
 *  habilita grabar, también la v1 (pacientes antiguos). Las v1 y v2 reciben el aviso único (avisoV2.ts). */
export const VERSION_MINIMA_GRABACION = 1;

/** Número de versión de 'AAAA-MM-vN' (o 'vN'). null si no se reconoce. */
export function numeroVersion(version: string | null | undefined): number | null {
  const m = /(?:^|-)v(\d+)\s*$/i.exec(String(version ?? '').trim());
  return m ? Number(m[1]) : null;
}

export function esVersionGrabacion(version: string | null | undefined): boolean {
  const n = numeroVersion(version);
  return n !== null && n >= VERSION_MINIMA_GRABACION;
}

/** Identidad de quien firmó: RUT sin puntos ni guion, si no correo, si no nombre. */
export function identidadFirmante(f: Pick<FilaConsentimiento, 'signer_rut' | 'signer_email' | 'signer_name' | 'id'>): string {
  const rut = String(f.signer_rut ?? '').replace(/[^0-9kK]/g, '').toUpperCase();
  if (rut.length >= 7) return `rut:${rut}`;
  const correo = String(f.signer_email ?? '').trim().toLowerCase();
  if (correo.includes('@')) return `correo:${correo}`;
  const nombre = String(f.signer_name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return nombre ? `nombre:${nombre}` : `fila:${f.id}`;
}

/** Edad cumplida en `hoy` (YYYY-MM-DD). Acepta 'AAAA-MM-DD' y 'DD-MM-AAAA' / 'DD/MM/AAAA'. null si no se entiende. */
export function edadEn(fechaNacimiento: string | null | undefined, hoy: string): number | null {
  const t = String(fechaNacimiento ?? '').trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (r) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(t))) { d = +r[1]; m = +r[2]; y = +r[3]; }
  else return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900) return null;
  const [hy, hm, hd] = hoy.split('-').map(Number);
  let edad = hy - y;
  if (hm < m || (hm === m && hd < d)) edad--;
  return edad >= 0 ? edad : null;
}

export interface EntradaEvaluacion {
  patientId: string | null;
  tipo: TipoSesion;
  /** H2: la ficha es de pareja según el servidor (fichaEsPareja). Manda sobre `tipo`. */
  fichaPareja?: boolean;
  fechaNacimiento: string | null;
  filas: FilaConsentimiento[];
  hoy: string; // YYYY-MM-DD (Chile)
}

export interface EvaluacionConsentimiento extends ResultadoPuedeGrabar {
  /** Tipo con que se evaluó (pareja si la ficha lo es, aunque se pidiera 'individual'). */
  tipoEfectivo: TipoSesion;
  /** true si la pantalla pidió otro tipo y el servidor dedujo pareja desde la ficha. */
  parejaDeducida: boolean;
  /** Nombres de quienes tienen firma vigente (v2 o v3+) con grabación autorizada (para mostrar "firmado por ambos ✓"). */
  firmantes: string[];
  /** Firmas vigentes que se necesitan (pareja 2, resto 1). */
  requeridas: number;
}

/** Lógica pura (sin base de datos): pruebas en consentimiento.test.ts. */
export function evaluarConsentimientos(e: EntradaEvaluacion): EvaluacionConsentimiento {
  const tipoEfectivo: TipoSesion = e.fichaPareja ? 'pareja' : e.tipo;
  const parejaDeducida = tipoEfectivo === 'pareja' && e.tipo !== 'pareja';
  const requeridas = tipoEfectivo === 'pareja' ? 2 : 1;
  const base = { consentIds: [] as string[], firmantes: [] as string[], requeridas, tipoEfectivo, parejaDeducida };
  if (!e.patientId) return { ...base, puede: false, motivo: 'sin_ficha' };

  // Decisión de Vale (18 oct): la fecha de nacimiento NO es excluyente; la autorización la da el
  // consentimiento firmado. Sin fecha se graba y la ficha muestra el pendiente "Falta la fecha de
  // nacimiento". Si la fecha existe y es de un menor de 18, no se graba.
  const edad = edadEn(e.fechaNacimiento, e.hoy);
  if (edad !== null && edad < EDAD_MINIMA_GRABACION) return { ...base, puede: false, motivo: 'menor_de_edad' };

  // Última firma de cada persona.
  const ultimas = new Map<string, FilaConsentimiento>();
  for (const f of e.filas) {
    if (!f.signed_at) continue;
    const k = identidadFirmante(f);
    const prev = ultimas.get(k);
    if (!prev || String(f.signed_at) > String(prev.signed_at)) ultimas.set(k, f);
  }
  if (!ultimas.size) return { ...base, puede: false, motivo: 'sin_consentimiento' };

  const validas: FilaConsentimiento[] = [];
  let hayRevocada = false, hayAntigua = false, hayNegada = false;
  for (const f of ultimas.values()) {
    if (f.revoked_at || f.recording_revoked_at) { hayRevocada = true; continue; }
    if (!esVersionGrabacion(f.version)) { hayAntigua = true; continue; }
    if (!f.accept_recording) { hayNegada = true; continue; }
    validas.push(f);
  }
  const consentIds = validas.map((f) => f.id);
  const firmantes = validas.map((f) => String(f.signer_name ?? '').trim()).filter(Boolean);

  // Alguien de la ficha revocó o firmó sin autorizar la grabación: no se graba.
  if (hayRevocada) return { ...base, consentIds, firmantes, puede: false, motivo: 'revocado' };
  if (hayNegada) return { ...base, consentIds, firmantes, puede: false, motivo: 'sin_consentimiento' };
  // Cualquier persona de la ficha cuya última firma es anterior a la v2 bloquea, aunque se elija
  // "individual" (evita saltarse la segunda firma de una pareja eligiendo el tipo equivocado).
  if (hayAntigua) return { ...base, consentIds, firmantes, puede: false, motivo: validas.length ? 'falta_segunda_firma' : 'version_antigua' };
  if (validas.length >= requeridas) return { ...base, consentIds, firmantes, puede: true };
  if (validas.length === 0) return { ...base, consentIds, firmantes, puede: false, motivo: hayAntigua ? 'version_antigua' : 'sin_consentimiento' };
  return { ...base, consentIds, firmantes, puede: false, motivo: 'falta_segunda_firma' };
}

/** Dónde se arregla cada bloqueo (enlace del aviso). null = no hay nada que completar en la ficha. */
export function enlaceArreglo(motivo: string | undefined, patientId: string | null | undefined): { href: string; etiqueta: string } | null {
  if (!patientId) return null;
  if (motivo === 'sin_fecha_nacimiento') return { href: `/admin/pacientes/${patientId}?tab=info#pf-nacimiento`, etiqueta: 'Completar la ficha' };
  if (motivo === 'menor_de_edad' || motivo === 'transcriptor_apagado' || motivo === 'sin_ficha') return null;
  return { href: `/admin/pacientes/${patientId}`, etiqueta: 'Enviar consentimiento' };
}

/** Nota del robot de Meet cuando no se envía (grabaciones.nota_sistema). */
export function notaRobotSinPermiso(motivo: string | undefined): string {
  if (motivo === 'sin_fecha_nacimiento') return 'No se envió el asistente de notas. Falta la fecha de nacimiento en la ficha. Complétala para tener la ficha al día; si es menor de 18 no se graba.';
  if (motivo === 'menor_de_edad') return 'No se envió el asistente de notas: no se graba a menores de 18 años.';
  return 'No se envió el asistente de notas: falta el consentimiento de grabación o la ficha.';
}

/** Texto para Vale (español de Chile, sin términos técnicos). 40-ux-diseno §7. */
export function textoMotivo(motivo: string | undefined, nombre?: string | null): string {
  const quien = (nombre ?? '').trim() || 'la paciente o el paciente';
  switch (motivo) {
    case 'sin_ficha': return 'Esta sesión no está asociada a una ficha. Elige al paciente para poder grabar.';
    case 'menor_de_edad': return 'No se graba a menores de 18 años.';
    case 'sin_fecha_nacimiento': return `Falta la fecha de nacimiento en la ficha de ${quien}. Complétala para tener la ficha al día (Información → Fecha de nacimiento); si es menor de 18 no se graba.`;
    case 'revocado': return `Se retiró la autorización de grabación en la ficha de ${quien}. Sin ella no se puede grabar.`;
    case 'version_antigua': return `Falta el consentimiento de grabación de ${quien}. La versión que firmó no incluye la autorización de grabación; envíale el consentimiento actual.`;
    case 'falta_segunda_firma': return 'Falta el consentimiento de grabación de la otra persona de la pareja. Sin él no se puede grabar.';
    case 'ficha_pareja': return 'Esta ficha es de pareja. Para grabar se necesita el consentimiento de las dos personas.';
    case 'transcriptor_apagado': return 'El grabador está apagado en la configuración del transcriptor.';
    case 'sin_consentimiento':
    default: return `Falta el consentimiento de grabación de ${quien}. Sin él no se puede grabar esta sesión.`;
  }
}

// ─── Con base de datos ───────────────────────────────────────────────────────

async function db(cliente?: SupabaseClient): Promise<SupabaseClient> {
  return cliente ?? (await import('../supabase')).supabase;
}

function hoyChile(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Contrato P4 (tipos.ts → PuedeGrabar). */
export const puedeGrabar: PuedeGrabar = async (patientId, tipo) => evaluarEnBase(patientId, tipo);

export interface SenalesPareja {
  /** session_type de las reservas de la ficha (por su correo). */
  sessionTypes: (string | null | undefined)[];
  /** D: alguna reserva de la ficha es de un servicio de pareja (services_catalog.type), ver pareja.ts. */
  servicioPareja?: boolean;
  /** grabaciones.tipo previas de la ficha. */
  tiposGrabaciones: (string | null | undefined)[];
  /** Firmas (para contar personas distintas). */
  filas: Pick<FilaConsentimiento, 'id' | 'signed_at' | 'signer_rut' | 'signer_email' | 'signer_name'>[];
  /** Nombre de la ficha ("Ana y Luis", "Ana & Luis"). */
  nombre: string | null | undefined;
}

/** H2: ¿la ficha es de pareja? Cualquier señal basta (conservador: pide 2 firmas). Función pura. */
export function fichaEsPareja(x: SenalesPareja): boolean {
  if (x.servicioPareja) return true;
  if (x.sessionTypes.some((t) => String(t ?? '').startsWith('pareja'))) return true;
  if (x.tiposGrabaciones.some((t) => t === 'pareja')) return true;
  const personas = new Set(x.filas.filter((f) => f.signed_at).map((f) => identidadFirmante(f)));
  if (personas.size >= 2) return true;
  return /\S\s+(y|&|e)\s+\S/i.test(String(x.nombre ?? '').trim());
}

interface DatosFicha {
  ficha: { name?: string | null; email?: string | null; birthdate?: string | null } | null;
  filas: FilaConsentimiento[];
  fichaPareja: boolean;
}

/** Lee la ficha, sus firmas y las señales de pareja. Lanza si la base falla (falla cerrado). */
async function datosFicha(c: SupabaseClient, patientId: string): Promise<DatosFicha> {
  const [pac, cons, grabs] = await Promise.all([
    c.from('patients').select('id, name, email, birthdate').eq('id', patientId).maybeSingle(),
    c.from('consents')
      .select('id, version, signed_at, signer_name, signer_rut, signer_email, accept_recording, revoked_at, recording_revoked_at')
      .eq('patient_id', patientId),
    c.from('grabaciones').select('tipo').eq('patient_id', patientId).eq('tipo', 'pareja').limit(1),
  ]);
  if (pac.error) throw new Error(`consentimiento: no se pudo leer la ficha (${pac.error.message})`);
  if (cons.error) throw new Error(`consentimiento: no se pudieron leer los consentimientos (${cons.error.message})`);
  if (grabs.error) throw new Error(`consentimiento: no se pudieron leer las grabaciones (${grabs.error.message})`);
  if (!pac.data) return { ficha: null, filas: [], fichaPareja: false };
  const ficha = pac.data as { name?: string | null; email?: string | null; birthdate?: string | null };
  // D: la reserva manda (session_type o servicio de pareja). Si no se pueden leer, falla cerrado.
  const { reservas, tipoServicio } = await reservasDeFicha(c, ficha.email);
  const sessionTypes = reservas.map((b) => String(b.session_type ?? ''));
  const servicioPareja = fichaConReservaPareja(reservas, tipoServicio);
  const filas = (cons.data ?? []) as FilaConsentimiento[];
  const fichaPareja = fichaEsPareja({ sessionTypes, servicioPareja, tiposGrabaciones: ((grabs.data ?? []) as { tipo?: string }[]).map((g) => g.tipo), filas, nombre: ficha.name });
  return { ficha, filas, fichaPareja };
}

/**
 * ¿Esta ficha se trata como de pareja (pide 2 firmas)? ÚNICA fuente de verdad (86-revisión B1): la usan
 * evaluarEnBase (para grabar), el link de la segunda persona (api/admin/consent.ts) y el bloque de la
 * ficha (fichaConsentimientos.ts → ConsentimientosFicha.astro y la franja Pendientes). Así, si para grabar se exigen 2 firmas, el link para la
 * segunda persona siempre existe. Lanza si la base falla.
 */
export async function fichaEsParejaEnBase(patientId: string, cliente?: SupabaseClient): Promise<boolean> {
  return (await datosFicha(await db(cliente), patientId)).fichaPareja;
}

/** Igual que puedeGrabar pero devuelve también firmantes/requeridas. Lanza si la base falla (falla cerrado). */
export async function evaluarEnBase(patientId: string | null, tipo: TipoSesion, cliente?: SupabaseClient): Promise<EvaluacionConsentimiento> {
  if (!patientId) return evaluarConsentimientos({ patientId: null, tipo, fechaNacimiento: null, filas: [], hoy: hoyChile() });
  const { ficha, filas, fichaPareja } = await datosFicha(await db(cliente), patientId);
  if (!ficha) return evaluarConsentimientos({ patientId: null, tipo, fechaNacimiento: null, filas: [], hoy: hoyChile() });
  return evaluarConsentimientos({ patientId, tipo, fichaPareja, fechaNacimiento: ficha.birthdate ?? null, filas, hoy: hoyChile() });
}

/** ¿transcriptor_activo = 'true'? Falla cerrado (error de lectura = apagado). */
export async function transcriptorActivo(cliente?: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await (await db(cliente)).from('settings').select('value').eq('key', AJUSTES.activo).maybeSingle();
    if (error) return false;
    return String(data?.value ?? '').trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export type MotivoBloqueo = NonNullable<ResultadoPuedeGrabar['motivo']> | 'transcriptor_apagado' | 'ficha_pareja';

/** Motivo a mostrar: si falta la 2.ª firma porque el servidor dedujo pareja, el texto lo explica (H2). */
export function motivoVisible(v: Pick<ResultadoVerificacion, 'motivo' | 'parejaDeducida'>): MotivoBloqueo | undefined {
  return v.motivo === 'falta_segunda_firma' && v.parejaDeducida ? 'ficha_pareja' : v.motivo;
}
export interface ResultadoVerificacion extends Omit<EvaluacionConsentimiento, 'motivo'> { motivo?: MotivoBloqueo }

/** Chequeo completo que usan los endpoints: interruptor + consentimiento + edad. */
export async function verificarGrabacion(patientId: string | null, tipo: TipoSesion, cliente?: SupabaseClient): Promise<ResultadoVerificacion> {
  if (!(await transcriptorActivo(cliente))) {
    return { puede: false, motivo: 'transcriptor_apagado', consentIds: [], firmantes: [], requeridas: tipo === 'pareja' ? 2 : 1, tipoEfectivo: tipo, parejaDeducida: false };
  }
  return evaluarEnBase(patientId, tipo, cliente);
}
