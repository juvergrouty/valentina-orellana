// Textos aprobados por Vale (18 nov 2026) para los seguimientos automáticos. Puro: sin base de datos.
// Si cambia un texto aquí, cambia también su plantilla de WhatsApp (hay que volver a enviarla a
// aprobación de Meta con otro nombre: Meta no deja editar una plantilla aprobada sin revisarla de nuevo).

export type Paso = '1A' | '1B' | '2A' | '3A' | '4A';

export type DatosTexto = { nombre: string; fecha?: string; enlace?: string };

const hola = (nombre: string) => (nombre ? `Hola ${nombre}` : 'Hola');

/** Texto de WhatsApp (texto libre, dentro de la ventana de 24 horas). */
export function textoWhatsapp(paso: Paso, d: DatosTexto): string {
  switch (paso) {
    case '1A': return `${hola(d.nombre)}, ¿cómo estás? Cuéntame qué días y horarios te acomodan, y coordinamos tu primera sesión.`;
    case '1B': return `${hola(d.nombre)}, si todavía quieres empezar, me escribes con los días que te sirven y lo vemos.`;
    case '2A': return `${hola(d.nombre)}, ¿cómo vas? Cuéntame qué días y horarios te acomodan para tu próxima sesión.`;
    case '3A': return `${hola(d.nombre)}, ¿cómo has estado? Pasó un tiempo desde nuestra última sesión y quería saber de ti. Si quieres retomar, me escribes y coordinamos.`;
    case '4A': return `${hola(d.nombre)}, ¿cómo estás? La sesión del ${d.fecha} me aparece pendiente de pago. Si ya la pagaste, avísame y lo reviso. Te dejo el enlace: ${d.enlace}`;
  }
}

export const FIRMA_SEGUIMIENTO = 'Valentina Orellana, Psicóloga';

/** Correo: asunto y párrafos (el cierre "Un abrazo," + firma lo agrega email.ts). */
export function correoSeguimiento(paso: Paso, d: DatosTexto): { asunto: string; saludo: string; parrafos: string[] } {
  const saludo = `${hola(d.nombre)}:`;
  switch (paso) {
    case '1A': return { asunto: 'Tu primera sesión con Valentina Orellana', saludo, parrafos: ['Te escribo para saber si todavía quieres empezar terapia. Cuéntame qué días y horarios te acomodan y coordinamos tu primera sesión.'] };
    case '1B': return { asunto: 'Seguimos en contacto', saludo, parrafos: ['Si todavía quieres empezar, me escribes con los días que te sirven y lo vemos.'] };
    case '2A': return { asunto: 'Tu próxima sesión', saludo, parrafos: ['¿Cómo vas? Cuéntame qué días y horarios te acomodan para tu próxima sesión.'] };
    case '3A': return { asunto: 'Quería saber de ti', saludo, parrafos: ['¿Cómo has estado? Pasó un tiempo desde nuestra última sesión y quería saber de ti. Si quieres retomar, me escribes y coordinamos.'] };
    case '4A': return { asunto: 'Sesión pendiente de pago', saludo, parrafos: [`¿Cómo estás? La sesión del ${d.fecha} me aparece pendiente de pago. Si ya la pagaste, avísame y lo reviso.`, `Te dejo el enlace: ${d.enlace}`] };
  }
}

/** Texto plano completo del correo (versión de texto del correo y vista previa del panel). */
export function correoTextoPlano(paso: Paso, d: DatosTexto): string {
  const c = correoSeguimiento(paso, d);
  return `${c.saludo}\n${c.parrafos.join('\n')}\nUn abrazo,\n${FIRMA_SEGUIMIENTO}`;
}

// ─── Plantillas de WhatsApp (fuera de la ventana de 24 horas) ────────────────
// Categorías según las reglas de Meta: invitar a empezar terapia o a retomar es MARKETING; coordinar
// la próxima sesión de una paciente y avisar un pago pendiente de una sesión ya hecha es UTILITY
// (Meta puede recategorizar una UTILITY como MARKETING al aprobarla). Meta no acepta una plantilla
// que termine en una variable: por eso la 4A lleva la firma al final.
export type PlantillaSeguimiento = {
  paso: Paso;
  nombre: string;
  categoria: 'MARKETING' | 'UTILITY';
  cuerpo: string;
  ejemplo: string[];
};

export const IDIOMA_PLANTILLAS = 'es';

export const PLANTILLAS: PlantillaSeguimiento[] = [
  { paso: '1A', nombre: 'seguimiento_consulta_1a', categoria: 'MARKETING', cuerpo: 'Hola {{1}}, ¿cómo estás? Cuéntame qué días y horarios te acomodan, y coordinamos tu primera sesión.', ejemplo: ['Camila'] },
  { paso: '1B', nombre: 'seguimiento_consulta_1b', categoria: 'MARKETING', cuerpo: 'Hola {{1}}, si todavía quieres empezar, me escribes con los días que te sirven y lo vemos.', ejemplo: ['Camila'] },
  { paso: '2A', nombre: 'seguimiento_proxima_sesion_2a', categoria: 'UTILITY', cuerpo: 'Hola {{1}}, ¿cómo vas? Cuéntame qué días y horarios te acomodan para tu próxima sesión.', ejemplo: ['Camila'] },
  { paso: '3A', nombre: 'seguimiento_retomar_3a', categoria: 'MARKETING', cuerpo: 'Hola {{1}}, ¿cómo has estado? Pasó un tiempo desde nuestra última sesión y quería saber de ti. Si quieres retomar, me escribes y coordinamos.', ejemplo: ['Camila'] },
  { paso: '4A', nombre: 'seguimiento_pago_pendiente_4a', categoria: 'UTILITY', cuerpo: 'Hola {{1}}, ¿cómo estás? La sesión del {{2}} me aparece pendiente de pago. Si ya la pagaste, avísame y lo reviso. Te dejo el enlace: {{3}}\n\nValentina Orellana, Psicóloga', ejemplo: ['Camila', 'martes 17 de noviembre', 'https://www.valentinaorellana.cl/pagar/ejemplo'] },
];

export const plantillaDe = (paso: Paso) => PLANTILLAS.find((p) => p.paso === paso)!;

/** Variables de la plantilla, en orden. */
export function variablesPlantilla(paso: Paso, d: DatosTexto): string[] {
  // Meta no acepta variables vacías: sin nombre no se usa la plantilla (quien llama lo revisa).
  return paso === '4A' ? [d.nombre, d.fecha ?? '', d.enlace ?? ''] : [d.nombre];
}

export const NOMBRE_PASO: Record<Paso, string> = {
  '1A': 'Consulta nueva: primer seguimiento',
  '1B': 'Consulta nueva: segundo seguimiento',
  '2A': 'Paciente sin próxima hora',
  '3A': 'Paciente en pausa (aprobado por ti)',
  '4A': 'Sesión pendiente de pago',
};
