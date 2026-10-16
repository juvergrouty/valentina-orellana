// Transcriptor IA — avisos INMEDIATOS de los problemas del robot de Meet (t-n-pulido).
// Antes quedaban solo en la bitácora y había que esperar al chequeo diario. Ahora, en el mismo
// momento en que el robot (bot-evento.ts → bot.ts) o el lanzamiento informan el problema, se crea el
// aviso con su acción reparadora (accionesAlerta.ts):
//   • robot_sin_sesion / robot_sesion_vencida → clave 'robot:sesion' (uno solo para los dos; se
//     arregla igual: volver a iniciar sesión en la cuenta del robot, 85-robot-meet §7.3). Acción:
//     "Volver a revisar" (se cierra si la sesión vuelve a estar vigente o el modo es 'invitado').
//     Se cierra solo al subir una sesión nueva (procesarSesionInicial) o al pasar a modo invitado.
//   • robot_no_invitado → clave 'robot-invitado:<grabación>' (informativo: el robot pide unirse y
//     Vale lo admite). Se cierra solo cuando el robot entra a grabar.
//   • evento 'error' del robot → 'bot-error:<grabación>:<paso>' con el paso en que estaba
//     (bot_lanzando / bot_en_lobby / grabando). Se cierra solo cuando la sesión pasa ese paso
//     (llega a la sala, entra a grabar o el audio queda subido); si la sesión cae en error, el aviso
//     ofrece la acción que corresponde (Reintentar / "Cerrar con lo grabado").
// Sin datos clínicos ni de pacientes: solo el tipo de problema y el texto saneado del robot.
import type { NuevaAlerta } from './alertas';
import type { EstadoGrabacion } from './tipos';

export const CLAVE_ROBOT_SESION = 'robot:sesion';
export const PREFIJO_ROBOT_INVITADO = 'robot-invitado:';
export const PREFIJO_BOT_ERROR = 'bot-error:';

export type AvisoRobot = 'robot_sin_sesion' | 'robot_sesion_vencida' | 'robot_no_invitado';

export const PASOS_RELOGIN = 'Vuelve a iniciar sesión en la cuenta del robot (docs/transcriptor/85-robot-meet.md §7.3; con Claude, unos 5 minutos).';

/** Motivos de pide_sesion que SÍ son un problema de la sesión (ocupada/carrera = otro bot la usa en ese momento). */
export const esMotivoSinSesion = (motivo: string | null | undefined) => motivo === 'sin_sesion' || motivo === 'dañada' || motivo == null;

export function alertaDeAvisoRobot(aviso: AvisoRobot, extra: { grabacionId?: string | null; motivo?: string | null } = {}): NuevaAlerta {
  const motivo = extra.motivo ? ` (Google: ${String(extra.motivo).slice(0, 120)})` : '';
  switch (aviso) {
    case 'robot_sin_sesion':
      return {
        tipo: 'bot', clave: CLAVE_ROBOT_SESION, accion: 'revisar',
        titulo: 'El robot de Meet no tiene su sesión de Google',
        detalle: `El robot "Notas Ps. Valentina Orellana" está en modo cuenta pero no tiene una sesión vigente, así que entra como invitado y tú lo admites en Meet. ${PASOS_RELOGIN}`,
      };
    case 'robot_sesion_vencida':
      return {
        tipo: 'bot', clave: CLAVE_ROBOT_SESION, accion: 'revisar',
        titulo: 'Venció la sesión de Google del robot de Meet',
        detalle: `Google pidió iniciar sesión de nuevo en la cuenta del robot${motivo}. Mientras tanto entra como invitado y tú lo admites en Meet. ${PASOS_RELOGIN}`,
      };
    case 'robot_no_invitado':
      return {
        tipo: 'bot', clave: `${PREFIJO_ROBOT_INVITADO}${extra.grabacionId ?? 'sin-sesion'}`, grabacionId: extra.grabacionId ?? null, accion: 'revisar',
        titulo: 'El robot no quedó como invitado de la reunión',
        detalle: 'No se pudo agregar al robot como invitado del evento (por ejemplo, un evento que no organizas tú, como los de Encuadrado). Pedirá unirse: admítelo en Meet.',
      };
  }
}

/** Paso de la grabación al que se asocia un error del robot (el aviso se cierra cuando lo pasa). */
export function pasoDeErrorBot(estado: EstadoGrabacion): 'bot_lanzando' | 'bot_en_lobby' | 'grabando' {
  return estado === 'bot_lanzando' || estado === 'bot_en_lobby' ? estado : 'grabando';
}

/** Aviso para un evento 'error' del robot. `estado` = estado de la grabación al recibirlo. */
export function alertaDeErrorBot(grabacionId: string, estado: EstadoGrabacion, detalle: string): NuevaAlerta {
  const paso = pasoDeErrorBot(estado);
  return {
    tipo: 'bot',
    clave: `${PREFIJO_BOT_ERROR}${grabacionId}:${paso}`,
    grabacionId,
    accion: 'revisar',
    titulo: paso === 'grabando' ? 'El asistente de notas tuvo un problema durante la sesión' : 'El asistente de notas no pudo entrar bien a Meet',
    detalle: `El robot informó: ${detalle}`,
  };
}
