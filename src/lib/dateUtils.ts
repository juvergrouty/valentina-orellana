/**
 * Utilidades de fecha/hora en la zona horaria de Chile (America/Santiago).
 *
 * BUG QUE ESTO CORRIGE:
 * El servidor (funciones serverless de Vercel) corre con huso horario del
 * sistema en UTC. Todo el código que calculaba "hoy" con
 * `new Date().toISOString().slice(0, 10)` en realidad obtenía la fecha en
 * UTC, no en Chile. Como Chile va 3-4 horas detrás de UTC, durante la tarde/
 * noche (aprox. desde las 20:00-21:00 hora de Chile en adelante) el sitio ya
 * había "cruzado la medianoche" en UTC y mostraba el día siguiente como si
 * fuera hoy — esto afectaba el panel de administración (agenda, dashboard,
 * finanzas, reportes), la disponibilidad de horas para pacientes, la fecha
 * de emisión de boletas, y los cron jobs de recordatorio/reseña.
 *
 * `nowCL()` devuelve un objeto Date cuyo instante interno coincide
 * numéricamente con la hora de pared de Chile, de modo que todo el código
 * que ya usa getters/métodos "locales" (getDate, getDay, getHours, setHours,
 * setDate, toISOString().slice(0,10), etc.) siga funcionando exactamente
 * igual que antes — solo que ahora con la fecha correcta — siempre que el
 * runtime del servidor use UTC como huso horario del sistema (comportamiento
 * por defecto de las funciones serverless de Vercel, y consistente con el
 * bug que se observaba).
 */

export const CHILE_TZ = 'America/Santiago';

/** Devuelve un Date "de pared" de Chile a partir de un instante real (por defecto, ahora). */
export function nowCL(base: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHILE_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(base);
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  let hour = v('hour');
  if (hour === 24) hour = 0; // algunos entornos devuelven "24" en vez de "00"
  return new Date(v('year'), v('month') - 1, v('day'), hour, v('minute'), v('second'));
}

/** "YYYY-MM-DD" de hoy en Chile. */
export function todayCL(base: Date = new Date()): string {
  return nowCL(base).toISOString().slice(0, 10);
}

/** Horas desde ahora hasta el inicio de una sesión (session_date + session_time,
 *  ambos en hora de Chile). Negativo si la sesión ya pasó. */
export function hoursUntilSessionCL(sessionDate: string, sessionTime: string): number {
  const [y, m, d] = sessionDate.split('-').map(Number);
  const [hh, mm]  = (sessionTime ?? '00:00').slice(0, 5).split(':').map(Number);
  const sessionMs = new Date(y, (m ?? 1) - 1, d, hh || 0, mm || 0, 0).getTime();
  return (sessionMs - nowCL().getTime()) / (1000 * 60 * 60);
}
