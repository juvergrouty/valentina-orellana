// Regla FIJA del sitio para elegir el modelo de transcripción (00-decisiones.md).
// No la decide una IA ni un ajuste: es código, con pruebas de tabla (reglas.test.ts).
//   pareja                → universal-3-5-pro
//   individual / sin tipo → universal-2
//   "Lugar con ruido"     → universal-3-5-pro (modelo robusto)
//   presencial            → SIEMPRE diarización (speaker_labels): 3 hablantes en pareja, 2 en individual,
//                           sin número fijo en "sin tipo" (podría ser pareja). +US$0,02/h (17 oct 2026: la
//                           primera prueba real individual salió en un solo bloque "sin separar hablantes").
//   online individual     → sin diarización pagada (el bot sabe quién habla por los recuadros de Meet)
//   online pareja         → diarización (3 voces): la pareja suele compartir un recuadro; se combina con
//                           la línea del bot (hablantes.ts → separarRecuadroCompartido). 17 oct 2026.
// AssemblyAI (verificado 17 oct 2026): speaker_labels/speakers_expected funcionan con universal-3-5-pro y
// universal-2 (https://www.assemblyai.com/docs/pre-recorded-audio/speaker-diarization); diarización async
// estándar +US$0,02/h en ambos (https://www.assemblyai.com/llms/pricing.md).
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

  // Pareja online: es común que los dos estén frente al MISMO dispositivo (un solo recuadro en Meet), y la
  // línea del bot no los distingue → también diarización (3 voces), combinada con la línea (hablantes.ts).
  const diarizacion = origen === 'presencial' || tipo === 'pareja';
  const hablantesEsperados = !diarizacion ? null : tipo === 'pareja' ? 3 : tipo === 'individual' ? 2 : null;
  const conHablantes = diarizacion
    ? hablantesEsperados ? ` con separación de ${hablantesEsperados} hablantes` : ' con separación de hablantes'
    : '';

  if (tipo === 'pareja') {
    return {
      modelo: MODELO_U35_PRO,
      diarizacion,
      hablantesEsperados,
      motivo: origen === 'presencial'
        ? `Pareja presencial: Universal-3.5 Pro${conHablantes}.`
        : `Pareja online: Universal-3.5 Pro${conHablantes}, combinada con los recuadros de Meet (pueden compartir uno).`,
    };
  }

  const sufijoOnline = origen === 'online' ? ' (online: los hablantes salen de Meet)' : '';
  if (lugarConRuido) {
    return {
      modelo: MODELO_U35_PRO,
      diarizacion,
      hablantesEsperados,
      motivo: `Lugar con ruido: modelo robusto Universal-3.5 Pro${conHablantes}${sufijoOnline}.`,
    };
  }

  return {
    modelo: MODELO_U2,
    diarizacion,
    hablantesEsperados,
    motivo: `${tipo === 'individual' ? 'Sesión individual' : 'Sesión sin tipo'}: Universal-2${conHablantes}${sufijoOnline}.`,
  };
}
