# Decisiones de Vale — 16 oct noche (MANDAN sobre 01 y todo lo anterior si chocan)

## A. Avisos de error: solo acciones que reparan
- Cada aviso tiene botón(es) que FUERZAN la solución (Reintentar, Reintentar resumen, Relanzar bot, Rehacer copia B2, Lanzar respaldo ahora, Volver a revisar, etc.). Todos deben funcionar de verdad (probados).
- SE ELIMINA "Marcar como resuelto": el aviso se cierra solo cuando el problema se arregla.
- Si un problema no tiene arreglo automático (p. ej. falta una llave), el botón es "Volver a revisar" (re-ejecuta el chequeo) y el texto dice exactamente qué hacer.
- El correo de respaldo también trae botones (enlaces) que llevan al panel y ejecutan la misma acción tras iniciar sesión (sin acciones por GET sin sesión; la página de aterrizaje pide confirmar con un toque y hace POST).

## B. Qué se guarda dónde (sitio liviano, todo externalizado)
- En la ficha del sitio (Supabase) SOLO el resumen de cada sesión, y solo de las ÚLTIMAS 4 sesiones de cada paciente. Lo anterior se mueve (cifrado) al almacenamiento externo (R2 + copia B2) y se trae al consultarlo.
- La transcripción completa: siempre externa (R2 cifrado + B2), nunca en el sitio.
- El resumen que exige Vale (sus indicaciones): 1) resumen de la sesión con los puntos más importantes que se hablaron; 2) tareas detectadas; 3) qué trabajar en la próxima sesión. Corto. (Los temas de riesgo se consignan de forma neutra dentro de los puntos importantes, primero, con minuto — sin clasificar ni alertar.)
- "Para revisar hoy": lo que quedó para la próxima sesión aparece ARRIBA en la ficha / notas del paciente cuando se abre en la sesión siguiente (desde el calendario o la agenda), sin tener que ir a la sesión anterior. Siempre.
- Modelo visual a seguir: el historial de Encuadrado (verificado en vivo 16 oct): línea de tiempo por sesión (fecha y hora, tipo de sesión, botón "Escribir evolución", bloque "Resumen IA" con ícono, "Ver más" para expandir), buscador por palabras clave, filtro, botón de descarga, y panel lateral de IA con sugerencias rápidas ("Generar resumen", etc.), campo "Escribe tu pregunta…" y la nota "La IA puede cometer errores…".
- Exportación legal: botón para descargar TODO lo de un paciente (consentimientos con anexos, notas de Vale, resúmenes, transcripciones completas, bitácora de accesos) completo, ordenado por fecha y estructurado (PDF legible + archivo de datos), para la normativa o un juicio. Exige passkey y queda en bitácora.
- Buscador / preguntas con IA: se mantiene.

## C. Borrado
- NO se puede borrar una transcripción (la ley exige conservar la ficha 15 años). Se elimina la función de supresión de transcripciones. El paciente puede pedir borrar el audio: el audio ya se borra siempre tras transcribir.
- (Se mantiene "excluir de las preguntas a la IA" si el paciente lo pide.)

## D. Parejas
- Siempre 2 consentimientos distintos, uno por persona.
- El de la persona agendada llega como hoy (link). El de la persona NO agendada lo llena Vale en consulta en la primera sesión: en el panel (iPhone/Mac), el paciente lee y firma en el dispositivo de Vale.
- El sistema sabe que es pareja porque la reserva lo dice (servicio de pareja; además el precio es distinto). No depende de lo que se elija en pantalla.

## E. Aviso de cambio de consentimiento (v2)
- Cuando se manda el correo con el aviso, se guarda una copia fiel de ese correo (archivo HTML/PDF con fecha, destinatario y huella) como ANEXO del consentimiento de esa persona, visible desde la ficha.

## F. Passkey
- Passkey/huella SOLO al entrar al panel (como Encuadrado). Una vez dentro, no se vuelve a pedir.
- Los resúmenes se ven SIEMPRE en la ficha (dentro de una sesión iniciada con passkey). Ver la transcripción completa puede pedir Face ID/huella (ok para Vale).
- Detener o pausar la grabación (por ejemplo por una llamada) NUNCA pide passkey para retomar.

## G. Robot de Meet
- Nombre: "Notas Ps. Valentina Orellana".
- Debe integrarse como participante "amigable" (no como bot externo tipo Fireflies). Investigar y proponer cómo (p. ej. cuenta de Google propia del robot invitada al evento para que entre sin pedir permiso, con foto/logo).
