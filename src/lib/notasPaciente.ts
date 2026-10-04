// Las notas que escribe la paciente al reservar ("¿Algo que quieras
// contarme?") se guardan en bookings.notes, el mismo campo donde el sistema
// deja sus marcas internas (PagoToken, Boleta Folio, ComprobanteTransferencia,
// Meet:, etc.). Un texto que imitara una marca podía, por ejemplo, confirmar
// una reserva sin pagar reutilizando un código de pago ajeno (PagoToken), o
// hacer creer que una boleta ya estaba emitida. Aquí se neutralizan esas
// palabras para que lo escrito por la paciente nunca se lea como una marca.
// El texto sigue siendo legible para Valentina (solo se agrega un guion).

const REEMPLAZOS: [RegExp, string][] = [
  [/(pago)(?=token)/gi, '$1-'],                                   // PagoToken
  [/(boleta)(\s+)(folio)/gi, '$1-$3'],                             // Boleta Folio N
  [/(boleta)(?=(email|pendiente|emitiendo))/gi, '$1-'],            // BoletaEmailEnviada, BoletaPendiente*, BoletaEmitiendo
  [/(comprobante)(?=transferencia)/gi, '$1-'],                     // ComprobanteTransferencia
  [/(recordatorio)(?=(enviado|whatsapp))/gi, '$1-'],               // RecordatorioEnviado, RecordatorioWhatsAppEnviado
  [/(rese[ñn]a)(?=solicitada)/gi, '$1-'],                          // ReseñaSolicitada
  [/(evaluaci[oó]n)(?=enviada)/gi, '$1-'],                         // EvaluacionEnviada
  [/(cobro manual)(\s+)(generado)/gi, '$1-$3'],                    // Cobro manual generado desde admin
  [/(^|\n)(\s*)(meet)(\s*):/gi, '$1$2$3 -$4'],                     // Meet: <link>
];

export function limpiarNotasPaciente(texto: string | null | undefined): string | null {
  if (!texto) return null;
  let t = texto.trim();
  for (const [re, rep] of REEMPLAZOS) t = t.replace(re, rep);
  return t.slice(0, 2000) || null; // también un largo máximo razonable
}
