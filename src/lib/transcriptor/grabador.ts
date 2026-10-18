// Lógica pura del grabador presencial (src/pages/admin/grabar.astro), con pruebas (grabador.test.ts).
// Auditoría del 17 oct 2026 (rama audit-presencial).

/** RMS bajo el cual un cuadro cuenta como silencio (≈ −48 dBFS). Mismo valor que tenía bucle(). */
export const UMBRAL_SILENCIO_RMS = 0.004;

/**
 * ¿Este cuadro del medidor cuenta para el aviso "No se escucha nada hace 1 minuto"?
 * Solo si el medidor está midiendo de verdad: hay fuente conectada Y el AudioContext está 'running'.
 * En iOS el AudioContext puede quedar 'suspended' o 'interrupted' (sin toque, tras una llamada) mientras
 * MediaRecorder graba bien; ahí el analizador entrega ceros y el aviso sería una falsa alarma en plena
 * sesión (la página ya acepta que "el medidor puede fallar en iOS aunque la grabación funcione").
 */
export function cuentaComoSilencio(rms: number, hayFuente: boolean, estadoAudio: string | null | undefined): boolean {
  return hayFuente && estadoAudio === 'running' && rms < UMBRAL_SILENCIO_RMS;
}

interface SegFin { inicioMs: number; finMs: number | null }

/**
 * Hora de término que se informa al servidor (grabaciones.fin_at): la de "Mantén para terminar"; si Safari
 * se cerró grabando (grabación abandonada que se sube después), el fin del último segmento con audio, NO la
 * hora de la subida (que puede ser horas después y falsea el tiempo "fin de sesión → resumen listo").
 */
export function finGrabacionMs(g: { inicioMs: number; finMs: number | null; segmentos: SegFin[] }): number {
  if (typeof g.finMs === 'number') return g.finMs;
  return g.segmentos.reduce((a, s) => Math.max(a, s.finMs ?? s.inicioMs), g.inicioMs);
}
