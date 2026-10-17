// Tipos y lector de los casos sintéticos de la prueba ciega Sonnet vs Haiku.
// Los guiones son texto inventado con líneas "[mm:ss] A: texto" (A, B, C = hablantes diarizados).
import type { Origen, PausaGrabacion, TramoTranscrito } from '../../tipos';
import type { Participante, Plantilla } from '../../resumen';

/** Lo que se espera del resumen (para la evaluación automática; no se manda al modelo). */
export interface EsperadoCaso {
  /** true si el resumen DEBE consignar al menos una mención de riesgo; false si no debería haber. */
  riesgo: boolean;
  /** Palabras del tramo que se pidió no registrar: no deben aparecer en el resumen. */
  terminosProhibidos: string[];
  /** Fragmentos que deberían aparecer en la sección "Tareas" (sin tildes ni mayúsculas importa). */
  tareas: string[];
  /** Sesión corta o administrativa: formato 40–100 palabras. */
  corta?: boolean;
  /** Qué mirar al comparar (se muestra en la página). */
  nota: string;
}

export interface CasoSintetico {
  clave: string;
  etiqueta: string;
  descripcion: string;
  plantilla: Plantilla;
  modalidad: Origen;
  fecha: string;
  duracionMin: number;
  participantes: Participante[];
  guion: string;
  /** Segundo en que termina el último tramo. */
  finSeg: number;
  pausas?: PausaGrabacion[];
  esperado: EsperadoCaso;
}

const RE_LINEA = /^\[(\d{1,2}):(\d{2})\]\s+([A-Z])\s*:\s*(.+)$/;

/** Guion → tramos como los de AssemblyAI (hablante 'A'/'B'/'C', fin = inicio del siguiente). */
export function tramosDeGuion(guion: string, finSeg: number): TramoTranscrito[] {
  const filas = guion.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = RE_LINEA.exec(l);
    if (!m) throw new Error(`Línea de guion inválida: ${l.slice(0, 40)}`);
    return { inicio_ms: (Number(m[1]) * 60 + Number(m[2])) * 1000, hablante: m[3], texto: m[4].trim() };
  });
  return filas.map((f, i) => ({
    ...f,
    fin_ms: Math.max(f.inicio_ms + 1000, i + 1 < filas.length ? filas[i + 1].inicio_ms : finSeg * 1000),
  }));
}
