// Correo de anulación de una hora (decisión de Vale, 19 oct 2026: "cuando quiera anular una hora dame
// algo para clickear si quiero o no mandar ese mail"). Solo sale si ella marca "Avisar a la paciente por
// correo" al anular. Solo avisa que la sesión fue anulada (sin botones ni reagendar).
// Función pura (sin base de datos ni variables de entorno): la envía sendCancellationEmail (email.ts) y
// la revisan las pruebas (decisionesAuditoria.test.ts). Mismo estilo que los demás correos del sitio.

const SITIO = 'https://www.valentinaorellana.cl';
export const URL_AGENDA_PACIENTE = `${SITIO}/agenda`;
const LOGO = `<img src="${SITIO}/firma/v.png" width="44" height="44" alt="Ps. Valentina Orellana" style="display:block;border:0;width:44px;height:44px;margin:0 0 1.25rem;">`;

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function escapar(s: string | null | undefined): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** "jueves 22 de octubre" para YYYY-MM-DD. */
export function fechaAnulacion(fecha: string): string {
  const [y, m, d] = fecha.split('-').map(Number);
  return `${DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} de ${MESES[m - 1]}`;
}

export interface DatosAnulacion {
  patient_name: string;
  session_date: string; // YYYY-MM-DD
  session_time: string; // HH:MM[:SS]
  /** Ya estaba pagada: se le dice que Vale le escribe para reagendar o devolver el pago. */
  pagada?: boolean;
  /** Sesión sin costo (obra social): no se la manda a la agenda web (ahí se paga); se le pide escribir. */
  sinCosto?: boolean;
}

/** Primer nombre para el saludo ("Camila Rojas" → "Camila"). */
export function primerNombre(nombre: string | null | undefined): string {
  return String(nombre ?? '').trim().split(/\s+/)[0] ?? '';
}

export function asuntoAnulacion(d: DatosAnulacion): string {
  return `Tu sesión del ${fechaAnulacion(d.session_date)} fue anulada — Ps. Valentina Orellana`;
}

// Decisión de Vale (19 oct): el correo SOLO avisa que la sesión fue anulada (ella la anula y conversa
// lo demás directamente). Sin botones, sin reagendar y sin hablar de pagos. `pagada`/`sinCosto` quedan
// en DatosAnulacion por compatibilidad, pero no cambian el texto.
export function textoAnulacion(d: DatosAnulacion): string {
  const hora = String(d.session_time).slice(0, 5);
  return [
    `Hola ${primerNombre(d.patient_name)}, te escribo para avisarte que tu sesión del ${fechaAnulacion(d.session_date)} a las ${hora} fue anulada.`,
    'Un saludo,\nValentina',
  ].join('\n\n');
}

export function htmlAnulacion(d: DatosAnulacion): string {
  const hora = escapar(String(d.session_time).slice(0, 5));
  return `
      <div style="font-family:'Georgia',serif;max-width:560px;margin:0 auto;padding:2rem;color:#1A1A18;background:#FAF7F4;">
        ${LOGO}
        <h1 style="font-size:1.5rem;font-weight:400;margin-bottom:0.5rem;">Sesión anulada</h1>
        <p style="color:#6B6860;font-size:0.9rem;margin-bottom:1.25rem;font-family:'Inter',sans-serif;line-height:1.6;">
          Hola ${escapar(primerNombre(d.patient_name))}, te escribo para avisarte que tu sesión del
          <strong>${escapar(fechaAnulacion(d.session_date))} a las ${hora}</strong> fue anulada.
        </p>
        <p style="font-family:'Inter',sans-serif;font-size:0.9rem;color:#1A1A18;line-height:1.6;margin-top:1.5rem;">Un saludo,<br>Valentina</p>
        <p style="font-family:'Inter',sans-serif;font-size:0.75rem;color:#6B6860;margin-top:2rem;
                  padding-top:1.5rem;border-top:1px solid #DDD8CF;">
          Ps. Valentina Orellana · Psicóloga · Reg. Superintendencia de Salud N° 360070
        </p>
      </div>
    `;
}
