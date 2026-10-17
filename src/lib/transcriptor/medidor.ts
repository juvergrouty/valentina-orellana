// Medidor de audio del grabador (grabar.astro). Funciones puras, con pruebas (medidor.test.ts).
//
// 17 oct 2026, primera prueba real con iPhone: con voz normal a 1–2 m solo se encendía 1 de 5 barras.
// La escala anterior, round((dB + 60) / 10), ponía 1 barra entre −55 y −45 dBFS, que es justo donde cae la
// voz conversacional a 1–2 m del micrófono del iPhone (sin supresión de ruido, con autoGainControl).
// Escala nueva: floor((dB + 72) / 9), de 0 a 5:
//   < −63 dBFS (ruido de fondo de una consulta)    → 0 barras
//   −63…−54                                        → 1
//   −54…−45  (voz normal a ~2 m)                   → 2
//   −45…−36  (voz normal a ~1 m)                   → 3
//   −36…−27  (voz cercana)                         → 4
//   ≥ −27    (voz cercana fuerte / muy cerca)      → 5
// Solo cambia lo que se VE. El umbral de silencio (RMS < 0,004 ≈ −48 dBFS durante 60 s) no se toca.

export const BARRAS_MEDIDOR = 5;

/** RMS lineal (0–1) → dBFS (−100 si es 0). */
export function dbDesdeRms(rms: number): number {
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

/** dBFS → barras encendidas (0–5). */
export function barrasDesdeDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(BARRAS_MEDIDOR, Math.floor((db + 72) / 9)));
}

/**
 * Suavizado solo para mostrar: sube al instante y baja ~6 dB por cada 100 ms (las barras no parpadean
 * entre sílabas). `dtMs` = tiempo desde el cuadro anterior.
 */
export function dbSuavizado(previo: number, actual: number, dtMs: number): number {
  const caida = previo - (6 * Math.max(0, dtMs)) / 100;
  return Math.max(actual, caida, -100);
}
