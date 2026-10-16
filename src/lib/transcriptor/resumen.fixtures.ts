// Los 3 ejemplos sintéticos de 20-clinico.md §5 (datos 100 % inventados), como fixtures de prueba.
import type { TramoTranscrito } from './tipos';

/** "[hh:mm:ss] Hablante: texto" o "[hh:mm:ss] texto" → tramos (fin = inicio del siguiente). */
export function parsearFixture(texto: string): TramoTranscrito[] {
  const tramos: TramoTranscrito[] = [];
  for (const linea of texto.trim().split('\n')) {
    const m = /^\[(\d{2}):(\d{2}):(\d{2})\]\s+(?:([A-Za-zÁÉÍÓÚáéíóúÑñ]+):\s)?(.*)$/.exec(linea.trim());
    if (!m) continue;
    const ms = ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000;
    tramos.push({ inicio_ms: ms, fin_ms: ms, hablante: m[4] ?? '', texto: m[5] });
  }
  for (let i = 0; i < tramos.length; i++) tramos[i].fin_ms = tramos[i + 1]?.inicio_ms ?? tramos[i].inicio_ms + 5000;
  return tramos;
}

export const EJ1_TRANSCRIPCION = `
[00:01:10] Valentina: ¿Cómo estuvo la semana?
[00:01:14] Camila: Pesada. El lunes mi jefa me pidió el informe para el mismo día y me bloqueé. Me quedé hasta las once en la oficina.
[00:02:30] Valentina: ¿Qué pasó en el cuerpo cuando te lo pidió?
[00:02:35] Camila: Se me apretó el pecho, como que no podía pensar. Después en la casa no pude dormir, dormí como cuatro horas.
[00:09:50] Camila: Siento que si digo que no, me van a ver como floja. Siempre he sido la que puede con todo.
[00:12:05] Valentina: Te propongo que veamos qué pasaría si le dices a tu jefa cuándo sí puedes entregarlo.
[00:25:40] Camila: Igual el miércoles le dije que el otro informe lo tenía el viernes y no pasó nada.
[00:38:15] Valentina: Para esta semana, ¿te parece anotar cada vez que digas que sí a algo que no querías, y qué sentiste?
[00:38:30] Camila: Sí, lo anoto en el celular.
[00:47:00] Valentina: La próxima vez retomamos lo de "la que puede con todo", que quedó abierto.`;

export const EJ1_RESUMEN = `## Resumen automático (IA)
*Sesión individual · 3 oct 2026 · online · 50 min · Generado automáticamente a partir de la transcripción. No reemplaza el juicio clínico.*

### Temas tratados
- Sobrecarga y plazos en el trabajo.
- Dificultad para negarse a pedidos.

### Puntos clave
- Camila cuenta que el lunes su jefa le pidió un informe para el mismo día; dice que "se bloqueó" y se quedó hasta las 23:00 en la oficina.
- Relata opresión en el pecho y dificultad para pensar en ese momento; esa noche durmió alrededor de cuatro horas.
- Dice temer que, si se niega, la vean como "floja", y se describe como "la que puede con todo".
- Cuenta que el miércoles avisó que un informe estaría el viernes "y no pasó nada".

### En sus palabras
- «Siento que si digo que no, me van a ver como floja.» [09:50]
- «Siempre he sido la que puede con todo.» [09:50]

### Cambios y datos mencionados
- Sueño: durmió alrededor de cuatro horas la noche del lunes.

### Intervenciones de la terapeuta
- Preguntó por las sensaciones corporales en el momento del pedido.
- Propuso explorar qué pasaría si Camila indica a su jefa cuándo sí puede entregar.

### Tareas y acuerdos
- Camila: anotar en el celular cada vez que acepte algo que no quería y qué sintió — durante la semana.

### Para revisar la próxima sesión
- Retomar "la que puede con todo" (la terapeuta dijo que quedó abierto).
- Revisar el registro de la semana.`;

export const EJ2_TRANSCRIPCION = `
[00:00:40] A: Bueno, ¿cómo llegaron hoy?
[00:00:45] B: Mal. Otra vez discutimos por la casa. Yo llego a las siete y Diego está en el sillón.
[00:01:20] C: Yo trabajo desde las seis de la mañana, Javi. Llego muerto.
[00:03:10] A: Diego, ¿qué te pasa cuando Javiera dice eso?
[00:03:15] C: Siento que nunca es suficiente lo que hago. El fin de semana cociné los dos días.
[00:04:02] B: Es que no se trata de cocinar el fin de semana, se trata de que yo tengo que acordarme de todo.
[00:18:30] A: Les propongo hacer juntos una lista de lo que hay que hacer en la casa, incluido lo que "hay que acordarse".
[00:31:00] B: Eso me sirvió, ver la lista. Nunca lo había visto escrito.
[00:31:10] C: A mí también, no tenía idea de que lo del pediatra lo hacía ella siempre.
[00:52:20] A: Para la próxima semana, cada uno elige dos cosas de la lista de las que se hace cargo completo, incluido acordarse.
[00:52:40] C: Yo elijo [inaudible] y las compras.
[00:58:00] A: La próxima vez vemos cómo les fue y lo de los horarios, que no alcanzamos.`;

/** Extracto de lo crítico (20-clinico §5, ejemplo 2) + una sección "En sus palabras" con citas reales. */
export const EJ2_RESUMEN = `### Temas tratados
- Distribución de las tareas del hogar y de la "carga de acordarse".
- Horarios laborales de ambos (quedó pendiente).

### Perspectiva de Javiera
- Cuenta que discutieron nuevamente por las tareas de la casa; dice que llega a las 19:00 y encuentra a Diego en el sillón.
- Plantea que el tema no es cocinar el fin de semana sino que ella "tiene que acordarse de todo".
- Dice que ver la lista escrita le sirvió.

### Perspectiva de Diego
- Cuenta que trabaja desde las 6:00 y llega "muerto".
- Dice sentir que "nunca es suficiente" lo que hace; menciona que cocinó ambos días del fin de semana.
- Dice que no sabía que ella se encargaba siempre de lo del pediatra.

### En sus palabras
- Javiera: «se trata de que yo tengo que acordarme de todo» [04:02]
- Diego: «Siento que nunca es suficiente lo que hago.» [03:15]

### Momentos de la interacción
- Tras construir la lista en sesión, ambos dijeron que verla escrita les sirvió [31:00–31:10].

### Tareas y acuerdos
- De la pareja: cada uno elige dos tareas de la lista de las que se hace cargo completo, incluido acordarse — próxima semana.
- Diego: las compras y una segunda tarea que no se entiende en la transcripción [52:40].
- Javiera: no consta en la transcripción qué tareas eligió.

### Para revisar la próxima sesión
- Cómo les fue con las tareas elegidas.
- Horarios (la terapeuta dijo que no alcanzaron).

### Calidad de la transcripción
- Hablantes inferidos: A = terapeuta (dirige preguntas y propone ejercicios), B = Javiera (Diego le dice "Javi"), C = Diego (la terapeuta se dirige a él por nombre y él responde).
- [52:40] tramo inaudible en la tarea elegida por Diego.`;

export const EJ3_TRANSCRIPCION = `
[00:02:00] ¿Cómo has estado desde la última vez?
[00:02:05] Igual nomás. Desde que se fue la Fran no tengo ganas de nada.
[00:15:40] A veces pienso que sería más fácil no despertar. No es que vaya a hacer algo, pero lo pienso.
[00:15:55] ¿Desde cuándo lo piensas? ¿Has pensado en cómo?
[00:16:05] Hace como dos semanas. No, en cómo no.
[00:16:20] ¿Con quién cuentas si eso se pone más fuerte?
[00:16:25] Con mi hermano, supongo.
[00:33:10] Tengo guardadas las pastillas que me dio el doctor el año pasado, las [inaudible].
[00:45:00] Quedamos en que si se pone más fuerte llamas a tu hermano o al *4141, y nos vemos el jueves.`;

/**
 * Ejemplo 3 reescrito según 01-decisiones-16oct (Atención neutra: sin prioridad, sin evaluación).
 * Las citas son las del ejemplo original de 20-clinico §5.
 */
export const EJ3_RESUMEN = `## Resumen automático (IA)
*Sesión individual · 10 oct 2026 · presencial · 50 min · Generado automáticamente a partir de la transcripción. No reemplaza el juicio clínico.*

### Atención
- Se habló de ideas de no despertar — Dicho por: Tomás (inferido) — [15:40]
  «A veces pienso que sería más fácil no despertar. No es que vaya a hacer algo, pero lo pienso.»
- Se habló de pastillas guardadas — Dicho por: Tomás (inferido) — [33:10]
  «Tengo guardadas las pastillas que me dio el doctor el año pasado, las [inaudible].»
_Mención consignada automáticamente. No es una evaluación de riesgo; revisar la transcripción completa._

### Temas tratados
- Ánimo desde la separación de "la Fran".

### Tareas y acuerdos
- Tomás: si "se pone más fuerte", llamar a su hermano o al *4141 — hasta la próxima sesión.
- Próxima sesión: jueves.

### Calidad de la transcripción
- La transcripción no identifica hablantes; la asignación terapeuta/paciente fue inferida por el contenido (preguntas y acuerdos vs. relato).
- [33:10] nombre del medicamento inaudible.`;
