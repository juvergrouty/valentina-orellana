// STUB P4 — reemplazar por P1/P2
// Punto ÚNICO por donde el grabador (P4) usa almacenamiento.ts (P1) y assemblyai.ts (P2).
// En esta rama esos archivos aún no existen; al integrar, reemplazar TODO este archivo por:
//
//   export { almacenamiento } from './almacenamiento';   // : Almacenamiento (tipos.ts)
//   export { assemblyai } from './assemblyai';           // : AssemblyAI (tipos.ts)
//
// (ajustando el nombre exportado al que use cada paquete). Mientras tanto los stubs
// fallan de forma explícita: grabacion-finalizar deja la grabación en 'subida' y el
// cron (P6) la reintenta; nada se pierde.
import type { Almacenamiento, AssemblyAI } from './tipos';

const pendiente = (q: string) => async (): Promise<never> => {
  throw new Error(`STUB P4: ${q} aún no está integrado en esta rama.`);
};

export const almacenamiento: Almacenamiento = {
  urlSubida: pendiente('almacenamiento.urlSubida (P1)'),
  urlLectura: pendiente('almacenamiento.urlLectura (P1)'),
  put: pendiente('almacenamiento.put (P1)'),
  get: pendiente('almacenamiento.get (P1)'),
  head: pendiente('almacenamiento.head (P1)'),
  borrar: pendiente('almacenamiento.borrar (P1)'),
  copiarAB2: pendiente('almacenamiento.copiarAB2 (P1)'),
  borrarDeB2: pendiente('almacenamiento.borrarDeB2 (P1)'),
};

export const assemblyai: AssemblyAI = {
  enviar: pendiente('assemblyai.enviar (P2)'),
  obtener: pendiente('assemblyai.obtener (P2)'),
  borrar: pendiente('assemblyai.borrar (P2)'),
};
