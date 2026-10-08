// Dirección pública de la consulta y perfiles verificados (Valentina aprobó
// publicar la dirección, oct 2026). Una sola fuente para el contacto, el
// footer y los datos estructurados de BaseLayout.
// OJO: existe otra psicóloga "Valentina Orellana Moraga" (Viña del Mar,
// @ps.valeorellana). Nunca enlazar sus perfiles.

export const DIRECCION = {
  calle: 'Lo Fontecilla 201',
  detalle: 'Torre B, oficina 334',
  comuna: 'Las Condes',
  region: 'Región Metropolitana',
  codigoPostal: '7550000',
  pais: 'CL',
  lat: -33.3829252,
  lng: -70.5317605,
};

// Ficha de Google Maps (place_id verificado).
export const GOOGLE_MAPS_URL = 'https://www.google.com/maps/place/?q=place_id:ChIJlbfOITLPYpYR2NQAUT8IvDE';
// Mapa embebido sin API key (se ve solo dentro de un iframe).
export const GOOGLE_MAPS_EMBED = 'https://www.google.com/maps?q=Lo+Fontecilla+201,+Las+Condes,+Chile&output=embed';

// Perfiles públicos verificados (dirección Lo Fontecilla / Reg. 360070).
// Solo visibilidad: la reserva se hace siempre en este sitio.
export const PERFILES = {
  instagram:      'https://www.instagram.com/psicologa.valentinaorellana/',
  doctoralia:     'https://www.doctoralia.cl/perfil/valentina-orellana',
  psychologyToday:'https://www.psychologytoday.com/cl/psicologos/valentina-orellana-psicologa-adultos-y-parejas-las-condes-rm/1580324',
  encuadrado:     'https://encuadrado.com/p/valentina-orellana-jaramillo',
};
