// Caso sintético para la prueba ciega Sonnet vs Haiku (/admin/transcriptor/comparar).
// TODO INVENTADO: no corresponde a ninguna persona ni sesión real. Imita una transcripción
// automática de una sesión de pareja online de ~22 min, diarizada sin nombres (A = terapeuta,
// B y C = la pareja; el modelo debe inferir quién es quién por el contenido). Incluye
// muletillas, voces superpuestas, palabras mal reconocidas ("cumpleaño", "haiga") y una
// línea con el hablante cruzado.
// Contiene: dos versiones contrapuestas del mismo episodio (el cumpleaños del sábado), tareas
// por persona y un momento tenso (~11:30–13:10) en que uno dice que se va a desconectar.
import type { CasoSintetico } from './tipos';

const GUION = `
[00:03] A: Hola, hola. ¿Me escuchan bien? Diego, Carla.
[00:07] B: Sí, te escuchamos. Hola.
[00:09] C: Hola Valentina. Espera que subo el volumen. Ya.
[00:14] A: Perfecto. ¿Cómo han estado desde la última sesión?
[00:18] C: Eh… ¿parto yo? Mal. Esta semana estuvo mal. Tuvimos una pelea grande el sábado.
[00:25] B: Bueno, "grande". Fue una discusión.
[00:28] C: Fue una pelea, Diego. Me fui a dormir donde mi hermana.
[00:32] B: Ya, ya, fue una pelea.
[00:35] A: Ok. Me gustaría escuchar a los dos. ¿Les parece si cada uno me cuenta cómo lo vivió, y el otro escucha sin interrumpir? Después el otro cuenta lo suyo.
[00:46] C: Ya, me parece.
[00:48] B: Ya.
[00:50] A: Carla, ¿quieres partir tú?
[00:53] C: Ya. El sábado era el cumpleaño de mi mamá, setenta años, una cosa importante, lo veníamos organizando hace un mes. Y Diego me había dicho que iba a llegar a las ocho, porque tenía un partido de fútbol en la tarde. Y llegó a las diez y media. Sin avisar. Yo le escribí tres veces y no me contestó.
[01:16] A: Ya.
[01:18] C: Y yo estaba sola recibiendo a todos, mi familia preguntando dónde está Diego, dónde está Diego, y yo inventando excusas. Me sentí sola, me sentí humillada la verdad. Y cuando llegó, llegó como si nada, con olor a cerveza, saludando a todos súper simpático.
[01:37] A: Te sentiste sola y humillada.
[01:40] C: Sí. Y no es la primera vez. Siempre que es algo de mi familia, él llega tarde o se va temprano. Con su familia nunca pasa.
[01:50] A: Ya. Y después, ¿qué pasó?
[01:53] C: Después en el auto, de vuelta, le dije que me había dejado sola, y él se puso a gritar que yo siempre lo controlo, que no puede tener una tarde con sus amigos. Y yo le dije que me bajaba del auto. Y me bajé en la esquina de la casa de mi hermana y me fui a dormir allá.
[02:14] A: Ok. Gracias, Carla. Diego, ahora tú. ¿Cómo lo viviste?
[02:19] B: Ya. Primero, sí, llegué tarde, eso lo reconozco. Pero no fue a las diez y media, fue como a las diez y cuarto.
[02:27] C: Diego…
[02:28] A: Carla, después te doy la palabra. Sigue, Diego.
[02:31] B: Lo que pasó es que el partido se alargó, hubo alargue, y después fuimos a comer algo con los chiquillos, una cerveza, una. Y se me descargó el celular, por eso no vi los mensajes. No fue que la ignorara.
[02:47] A: Se te descargó el celular.
[02:49] B: Sí, de verdad. Y cuando llegué me sentí mal, porque vi la cara de ella. Pero traté de pasarlo bien, de saludar a todos, de no arruinar el cumpleaños. Y en el auto ella empezó a decirme que soy un egoísta, que nunca estoy, y ahí sí me enojé, porque yo siento que hago harto.
[03:09] A: Sientes que haces harto y que eso no se ve.
[03:12] B: Exacto. Yo voy a todos los almuerzos de los domingos donde su mamá. Todos. Y una vez que llego tarde, soy lo peor.
[03:21] A: ¿Y lo del grito en el auto?
[03:24] B: Sí, levanté la voz. No le grité así como… levanté la voz. Le dije que me sentía controlado. Porque me escribe cada media hora cuando estoy con mis amigos.
[03:36] C: No es cada media hora, es…
[03:38] A: Carla, te voy a pedir que esperes un poquito. Ya vas.
[03:41] C: Ya, perdón.
[03:43] B: Eso. Y cuando se bajó del auto me asusté, porque era de noche. La seguí con el auto hasta que vi que entró donde su hermana. Y después le escribí y no me contestó hasta el otro día.
[03:57] A: Gracias Diego. Entonces hay dos versiones del sábado. Para Carla, llegaste muy tarde, sin avisar, a algo importante para ella y su familia, y se sintió sola. Para ti, Diego, fue un atraso que no fue intencional, se te descargó el celular, y sentiste que ella no ve lo que tú sí haces. ¿Es así?
[04:18] B: Sí.
[04:19] C: Sí, más o menos. Pero lo de la cerveza no fue una.
[04:23] B: Fueron dos.
[04:25] C: Ya, da igual. El punto no es la cerveza.
[04:28] A: ¿Cuál es el punto para ti, Carla?
[04:31] C: Que yo no le importo cuando se trata de mi familia. Eso siento.
[04:36] A: Ya. Diego, ¿qué te pasa cuando Carla dice "no le importo"?
[04:41] B: Me duele. Porque no es así. Ella me importa. Me cuesta lo de su familia porque siento que me miran en menos, su papá sobre todo. Pero ella me importa.
[04:53] C: ¿Mi papá te mira en menos?
[04:55] B: Sí, Carla, siempre me pregunta por la pega como si no tuviera trabajo de verdad.
[05:01] C: No sabía eso.
[05:03] A: Esto es nuevo, ¿cierto? Que Diego se sienta mirado en menos por tu papá.
[05:08] C: Sí, nunca me lo había dicho así.
[05:12] B: Te lo he dicho, pero de pasada.
[05:15] A: Ya. Quiero detenerme en esto, porque puede que el atraso del sábado tenga que ver no solo con el partido.
[05:22] B: Puede ser… sí. Igual no tenía tantas ganas de llegar temprano, si soy honesto.
[05:29] C: ¿Ves?
[05:31] A: Carla, fíjate que Diego está siendo honesto ahora, y eso cuesta. ¿Cómo te sientes al escucharlo?
[05:38] C: Me da pena. Y rabia también. Porque si me lo hubiera dicho antes, yo podría haber hecho algo, no sé, hablar con mi papá.
[05:48] A: Te da pena y rabia, y te hubiera gustado saberlo antes.
[05:52] C: Sí.
[05:55] A: Diego, ¿qué te impidió decírselo antes?
[05:58] B: Que no quería que pensara que estoy hablando mal de su familia. Su familia es sagrada para ella.
[06:05] C: No es sagrada, pero sí es importante.
[06:08] A: Ok. Fíjense en algo. Los dos están cuidando algo. Carla cuida su vínculo con su familia, y Diego evita conflictos con esa familia callándose cosas. Y eso hace que se distancien entre ustedes.
[06:22] B: Sí, tiene sentido.
[06:24] C: Sí.
[06:27] A: Ahora vamos a lo del control, que Diego mencionó. Carla, ¿cómo es eso de los mensajes cuando él está con sus amigos?
[06:35] C: Es que le escribo para saber a qué hora llega, para organizarme. No es para controlarlo. Pero si no me contesta me pongo ansiosa, y le vuelvo a escribir.
[06:46] A: ¿Y qué te imaginas cuando no te contesta?
[06:49] C: Que está tomando mucho. Que va a manejar curado. Me da miedo eso.
[06:55] B: No manejo curado, Carla. Nunca.
[06:58] C: El sábado manejaste después de dos cervezas.
[07:01] B: Dos cervezas en tres horas, no estaba curado.
[07:05] A: Ok. Aquí hay algo importante. Carla, tu preocupación tiene que ver con la seguridad de Diego, más que con controlarlo.
[07:13] C: Sí. Mi tío murió en un accidente así. Diego lo sabe.
[07:18] B: Lo sé. No lo había pensado así.
[07:21] A: Diego, ¿cómo te suena eso?
[07:24] B: Distinto. Yo lo vivo como control, como que no confía en mí. Pero si es por eso… es distinto.
[07:32] A: A veces lo que uno vive como control, para el otro es miedo. Y lo que uno vive como abandono, para el otro es un atraso sin mala intención.
[07:42] C: Sí.
[07:44] B: Sí.
[07:47] A: Quiero proponerles algo concreto para esta semana, antes de seguir. ¿Les parece?
[07:52] C: Sí.
[07:53] B: Ya.
[07:55] A: Diego, la primera es para ti: cuando vayas a llegar más tarde de lo acordado, avisas antes de la hora acordada, aunque sea un mensaje corto. "Voy a llegar a tal hora". Y si tienes poca batería, avisas antes de que se acabe.
[08:10] B: Ya. Eso lo puedo hacer. Puedo llevar el cargador portátil también.
[08:15] A: Perfecto. Carla, la tuya: cuando Diego esté con sus amigos y ya te haya avisado la hora, no le escribes de nuevo hasta esa hora. Y si te viene la ansiedad, la anotas, y la conversan después.
[08:29] C: Uy. Eso me va a costar.
[08:32] A: Lo sé. Por eso la anotas. No se trata de que no sientas nada, sino de no actuarla en el momento.
[08:39] C: Ya. Lo voy a intentar.
[08:42] A: Y una para los dos: el domingo, una conversación de quince minutos, sin celular, en que cada uno cuenta cómo le fue con su tarea. Sin juzgar, solo contar.
[08:54] B: ¿Quince minutos no más?
[08:56] A: Quince minutos. Es mejor corto y que lo hagan, que largo y que termine en pelea.
[09:02] C: Ya, me gusta.
[09:04] B: Ya.
[09:07] A: Ahora, volvamos un poco a lo del auto. Carla, dijiste que te bajaste del auto en la esquina. ¿Cómo estabas en ese momento?
[09:15] C: Muy enojada. Y él gritaba. No me sentía bien estando ahí.
[09:21] B: No gritaba, levanté la voz.
[09:24] C: Diego, gritabas. Los vidrios estaban cerrados y igual se escuchaba.
[09:29] A: Ok, para Carla fueron gritos, para Diego fue levantar la voz. Lo que me importa es cómo se sintió cada uno. Carla, ¿tuviste miedo?
[09:37] C: No miedo de que me hiciera algo, no. Él no es así. Pero sí me sentí mal, como agobiada. Necesitaba salir.
[09:46] A: Ya. Necesitabas salir. Diego, ¿y tú?
[09:50] B: Yo sentí que me estaba atacando y me defendí. Pero no me gusta cómo terminó. No me gusta que se haya bajado del auto.
[09:59] A: Esto nos lleva a algo que quiero que practiquemos: la pausa. Cuando uno de los dos siente que la conversación está subiendo de tono, puede pedir una pausa de veinte minutos. Y retoman después.
[10:12] C: ¿Y si el otro no quiere parar?
[10:15] A: La regla es que la pausa se respeta. Quien la pide, dice "necesito veinte minutos" y se compromete a volver a la conversación. No es irse, es parar.
[10:26] B: Ya, eso me sirve. Porque yo a veces sigo y sigo.
[10:30] C: Yo también.
[10:33] A: Bien. Ahora, Diego, quiero volver a lo de tu suegro, porque creo que es algo que vamos a tener que trabajar.
[10:40] B: Ya.
[10:42] A: ¿Desde cuándo sientes que te mira en menos?
[10:45] B: Desde que lo conozco. Desde el primer almuerzo. Me preguntó cuánto ganaba.
[10:51] C: Mi papá es así con todos, Diego.
[10:54] B: No, conmigo es distinto. Con el pololo de tu hermana no es así.
[10:59] C: Porque el Felipe es ingeniero…
[11:01] B: ¿Ves? Eso. Eso mismo.
[11:04] C: No, no lo dije así, no es lo que quise decir.
[11:07] B: Sí lo dijiste así, Carla. Es lo que piensa tu familia, y tú también.
[11:12] C: ¡No es lo que pienso! ¿Por qué siempre…?
[11:14] B: [voces superpuestas] … siempre lo mismo…
[11:17] C: [voces superpuestas] … no me estás escuchando…
[11:21] A: Diego, Carla. Paremos un momento. Respiren. Esto es justamente lo que estábamos conversando.
[11:28] B: Es que no puedo, Valentina. Necesito salir un rato. Voy a apagar la cámara.
[11:33] A: Diego, está bien. ¿Te parece si lo usamos como la pausa que conversamos? Apagas la cámara unos minutos y vuelves.
[11:41] B: Ya. Dos minutos.
[11:44] C: Ves, siempre se va.
[11:47] A: Carla, Diego está haciendo justo lo que acordamos, pedir una pausa. Va a volver. ¿Cómo estás tú?
[11:55] C: Mal. Me da rabia. Y pena. No quise decir eso del Felipe.
[12:02] A: Te creo. ¿Qué quisiste decir?
[12:05] C: Que mi papá valora mucho los títulos, y que eso es un problema de mi papá, no de Diego. Yo admiro a Diego, él armó su taller solo.
[12:15] A: Eso es muy importante. ¿Se lo has dicho así?
[12:18] C: No… creo que no.
[12:21] A: Cuando vuelva, ¿te gustaría decírselo?
[12:24] C: Sí.
[12:27] C: Igual me da miedo que esto termine mal. Que nos separemos.
[12:32] A: Eso es algo que podemos conversar también. Hoy están aquí los dos, trabajando. Eso dice algo.
[12:39] C: Sí.
[13:10] B: Ya, volví. Perdón.
[13:13] A: Bienvenido de vuelta, Diego. Hiciste bien en tomar la pausa. ¿Cómo estás?
[13:18] B: Más tranquilo. Me lavé la cara. Perdón por levantar la voz.
[13:23] A: Gracias. Carla quería decirte algo.
[13:26] C: Diego, lo del Felipe salió mal. Lo que quise decir es que mi papá valora los títulos y eso es problema de él. Yo te admiro. Armaste el taller solo, sin ayuda de nadie.
[13:39] B: … gracias. No sabía que pensabas eso.
[13:43] C: Lo pienso. Debería decírtelo más.
[13:47] A: ¿Cómo te sientes al escuchar eso, Diego?
[13:50] B: Bien. Me emociona un poco. Perdón.
[13:55] A: No hay nada que perdonar. Fíjense lo que acaba de pasar: subió el tono, Diego pidió una pausa, volvió, y pudieron decirse algo importante.
[14:05] C: Sí. Eso fue distinto a lo del auto.
[14:09] B: Sí. En el auto no paramos.
[14:13] A: Exacto. Esa es la diferencia.
[14:17] A: Diego, ¿te gustaría que en algún momento conversemos cómo manejar la relación con tu suegro?
[14:23] B: Sí. Pero con calma. No hoy.
[14:26] A: No hoy. Lo dejamos para una próxima sesión.
[14:30] C: ¿Y lo del alcohol? Igual me preocupa.
[14:34] A: ¿Qué te preocupa exactamente?
[14:37] C: Que maneje después de tomar. Aunque sean dos.
[14:41] B: Puedo no manejar si tomo. Me devuelvo en Uber y el auto lo saco al otro día.
[14:47] C: ¿En serio?
[14:49] B: Sí. Si es por tu tranquilidad, sí.
[14:53] A: ¿Lo dejamos como acuerdo? Si Diego toma algo, no maneja.
[14:57] B: Sí, acuerdo.
[14:59] C: Gracias.
[15:02] A: Bien. Me gustaría preguntarles por las otras cosas que habíamos conversado la vez pasada. Los tiempos juntos, las salidas.
[15:10] C: No salimos. Con todo lo del cumpleaños no hubo tiempo.
[15:15] B: Fuimos al cine el miércoles.
[15:17] C: Ah, verdad. El miércoles sí. Eso estuvo bien.
[15:21] A: ¿Qué vieron?
[15:23] B: Una de terror. A ella no le gustan pero fue igual.
[15:27] C: Fue por él. Pero lo pasamos bien, comimos sushi después.
[15:32] A: Qué bueno. Eso también cuenta. A veces en semanas difíciles se nos olvida lo que sí funcionó.
[15:39] C: Sí, es verdad, se me había olvidado.
[15:43] A: Oye, y en lo cotidiano, ¿cómo se están comunicando durante el día? La vez pasada Carla decía que casi no hablaban en la semana.
[15:51] C: Igual. Nos mandamos memes, pero no hablamos de cosas. Él llega cansado, yo llego cansada, vemos una serie y a dormir.
[16:01] B: Es que en la noche no me da la cabeza para conversar cosas serias. Llego muerto.
[16:07] C: Pero no tienen que ser cosas serias. Contarme cómo te fue no más.
[16:12] B: Ya, pero si le cuento del taller se aburre.
[16:15] C: No me aburro, Diego. Me aburre que me digas "bien" y nada más.
[16:20] A: Ok. Carla, para ti sería importante saber un poco más del día de Diego, aunque sean cosas simples.
[16:27] C: Sí. Como antes. Antes me contaba todo.
[16:31] B: Antes tenía menos pega.
[16:34] A: Diego, ¿qué te pasa cuando Carla dice "antes me contabas todo"?
[16:39] B: Como que la estoy decepcionando. Que no soy el de antes.
[16:44] C: No dije eso.
[16:46] B: No, ya sé, pero así lo escucho.
[16:49] A: Esto es interesante. Diego escucha una crítica, y Carla está diciendo que extraña algo. ¿Es así, Carla?
[16:57] C: Sí, es eso. Lo extraño. No es una crítica.
[17:01] B: Ya. Visto así es distinto.
[17:05] A: Muchas veces en las parejas uno dice "te extraño" con palabras de reclamo, y el otro escucha el reclamo y no el "te extraño".
[17:14] C: Sí, me pasa harto eso. Lo digo como reclamo.
[17:18] B: Y yo me pongo a la defensiva.
[17:21] A: Exacto. ¿Qué podrías decir en vez del reclamo, Carla?
[17:25] C: No sé… "oye, me gustaría que me contaras algo de tu día". Algo así.
[17:31] B: Eso me gusta más. Así sí te cuento.
[17:35] A: Y Diego, ¿qué podrías hacer tú cuando escuches algo que suena a reclamo?
[17:40] B: Preguntarle qué necesita, supongo. En vez de defenderme.
[17:45] A: Muy bien. No lo dejo como tarea formal, porque ya tienen varias. Pero obsérvenlo esta semana.
[17:52] C: Ya.
[17:53] B: Ya.
[17:56] A: ¿Y los fines de semana? ¿Cómo los organizan?
[18:00] C: Los domingos siempre almuerzo donde mi mamá. Y el sábado depende, a veces él tiene fútbol.
[18:07] B: El fútbol es lo único mío, Valentina. Es mi espacio.
[18:11] A: Es importante tener espacios propios.
[18:14] C: No le digo que no vaya. Le digo que avise.
[18:17] B: Sí, ya sé. Eso ya lo acordamos.
[18:20] A: Ya lo acordamos, sí. ¿Les gustaría tener también un espacio de los dos, aparte del domingo con la familia?
[18:27] C: Me encantaría. El viernes, por ejemplo.
[18:31] B: El viernes llego tarde del taller.
[18:34] C: Siempre hay algo.
[18:36] A: ¿Qué tal si lo piensan los dos durante la semana y en la conversación del domingo eligen un momento?
[18:43] B: Ya, eso sí.
[18:45] C: Ya.
[18:48] A: Carla, me decías hace un rato que te da miedo que se separen. ¿Es algo que piensas seguido?
[18:55] C: A veces. Cuando peleamos fuerte, como el sábado. Pienso "esto no va a funcionar".
[19:03] B: Yo nunca he pensado en separarnos.
[19:06] C: ¿Nunca?
[19:08] B: Nunca. Me enojo, pero no pienso en eso.
[19:12] C: No sabía.
[19:14] A: ¿Cómo te sientes al escuchar eso, Carla?
[19:17] C: Aliviada. Pensé que él también lo pensaba.
[19:22] A: Es bueno que lo hayan podido decir. A veces cada uno se imagina lo que piensa el otro, y nunca lo pregunta.
[19:30] B: Sí. Nos pasa mucho eso.
[19:33] A: Ese puede ser otro tema para trabajar: preguntar en vez de suponer.
[19:38] C: Sí, me hace sentido.
[19:41] B: Sí.
[19:44] A: Diego, ¿cómo ha estado el trabajo en el taller?
[19:47] B: Harto trabajo. Eso también me tiene cansado. Llego a las ocho, ocho y media.
[19:53] C: Y yo llego a las seis y me toca todo lo de la casa.
[19:57] B: No todo, yo cocino los fines de semana.
[20:00] C: Ya, los fines de semana.
[20:03] A: Parece que la distribución de tareas de la casa es otro tema que aparece. ¿Lo quieren ver hoy o lo dejamos anotado?
[20:10] C: Anotado. Hoy ya fue mucho.
[20:13] B: Sí, anotado.
[20:16] A: Perfecto, lo dejamos para más adelante. Nos quedan unos minutos. Repasemos lo que acordamos.
[20:22] C: Ya.
[20:24] A: Diego: avisar antes de la hora si vas a llegar más tarde, llevar el cargador. Y si tomas algo, no manejas.
[20:32] B: Sí.
[20:34] A: Carla: si Diego ya avisó la hora, no escribir de nuevo hasta esa hora; si viene la ansiedad, anotarla.
[20:42] C: Sí.
[20:44] A: Los dos: la pausa de veinte minutos cuando suba el tono, y el domingo la conversación de quince minutos sin celular.
[20:52] B: Ya.
[20:53] C: Ya.
[20:56] A: Y para la próxima sesión quedan pendientes: la relación de Diego con su suegro, y la distribución de las tareas de la casa.
[21:04] C: Y cómo nos fue con todo esto.
[21:07] A: Y cómo les fue con los acuerdos, claro. Partiremos por ahí.
[21:12] B: Ya.
[21:15] A: ¿Cómo se van hoy?
[21:17] C: Mejor. Más aliviada. Me sirvió escuchar lo de mi papá.
[21:23] B: Yo también, mejor. Cansado, pero mejor. Me sirvió la pausa.
[21:29] A: Me alegro. Hicieron un trabajo muy bueno hoy, los dos.
[21:34] C: Gracias, Valentina.
[21:36] B: Gracias.
[21:39] A: Una cosa administrativa: la próxima es en dos semanas, el jueves a las siete y media, online igual. ¿Les acomoda?
[21:47] C: Eh, a mí sí. Diego, ¿tú?
[21:50] B: Sí, si es online sí. Llego justo del taller.
[21:54] A: Perfecto. Les mando el link al correo de Carla, como siempre.
[21:58] C: Ya, gracias.
[22:00] A: Cuídense. Nos vemos.
[22:02] B: Chao.
[22:03] C: Chao, gracias.
`;

export const PAREJA_25: CasoSintetico = {
  clave: 'sint-pareja-25',
  etiqueta: 'Sintética · pareja ~22 min',
  descripcion: 'Versiones contrapuestas del mismo episodio, tareas por persona, un momento tenso con pausa.',
  plantilla: 'pareja',
  modalidad: 'online',
  fecha: '2026-10-15',
  duracionMin: 22,
  participantes: [
    { rol: 'Terapeuta', nombre: 'Valentina' },
    { rol: 'Miembro', nombre: 'Carla' },
    { rol: 'Miembro', nombre: 'Diego' },
  ],
  guion: GUION,
  finSeg: 22 * 60 + 10,
  esperado: {
    // Manejar después de tomar (06:49–07:13) es un "peligro"/consumo: lo esperable es que se consigne.
    riesgo: true,
    terminosProhibidos: [],
    tareas: ['Diego', 'Carla', 'pausa', 'domingo'],
    nota: 'Debe ser simétrico (las dos versiones del sábado, sin tomar partido), separar tareas por persona y decir en Notas que los hablantes se infirieron.',
  },
};
