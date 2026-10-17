// Caso sintético para la prueba ciega Sonnet vs Haiku (/admin/transcriptor/comparar).
// TODO INVENTADO: no corresponde a ninguna persona ni sesión real. Imita una transcripción
// automática de una sesión individual online de ~15 min con POCO contenido: el paciente llega
// cansado, dice que no pasó nada especial, se corta la conexión un rato (pausa de la grabación)
// y gran parte es administrativa (cambio de horario, boleta). Sirve para ver si el resumen se
// mantiene corto (40–100 palabras) y no rellena con cosas que no se dijeron.
import type { CasoSintetico } from './tipos';

const GUION = `
[00:05] A: Hola Joaquín, ¿me escuchas?
[00:08] B: Sí, sí, hola. Perdón, estaba entrando recién. Se me trabó el link.
[00:14] A: No te preocupes. ¿Cómo estás?
[00:17] B: Bien, bien. Cansado no más. Eh, nada especial.
[00:23] A: ¿Cómo estuvo la semana?
[00:26] B: Normal. Trabajo, casa, trabajo. Lo mismo de siempre. No pasó mucho la verdad.
[00:34] A: Ya. ¿Y cómo has estado de ánimo?
[00:37] B: Normal. Ni bien ni mal. Como plano. Pero bien.
[00:44] A: Como plano.
[00:46] B: Sí, o sea, no es malo. Es que no pasó nada. No tengo mucho que contar hoy, la verdad.
[00:54] A: Está bien, no siempre hay que traer algo. ¿Te acuerdas de lo que conversamos la vez pasada, lo de salir a caminar?
[01:02] B: Eh… sí. No fui. No me dio el tiempo. Bueno, el tiempo sí, las ganas no.
[01:10] A: Ya. ¿Qué pasó con las ganas?
[01:13] B: No sé. Llegaba y me quedaba en el sillón. Viendo fútbol.
[01:19] A: ¿Y cómo te sentías ahí en el sillón?
[01:22] B: Bien, tranquilo. Es lo que me gusta. No sé si es malo.
[01:28] A: No tiene por qué ser malo. Te pregunto para saber cómo estás.
[01:32] B: Ya. No, estoy bien.
[01:36] A: ¿Y el sueño?
[01:38] B: Bien, duermo bien. Como siete horas.
[01:42] A: Qué bueno. ¿Y con tu polola, con la Fran, cómo ha estado?
[01:47] B: Bien también. Ella está con exámenes, entonces nos vemos menos. Pero bien.
[01:54] A: ¿La extrañas?
[01:56] B: Sí, un poco. Pero se termina la otra semana.
[02:01] A: Ya. ¿Y en la pega?
[02:04] B: Lo mismo. Mucho trabajo pero nada raro. El jefe anda más tranquilo.
[02:10] A: La otra vez me contabas que el jefe te tenía estresado.
[02:14] B: Sí, pero ahora anda tranquilo. Se fue de vacaciones una semana, entonces fue relajado.
[02:21] A: Ah, por eso estuvo tranquila la semana.
[02:24] B: Claro, jaja. Sin el jefe es otra cosa.
[02:29] A: ¿Y cuando vuelva?
[02:31] B: Ahí veremos. No quiero pensar en eso todavía.
[02:36] A: Ok. ¿Te parece si lo dejamos para cuando vuelva, y vemos cómo te pega?
[02:41] B: Sí, mejor.
[02:45] A: ¿Hay algo que te gustaría conversar hoy, aunque sea chico?
[02:49] B: Eh… no sé. No se me ocurre nada. Perdón.
[02:54] A: No pidas perdón. A veces las sesiones son así, más tranquilas.
[02:59] B: Ya.
[03:02] A: Te quería preguntar por lo de tu mamá, ¿al final fue al médico?
[03:06] B: Sí, fue. Le dijeron que estaba bien, que era la presión no más. Le cambiaron un remedio.
[03:13] A: Qué bueno, quedaste más tranquilo con eso.
[03:16] B: Sí, harto. Eso sí me tenía preocupado.
[03:21] A: ¿Y tú cómo lo viviste mientras esperaban el resultado?
[03:25] B: Mal, la verdad, unos días. Pero ya pasó.
[03:30] A: Ya. Me alegra que esté bien.
[03:33] B: Sí. Gracias.
[03:37] A: Oye, ¿y la caminata? ¿La quieres intentar esta semana o lo dejamos?
[03:42] B: Mm… puede ser. Pero sin compromiso.
[03:46] A: Sin compromiso. Si sale, sale.
[03:49] B: Ya.
[03:52] A: ¿Y qué has estado viendo en la tele, aparte del fútbol?
[03:56] B: Una serie, una de detectives. Me la recomendó un compañero. Es buena, voy en la segunda temporada.
[04:04] A: ¿La ves solo o con la Fran?
[04:07] B: Solo, porque ella está estudiando. Pero después se la voy a mostrar.
[04:13] A: Ya. Oye, y el fútbol, ¿juegas o solo ves?
[04:16] B: Antes jugaba, los martes, con los del colegio. Pero se fue desarmando el grupo. Ahora veo no más.
[04:24] A: ¿Desde cuándo se desarmó?
[04:27] B: Desde el invierno, como en junio. Uno se fue a Concepción, otro tuvo guagua. Eh… y así.
[04:35] A: ¿Y lo echas de menos?
[04:38] B: Un poco. Era entretenido. Pero bueno, la vida no más.
[04:44] A: Mm. La vida no más.
[04:47] B: Sí. No es que me afecte tanto. O sea, no sé.
[04:53] A: ¿Te gustaría volver a jugar en algún momento?
[04:56] B: Puede ser. Hay una liga en la comuna, pero no conozco a nadie.
[05:02] A: Ya. ¿Es algo que te gustaría mirar más adelante?
[05:06] B: Sí, más adelante. Ahora no tengo energía para eso.
[05:11] A: Está bien. Lo dejamos ahí.
[05:14] B: Ya.
[05:20] A: ¿Y cómo ha estado el tema de la comida, de los horarios? La otra vez me decías que almorzabas tarde.
[05:26] B: Igual, almuerzo como a las tres. Pero como. No es problema.
[05:32] A: Ya.
[05:35] B: Eh… [inaudible] la micro, eso sí, es un cacho. Me demoro una hora en llegar a la pega.
[05:43] A: Una hora de ida y una de vuelta.
[05:46] B: Sí, dos horas al día en micro. Escucho podcast, eso sí.
[05:52] A: ¿Qué escuchas?
[05:54] B: De fútbol, de historia. Variado.
[05:58] A: Qué bueno tener algo para ese rato.
[06:01] B: Sí, si no me volvería loco, jaja.
[06:06] A: Jaja. ¿Hay algo de la semana que te haya molestado, aunque sea chico?
[06:11] B: No… bueno, que no me llegó la boleta, pero eso te lo iba a decir después.
[06:17] A: Ah, bueno, dímelo ahora si quieres.
[06:20] B: Ya, pero primero lo del horario, que es más importante.
[06:25] A: Dale.
[06:29] B: Ah, oye, una cosa. Te quería preguntar por el horario. ¿Podemos cambiar la próxima sesión? Es que tengo una capacitación el jueves en la tarde.
[06:38] A: Sí, claro. ¿Qué día te acomoda?
[06:41] B: ¿El viernes? ¿A la misma hora?
[06:44] A: Déjame ver… el viernes a las seis tengo libre. ¿Te sirve a las seis?
[06:50] B: Sí, a las seis perfecto.
[06:53] A: Listo, el viernes a las seis. Te mando la invitación nueva.
[06:57] B: Gracias. Y lo otro, la boleta del mes pasado no me llegó. ¿Me la podrías mandar de nuevo?
[07:04] A: Sí, te la reenvío hoy. ¿Al mismo correo?
[07:07] B: Sí, al de la pega. No, mejor al personal.
[07:11] A: Al personal entonces. ¿Es el que termina en gmail?
[07:15] B: Ese, sí.
[07:18] A: Perfecto.
[07:21] B: Gracias. Perdón que sea tan corto hoy.
[07:25] A: No te preocupes. ¿Cómo te vas sintiendo ahora?
[07:28] B: Bien. Igual me sirve venir, aunque no hable tanto.
[07:33] A: Me alegra. ¿Qué es lo que te sirve?
[07:36] B: No sé, como tener un espacio. Saber que está.
[07:41] A: Eso es importante.
[07:44] B: Sí.
[07:48] A: Joaquín, se está cortando un poco, ¿me escuchas?
[07:51] B: Te escucho entrecortado… [inaudible]
[07:55] A: Voy a esperar un poco, a ver si se arregla.
[11:46] B: ¿Ahí sí? Perdón, se me cayó el internet.
[11:50] A: Ahí sí. Volviste. ¿Estás bien?
[11:53] B: Sí, sí. El wifi de la casa es malo. Me cambié al celular.
[11:58] A: Ok. Te preguntaba qué es lo que te sirve de venir.
[12:02] B: Ah, sí. Eso, tener el espacio. Aunque no pase nada.
[12:07] A: Sí, el espacio igual cuenta.
[12:10] B: Sí.
[12:14] A: Bueno, como te queda poco datos, quizás podemos ir cerrando un poco antes hoy. ¿Te parece?
[12:20] B: Sí, mejor, porque se me va a acabar el plan.
[12:24] A: Entonces quedamos: el viernes a las seis, te mando la invitación y la boleta al correo personal. Y si sale la caminata, buenísimo, sin presión.
[12:34] B: Ya, perfecto.
[12:36] A: Y cuando vuelva tu jefe, conversamos cómo te fue.
[12:40] B: Sí, eso.
[12:43] A: Cuídate, Joaquín. Nos vemos el viernes.
[12:46] B: Chao, gracias. Nos vemos.
`;

export const CORTA_15: CasoSintetico = {
  clave: 'sint-corta-15',
  etiqueta: 'Sintética · individual ~15 min, poco contenido',
  descripcion: 'Sesión corta y casi administrativa, con un corte de conexión (grabación pausada).',
  plantilla: 'individual',
  modalidad: 'online',
  fecha: '2026-10-16',
  duracionMin: 15,
  participantes: [{ rol: 'Terapeuta', nombre: 'Valentina' }, { rol: 'Paciente', nombre: 'Joaquín' }],
  guion: GUION,
  finSeg: 12 * 60 + 50,
  pausas: [{ desde_ms: 8 * 60_000, hasta_ms: 11 * 60_000 + 40_000 }],
  esperado: {
    riesgo: false,
    terminosProhibidos: [],
    tareas: ['viernes', 'boleta'],
    corta: true,
    nota: 'Debe quedar corto (40–100 palabras), sin inventar contenido, y mencionar la pausa en Notas.',
  },
};
