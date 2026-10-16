// Transcriptor IA (P4) — ¿se puede grabar esta sesión? Chequeo EN EL SERVIDOR.
// Decisiones: 01-decisiones-16oct.md (4: Grabar bloqueado si falta la firma v3 de
// cualquiera de los presentes, pareja: ambos; 7: no se graba a menores de 18) y
// 10-etica-legal.md §4.1–4.2. El botón de la interfaz solo refleja este resultado:
// grabacion-iniciar, subida-url y grabacion-finalizar lo vuelven a consultar.
//
// Cómo se reconoce la v3 SIN romper la v2 (src/lib/consent.ts):
//   - Se lee la misma tabla `consents` (0004). No se agregan columnas.
//   - La versión es el texto `consents.version` con la forma 'AAAA-MM-vN'
//     (hoy CONSENT_VERSION = '2026-10-v2'). v3 = N >= 3 (también vale una v4 futura).
//     La v2 sigue valiendo para la atención (vigente() no cambia), pero su
//     autorización 2 (Encuadrado) NO cubre IA ni EE.UU. → para grabar: 'version_antigua'.
//   - Pareja = UNA ficha y cada persona firma su propio formulario (fila propia con el
//     mismo patient_id). Las firmas se agrupan por persona: RUT normalizado, si no hay,
//     correo, si no, nombre. Se exigen 2 personas distintas con firma v3 vigente.
//   - De cada persona vale su ÚLTIMA firma: si después firmó sin autorizar la grabación
//     o la revocó (revoked_at), esa persona bloquea la grabación aunque antes aceptara.
//   - Conservador: si CUALQUIER persona de la ficha tiene su última firma revocada, sin
//     autorizar grabación o anterior a la v3, no se graba (aunque se elija 'individual').
import type { SupabaseClient } from '@supabase/supabase-js';
import { AJUSTES, type PuedeGrabar, type ResultadoPuedeGrabar, type TipoSesion } from './tipos';

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
}

export const EDAD_MINIMA_GRABACION = 18;
export const VERSION_MINIMA_GRABACION = 3;

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
  fechaNacimiento: string | null;
  filas: FilaConsentimiento[];
  hoy: string; // YYYY-MM-DD (Chile)
}

export interface EvaluacionConsentimiento extends ResultadoPuedeGrabar {
  /** Nombres de quienes tienen firma v3 vigente (para mostrar "firmado por ambos ✓"). */
  firmantes: string[];
  /** Firmas vigentes que se necesitan (pareja 2, resto 1). */
  requeridas: number;
}

/** Lógica pura (sin base de datos): pruebas en consentimiento.test.ts. */
export function evaluarConsentimientos(e: EntradaEvaluacion): EvaluacionConsentimiento {
  const requeridas = e.tipo === 'pareja' ? 2 : 1;
  const base = { consentIds: [] as string[], firmantes: [] as string[], requeridas };
  if (!e.patientId) return { ...base, puede: false, motivo: 'sin_ficha' };

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
    if (f.revoked_at) { hayRevocada = true; continue; }
    if (!esVersionGrabacion(f.version)) { hayAntigua = true; continue; }
    if (!f.accept_recording) { hayNegada = true; continue; }
    validas.push(f);
  }
  const consentIds = validas.map((f) => f.id);
  const firmantes = validas.map((f) => String(f.signer_name ?? '').trim()).filter(Boolean);

  // Alguien de la ficha revocó o firmó sin autorizar la grabación: no se graba.
  if (hayRevocada) return { ...base, consentIds, firmantes, puede: false, motivo: 'revocado' };
  if (hayNegada) return { ...base, consentIds, firmantes, puede: false, motivo: 'sin_consentimiento' };
  // Cualquier persona de la ficha cuya última firma es anterior a la v3 bloquea, aunque se elija
  // "individual" (evita saltarse la segunda firma de una pareja eligiendo el tipo equivocado).
  if (hayAntigua) return { ...base, consentIds, firmantes, puede: false, motivo: validas.length ? 'falta_segunda_firma' : 'version_antigua' };
  if (validas.length >= requeridas) return { ...base, consentIds, firmantes, puede: true };
  if (validas.length === 0) return { ...base, consentIds, firmantes, puede: false, motivo: hayAntigua ? 'version_antigua' : 'sin_consentimiento' };
  return { ...base, consentIds, firmantes, puede: false, motivo: 'falta_segunda_firma' };
}

/** Texto para Vale (español de Chile, sin términos técnicos). 40-ux-diseno §7. */
export function textoMotivo(motivo: string | undefined, nombre?: string | null): string {
  const quien = (nombre ?? '').trim() || 'la paciente o el paciente';
  switch (motivo) {
    case 'sin_ficha': return 'Esta sesión no está asociada a una ficha. Elige al paciente para poder grabar.';
    case 'menor_de_edad': return 'No se graba a menores de 18 años.';
    case 'revocado': return `Se retiró la autorización de grabación en la ficha de ${quien}. Sin ella no se puede grabar.`;
    case 'version_antigua': return `Falta el consentimiento de grabación de ${quien} (versión nueva, con IA). El que firmó antes no cubre la grabación con IA.`;
    case 'falta_segunda_firma': return 'Falta el consentimiento de grabación de la otra persona de la pareja. Sin él no se puede grabar.';
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

/** Igual que puedeGrabar pero devuelve también firmantes/requeridas. Lanza si la base falla (falla cerrado). */
export async function evaluarEnBase(patientId: string | null, tipo: TipoSesion, cliente?: SupabaseClient): Promise<EvaluacionConsentimiento> {
  if (!patientId) return evaluarConsentimientos({ patientId: null, tipo, fechaNacimiento: null, filas: [], hoy: hoyChile() });
  const c = await db(cliente);
  const [pac, cons] = await Promise.all([
    c.from('patients').select('id, birthdate').eq('id', patientId).maybeSingle(),
    c.from('consents')
      .select('id, version, signed_at, signer_name, signer_rut, signer_email, accept_recording, revoked_at')
      .eq('patient_id', patientId),
  ]);
  if (pac.error) throw new Error(`consentimiento: no se pudo leer la ficha (${pac.error.message})`);
  if (cons.error) throw new Error(`consentimiento: no se pudieron leer los consentimientos (${cons.error.message})`);
  if (!pac.data) return evaluarConsentimientos({ patientId: null, tipo, fechaNacimiento: null, filas: [], hoy: hoyChile() });
  return evaluarConsentimientos({
    patientId,
    tipo,
    fechaNacimiento: (pac.data as { birthdate?: string | null }).birthdate ?? null,
    filas: (cons.data ?? []) as FilaConsentimiento[],
    hoy: hoyChile(),
  });
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

export type MotivoBloqueo = NonNullable<ResultadoPuedeGrabar['motivo']> | 'transcriptor_apagado';
export interface ResultadoVerificacion extends Omit<EvaluacionConsentimiento, 'motivo'> { motivo?: MotivoBloqueo }

/** Chequeo completo que usan los endpoints: interruptor + consentimiento + edad. */
export async function verificarGrabacion(patientId: string | null, tipo: TipoSesion, cliente?: SupabaseClient): Promise<ResultadoVerificacion> {
  if (!(await transcriptorActivo(cliente))) {
    return { puede: false, motivo: 'transcriptor_apagado', consentIds: [], firmantes: [], requeridas: tipo === 'pareja' ? 2 : 1 };
  }
  return evaluarEnBase(patientId, tipo, cliente);
}
