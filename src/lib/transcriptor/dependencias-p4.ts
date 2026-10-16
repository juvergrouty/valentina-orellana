// Punto único por donde el grabador (P4) y el orquestador (P6) usan las implementaciones
// reales de almacenamiento.ts (P1) y assemblyai.ts (P2). Integrado por P6 (16 oct 2026).
//
// El cliente de AssemblyAI se crea en el primer uso: así importar este módulo no exige las
// variables de entorno (build, pruebas) y, si faltan en Vercel, el error aparece recién al
// enviar (grabacion-finalizar deja la grabación en 'subida' y el cron reintenta).
import type { AssemblyAI } from './tipos';
import { assemblyAIDesdeEnv } from './assemblyai';

export { almacenamiento } from './almacenamiento';

let cliente: AssemblyAI | null = null;
const aai = (): AssemblyAI => (cliente ??= assemblyAIDesdeEnv());

export const assemblyai: AssemblyAI = {
  enviar: (p) => aai().enviar(p),
  obtener: (id) => aai().obtener(id),
  borrar: (id) => aai().borrar(id),
};
