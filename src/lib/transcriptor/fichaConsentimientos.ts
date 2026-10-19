// Consentimientos de la ficha (17 oct 2026): lo que necesitan a la vez la franja "Pendientes" y el bloque
// único "Consentimientos" (ConsentimientosFicha.astro). Antes se calculaba dentro del componente de la
// pareja; se sube aquí para que la franja y el bloque digan exactamente lo mismo.
// "¿Es de pareja?" sale SIEMPRE de la regla única (consentimiento.ts fichaEsParejaEnBase, 86-revisión B1).
import { consentUrl, FaltaMigracion0021, getOrCreatePendingConsent } from '../consent';
import { estadoPareja, fichaConReservaPareja, reservaCuentaParaPareja, urlWhatsAppPareja, type EstadoPareja, type InfoServicio, type ReservaMinima } from './pareja';
import { fichaEsPareja, fichaEsParejaEnBase } from './consentimiento';
import { qrSvg } from './qr';

export interface ParejaFicha {
  esPareja: boolean;
  /** No se pudieron revisar todas las reservas: se usó lo que trae la ficha. */
  errorReservas: boolean;
  estado: EstadoPareja;
  link: string | null;
  errorLink: string | null;
  waHref: string | null;
  qr: string | null;
  enviado: { at: string; via: string } | null;
  /** Falta la firma de la segunda persona (la grabación sigue bloqueada mientras tanto). */
  falta: boolean;
}

export async function prepararPareja(p: {
  patient: { id: string; name: string; rut?: string | null };
  bookings: ReservaMinima[];
  /** Servicios conocidos (id → tipo y nombre), para el respaldo si la base falla y para la demo. */
  servicios: ReadonlyMap<string, InfoServicio>;
  consentRows: any[];
  origin: string;
  demo: boolean;
}): Promise<ParejaFicha> {
  const { patient, bookings, servicios, consentRows, demo } = p;
  // Respaldo (base caída o demo): misma regla, sin reservas anuladas ni vencidas (reservaCuentaParaPareja).
  const porFicha = () => fichaConReservaPareja(bookings, servicios) || fichaEsPareja({
    sessionTypes: bookings.filter(reservaCuentaParaPareja).map((b) => b.session_type), tiposGrabaciones: [], filas: consentRows, nombre: patient.name,
  });
  let esPareja = false;
  let errorReservas = false;
  if (demo) esPareja = porFicha();
  else {
    try { esPareja = await fichaEsParejaEnBase(patient.id); }
    catch { errorReservas = true; esPareja = porFicha(); } // no se esconde el bloque de una pareja
  }
  const estado = estadoPareja(consentRows, patient.rut, patient.name);
  let link: string | null = null;
  let errorLink: string | null = null;
  if (esPareja && !estado.firma) {
    if (estado.pendiente?.token) link = consentUrl(p.origin, String(estado.pendiente.token));
    else if (!demo) {
      // Se crea al abrir la ficha (una vez; después se reutiliza) para que el link esté a la vista en la consulta.
      try { link = consentUrl(p.origin, (await getOrCreatePendingConsent(patient.id, 2)).token); }
      catch (e) { errorLink = e instanceof FaltaMigracion0021 ? e.message : 'No se pudo preparar el link de la pareja. Recarga la página.'; }
    }
  }
  const pila = String(patient.name ?? '').trim().split(/\s+/)[0] ?? '';
  const waHref = link ? urlWhatsAppPareja(pila, link) : null;
  // QR en el servidor (qrcode-generator, sin red): el link no pasa por ningún servicio externo.
  let qr: string | null = null;
  if (link) { try { qr = qrSvg(link, { titulo: 'Código QR del consentimiento de la pareja' }); } catch { qr = null; } }
  const enviado = estado.pendiente?.sent_at ? { at: String(estado.pendiente.sent_at), via: String((estado.pendiente as { sent_via?: string | null }).sent_via ?? '') } : null;
  return { esPareja, errorReservas, estado, link, errorLink, waHref, qr, enviado, falta: esPareja && !estado.firma };
}
