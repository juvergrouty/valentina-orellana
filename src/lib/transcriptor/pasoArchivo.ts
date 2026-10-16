// Transcriptor IA — paso 'archivo' del orquestador (02-decisiones-16oct-noche, B: sitio liviano).
// pipeline.ts lo llama en cada corrida (una línea, import dinámico). La lógica y las pruebas están en
// archivo.ts; aquí solo se adaptan las dependencias del orquestador:
//   • db y cifrado: los mismos del pipeline (en pruebas, Supabase en memoria y KEK de prueba);
//   • almacenamiento: el del pipeline si trae guardarCifrado/leerCifrado/copiarAB2/borrar (producción:
//     dependencias-p4 entrega el completo); si no, archivo.ts carga el de producción SOLO si hay algo
//     que archivar (las pruebas del pipeline nunca llegan a R2).
import type { DepsPipeline } from './pipeline';
import { archivarAntiguos, type AlmArchivo } from './archivo';

function almacenamientoDe(deps: Pick<DepsPipeline, 'almacenamiento'>): AlmArchivo | undefined {
  const a = deps.almacenamiento as Partial<AlmArchivo> | undefined;
  return a && typeof a.guardarCifrado === 'function' && typeof a.leerCifrado === 'function'
    && typeof a.copiarAB2 === 'function' && typeof a.borrar === 'function'
    ? (a as AlmArchivo)
    : undefined;
}

export async function pasoArchivo(deps: Pick<DepsPipeline, 'db' | 'almacenamiento' | 'cifrado'>, ahora: Date): Promise<number> {
  return archivarAntiguos({ db: deps.db, almacenamiento: almacenamientoDe(deps), cifrado: deps.cifrado, ahora: () => ahora });
}
