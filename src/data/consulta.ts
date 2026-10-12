// Dirección pública de la consulta y perfiles verificados (Valentina aprobó
// publicar la dirección, oct 2026). Una sola fuente para el contacto, el
// footer y los datos estructurados de BaseLayout.
// OJO: existe otra psicóloga "Valentina Orellana Moraga" (Viña del Mar,
// @ps.valeorellana). Nunca enlazar sus perfiles.

// Cambio de consulta (12 oct 2026): antes Lo Fontecilla 201, Torre B, of. 334.
// Coordenadas y código postal tomados de Google Maps para "Estoril 50".
export const DIRECCION = {
  calle: 'Estoril 50',
  detalle: 'oficina 811b',
  comuna: 'Las Condes',
  region: 'Región Metropolitana',
  codigoPostal: '7591047',
  pais: 'CL',
  lat: -33.384021,
  lng: -70.5331888,
};

// Indicaciones para llegar en auto (Valentina, 12 oct 2026). SOLO para
// pacientes con hora: correos, "Pasos a seguir", invitación de calendario y
// WhatsApp. No va en las páginas públicas (pedido de Valentina: "se ve feo").
export const ESTACIONAMIENTO = 'Estacionamiento por Lateral Kennedy: afuera hay un cartel azul que dice "Estacionamiento Estoril 50".';

/** "<dirección>. <estacionamiento>" sin punto doble si la dirección ya trae punto final. */
export function conEstacionamiento(direccion: string): string {
  const d = direccion.trim().replace(/[.\s]+$/, '');
  return `${d}. ${ESTACIONAMIENTO}`;
}

// Ficha de Google (Perfil de Empresa, place_id verificado): reseñas y perfil.
// Mientras la ficha no tenga la dirección nueva, los botones de "cómo llegar"
// usan la dirección directa (abajo), no la ficha.
export const GOOGLE_MAPS_URL = 'https://www.google.com/maps/place/?q=place_id:ChIJlbfOITLPYpYR2NQAUT8IvDE';
// La dirección nueva en Google Maps y la ruta hasta ella.
export const MAPS_DIRECCION_URL = 'https://www.google.com/maps/search/?api=1&query=Estoril+50,+Las+Condes,+Chile';
export const COMO_LLEGAR_URL = 'https://www.google.com/maps/dir/?api=1&destination=Estoril+50,+Las+Condes,+Chile';
// Mapa embebido sin API key (se ve solo dentro de un iframe).
export const GOOGLE_MAPS_EMBED = 'https://www.google.com/maps?q=Estoril+50,+Las+Condes,+Chile&output=embed';

// Perfiles públicos verificados (Reg. 360070).
// Solo visibilidad: la reserva se hace siempre en este sitio.
export const PERFILES = {
  instagram:      'https://www.instagram.com/psicologa.valentinaorellana/',
  doctoralia:     'https://www.doctoralia.cl/perfil/valentina-orellana',
  psychologyToday:'https://www.psychologytoday.com/cl/psicologos/valentina-orellana-psicologa-adultos-y-parejas-las-condes-rm/1580324',
  encuadrado:     'https://encuadrado.com/p/valentina-orellana-jaramillo',
};
