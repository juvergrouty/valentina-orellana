// Contenido de "Pasos a seguir": ÚNICA fuente para la página oculta
// (/pasos-a-seguir/<clave>) y el correo (email.ts::sendStepsEmail), para que
// ambos digan siempre exactamente lo mismo.
export interface StepItem { icon: string; titulo: string; texto: string }

export const STEPS_INTRO = 'Aquí tienes todo lo que necesitas saber para empezar tranquila/o: qué vas a recibir, cómo son las sesiones y qué hacer si necesitas cambiar algo.';

export function stepsItems(clinicAddress?: string | null): StepItem[] {
  const addr = clinicAddress?.trim();
  return [
    {
      icon: 'calendar',
      titulo: 'Confirmación de tu sesión',
      texto: 'Te llega un correo con la fecha, la hora y la modalidad de tu reserva. Revisa también tu carpeta de spam o promociones.',
    },
    {
      icon: 'lock',
      titulo: 'Consentimiento informado',
      texto: 'Te llegará un link para firmar el consentimiento informado de tratamiento de datos, que responde a la Ley 21.719 de protección de datos personales. Es fundamental firmarlo para poder atenderte.',
    },
    {
      icon: 'video',
      titulo: 'Si tu sesión es online',
      texto: 'Se realiza por Google Meet. El enlace te llega en la invitación de tu calendario; solo tienes que entrar a la hora de la sesión desde un lugar tranquilo y privado.',
    },
    {
      icon: 'map-pin',
      titulo: 'Si tu sesión es presencial',
      texto: addr
        ? `La dirección de la consulta es ${addr}${/[.!]$/.test(addr) ? '' : '.'} Te recomiendo llegar unos minutos antes.`
        : 'Te confirmo la dirección exacta de la consulta por WhatsApp antes de tu primera sesión.',
    },
    {
      icon: 'shield',
      titulo: 'Boleta y reembolso',
      texto: 'Al pagar cada sesión te llega por correo tu boleta de honorarios electrónica emitida ante el SII. Guárdala: con ella puedes pedir el reembolso en tu prestador o seguro de salud, si corresponde.',
    },
    {
      icon: 'clock',
      titulo: 'Si necesitas reagendar',
      texto: 'Avísame con al menos 24 horas de anticipación (o usa el enlace de tu correo de confirmación). Si avisas con menos de 24 horas, no es posible reagendar y la sesión se considera realizada.',
    },
    {
      icon: 'check',
      titulo: 'Valores de las sesiones',
      texto: 'Los valores pueden reajustarse hasta dos veces al año. Si estás en proceso, te aviso con al menos 30 días de anticipación.',
    },
  ];
}
