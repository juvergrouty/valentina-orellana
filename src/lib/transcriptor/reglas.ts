// Regla FIJA del sitio para elegir el modelo de transcripción (00-decisiones.md).
// No la decide una IA ni un ajuste: es código, con pruebas de tabla (reglas.test.ts).
//   pareja                → universal-3-5-pro (+ diarización solo si es presencial)
//   individual / sin tipo → universal-2
//   "Lugar con ruido"     → universal-3-5-pro (modelo robusto)
//   online                → nunca diarización pagada (el bot sabe quién habla)
import {
  MODELO_U2, MODELO_U35_PRO,
  type DecisionModelo, type EntradaModelo, type Origen, type TipoSesion,
} from './tipos';

const TIPOS: readonly TipoSesion[] = ['individual', 'pareja', 'sin_tipo'];
const ORIGENES: readonly Origen[] = ['presencial', 'online'];

/** bookings.session_type → tipo. 'pareja-online'/'pareja-presencial' (y el antiguo 'pareja') → pareja. */
export function tipoDesdeSessionType(sessionType: string | null | undefined): TipoSesion {
  const st = (sessionType ?? '').trim().toLowerCase();
  if (!st) return 'sin_tipo';
  if (st.startsWith('pareja')) return 'pareja';
  if (st === 'online' || st === 'presencial') return 'individual';
  return 'sin_tipo';
}

/** bookings.session_type → origen (misma convención que syncCalendar: contiene 'online' ⇒ online). */
export function origenDesdeSessionType(sessionType: string | null | undefined): Origen | null {
  const st = (sessionType ?? '').trim().toLowerCase();
  if (!st) return null;
  return st.includes('online') ? 'online' : 'presencial';
}

export function elegirModelo(entrada: EntradaModelo): DecisionModelo {
  const { tipo, origen, lugarConRuido } = entrada;
  if (!TIPOS.includes(tipo)) throw new Error(`Tipo de sesión desconocido: ${String(tipo)}`);
  if (!ORIGENES.includes(origen)) throw new Error(`Origen desconocido: ${String(origen)}`);
  if (typeof lugarConRuido !== 'boolean') throw new Error('lugarConRuido debe ser booleano');

  if (tipo === 'pareja') {
    const diarizacion = origen === 'presencial';
    return {
      modelo: MODELO_U35_PRO,
      diarizacion,
      hablantesEsperados: diarizacion ? 3 : null,
      motivo: diarizacion
        ? 'Pareja presencial: Universal-3.5 Pro con separación de hablantes.'
        : 'Pareja online: Universal-3.5 Pro; los hablantes salen de Meet (sin diarización pagada).',
    };
  }

  if (lugarConRuido) {
    return {
      modelo: MODELO_U35_PRO,
      diarizacion: false,
      hablantesEsperados: null,
      motivo: 'Lugar con ruido: modelo robusto Universal-3.5 Pro.',
    };
  }

  return {
    modelo: MODELO_U2,
    diarizacion: false,
    hablantesEsperados: null,
    motivo: tipo === 'individual' ? 'Sesión individual: Universal-2.' : 'Sesión sin tipo: Universal-2.',
  };
}
