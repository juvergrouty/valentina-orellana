// Preselección del grabador (/admin/grabar) según cómo se llegó a la página:
//   ?sesion=<bookingId> (o ?booking=)  → esa reserva del sitio (botón Grabar del calendario).
//   ?evento=<googleEventId>            → ese evento de Google Calendar / Encuadrado (calendario).
//   ?paciente=<patientId>              → botón "Grabar sesión" de la ficha: su sesión de hoy si
//                                         tiene una que no haya terminado; si no, "grabar sin
//                                         reserva" para ese paciente (fuente 'ficha').
// Solo elige qué mostrar: el consentimiento lo sigue bloqueando el servidor (grabacion-iniciar).

export interface Elegible {
  clave: string;
  bookingId: string | null;
  googleEventId: string | null;
  patientId: string | null;
  faltaMin: number;
  dur: number;
}

export interface Pedido { sesion?: string | null; evento?: string | null; paciente?: string | null }

export type Preseleccion =
  | { modo: 'sesion'; clave: string }
  | { modo: 'ficha'; patientId: string }
  | null;

/**
 * @param cands candidatas de hoy ordenadas por hora.
 * @param aliasEvento eventos de Google descartados por ser duplicados de otra candidata (misma
 *   persona el mismo día, p. ej. Encuadrado + reserva del sitio): id del evento → clave de la
 *   candidata que quedó.
 */
export function preseleccion(cands: Elegible[], pedido: Pedido, aliasEvento: Record<string, string> = {}): Preseleccion {
  const sesion = (pedido.sesion ?? '').trim();
  const evento = (pedido.evento ?? '').trim();
  const paciente = (pedido.paciente ?? '').trim();
  if (sesion) {
    const c = cands.find((x) => x.bookingId === sesion);
    if (c) return { modo: 'sesion', clave: c.clave };
  }
  if (evento) {
    const alias = Object.prototype.hasOwnProperty.call(aliasEvento, evento) ? aliasEvento[evento] : null;
    const c = cands.find((x) => x.googleEventId === evento) ?? (alias ? cands.find((x) => x.clave === alias) : undefined);
    if (c) return { modo: 'sesion', clave: c.clave };
  }
  if (paciente) {
    // La primera de hoy que no haya terminado (en curso o la próxima).
    const c = cands.find((x) => x.patientId === paciente && x.faltaMin > -x.dur);
    if (c) return { modo: 'sesion', clave: c.clave };
    return { modo: 'ficha', patientId: paciente };
  }
  return null;
}
