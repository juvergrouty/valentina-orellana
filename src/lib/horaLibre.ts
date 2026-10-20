// Hora libre al agendar/reagendar desde el panel (Valentina, 20 oct 2026):
// "tengo que poder poner la hora que yo quiera" (ej. 7:53, no solo 7:45/7:50).
// El panel acepta cualquier minuto; si la hora queda fuera de su horario o se
// cruza con otra sesión, AVISA y ella decide (confirmación explícita).
// Funciones puras (sin base de datos) para poder probarlas.

/** "7:53", "07:53" o "07:53:00" → "07:53". null si no es una hora válida. */
export function normalizarHora(t: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(t ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export const aMinutos = (t: string) => { const [h, m] = t.slice(0, 5).split(':').map(Number); return h * 60 + m; };
export const deMinutos = (n: number) => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

export interface SesionDelDia { id: string; session_date?: string; session_time: string; duration_min: number | null; patient_name?: string | null }

/** Sesiones que se cruzan con una nueva de [hora, hora + duracion). La propia (al reagendar) no cuenta. */
export function sesionesQueSeCruzan(hora: string, duracion: number, sesiones: SesionDelDia[], excluirId?: string | null): SesionDelDia[] {
  const ini = aMinutos(hora);
  const fin = ini + (duracion > 0 ? duracion : 50);
  return sesiones.filter((s) => {
    if (excluirId && s.id === excluirId) return false;
    const si = aMinutos(s.session_time);
    return ini < si + (s.duration_min ?? 50) && fin > si;
  }).sort((a, b) => aMinutos(a.session_time) - aMinutos(b.session_time));
}

const fechaCorta = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}`;

/** Textos del aviso que ve Valentina antes de confirmar. Vacío = no hay nada que avisar. */
export function avisosHora(p: {
  hora: string;
  primeraFecha: string;
  fueraDeHorario: boolean | null; // null = no se pudo comprobar o no aplica (fecha pasada)
  cruces: SesionDelDia[];
}): string[] {
  const avisos: string[] = [];
  if (p.fueraDeHorario) {
    avisos.push(`Las ${p.hora} del ${fechaCorta(p.primeraFecha)} no es una de tus horas disponibles para este servicio (según tu horario, el descanso entre sesiones, bloqueos y Google Calendar).`);
  }
  for (const c of p.cruces) {
    const ini = c.session_time.slice(0, 5);
    const fin = deMinutos(aMinutos(ini) + (c.duration_min ?? 50));
    const quien = (c.patient_name ?? '').trim() || 'otra paciente';
    avisos.push(`Se cruza con la sesión de ${quien} (${ini}–${fin})${c.session_date ? ` el ${fechaCorta(c.session_date)}` : ''}.`);
  }
  return avisos;
}

// ── "Marcar como pagado" → boleta ────────────────────────────────────────────

/** ¿Corresponde emitir la boleta al marcar pagada? Monto > 0, no "Sin costo" y la casilla marcada. */
export function debeEmitirBoleta(p: { medio: string; casillaMarcada: boolean; monto: number | null | undefined }): boolean {
  if (p.medio === 'Sin costo') return false;
  if (!p.casillaMarcada) return false;
  return Number(p.monto ?? 0) > 0;
}

/** Resultado del envío "boleta" de la cola → parámetro de la página a la que vuelve el panel. */
export function avisoBoletaPanel(r: { ok: boolean; error?: string; nota?: string; descartada?: boolean } | null, folio: number | null): string {
  if (folio) return 'boleta=emitida';
  if (!r) return 'error=boleta_reintento&detail=' + encodeURIComponent('Quedó en la cola de envíos; se reintenta sola cada 5 minutos.');
  const motivo = r.ok ? (r.nota ?? '') : (r.error ?? '');
  // Errores que no se arreglan solos (piden revisar el SII o la configuración, o ya se agotaron los
  // reintentos): no se dice "se reintenta sola".
  if (!r.ok && /revisa en el sii|no configurado|agotaron|interrumpi/i.test(motivo)) {
    return 'error=boleta_failed&detail=' + encodeURIComponent(motivo.replace(/[.\s]+$/, ''));
  }
  if (r.ok && /rut/i.test(motivo)) {
    const falta = /falta el rut/i.test(motivo);
    return 'error=boleta_failed&detail=' + encodeURIComponent(falta
      ? 'falta el RUT de la paciente. Agrégalo en su ficha y emite la boleta desde la sesión'
      : `${motivo.replace(/[.\s]+$/, '')}. Revisa el RUT en su ficha y emite la boleta desde la sesión`);
  }
  if (r.ok && /programad|se emitir[aá]/i.test(motivo)) return 'boleta=programada';
  if (r.ok && !motivo) return 'boleta=emitida';
  if (r.ok) return 'error=boleta_failed&detail=' + encodeURIComponent(motivo);
  return 'error=boleta_reintento&detail=' + encodeURIComponent(motivo);
}

/** Pago marcado a mano en el panel ("Marcar como pagado": transferencia, efectivo…).
 *  Nombre del pago en la cola de envíos: "boleta#panel-<fecha de pago>". */
export const pagoDelPanel = (paidAt: string | null | undefined) => `panel-${Date.parse(String(paidAt ?? '')) || Date.now()}`;
export const esPagoDelPanel = (nombreTarea: string) => (nombreTarea.split('#')[1] ?? '').startsWith('panel-');

/** Sesiones que se cruzan en la agenda (ahora se pueden agendar a propósito): cada una en su
 *  carril, lado a lado, para que ninguna tape a otra. i = carril (0…n-1), n = carriles del grupo. */
export function carrilesDelDia(sesiones: { id: string; session_time: string; duration_min: number | null }[]): Map<string, { i: number; n: number }> {
  const orden = [...sesiones].sort((a, b) => aMinutos(a.session_time) - aMinutos(b.session_time));
  const res = new Map<string, { i: number; n: number }>();
  let grupo: { id: string; i: number }[] = [];
  let finesCarril: number[] = [];
  let finGrupo = -1;
  const cerrar = () => { for (const g of grupo) res.set(g.id, { i: g.i, n: finesCarril.length }); grupo = []; finesCarril = []; };
  for (const s of orden) {
    const ini = aMinutos(s.session_time);
    const fin = ini + (s.duration_min ?? 50);
    if (ini >= finGrupo) { cerrar(); finGrupo = -1; }
    let i = finesCarril.findIndex((f) => f <= ini);
    if (i === -1) { i = finesCarril.length; finesCarril.push(fin); } else finesCarril[i] = fin;
    grupo.push({ id: s.id, i });
    finGrupo = Math.max(finGrupo, fin);
  }
  cerrar();
  return res;
}
