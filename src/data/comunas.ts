// Comunas de Chile (346, con Ñuble) para el campo "Comuna" de la ficha.
// Fuente: lista pública chile-regiones-comunas (juanbrujo), revisada el 21 oct
// 2026 (346 comunas, sin repetidas).
//
// Por qué existe (21 oct 2026): el campo era texto libre y el autocompletar
// del navegador escribió "Las Condes, Metropolitana de Santiago". apigateway.cl
// no encontró el código SII de esa comuna y rechazó las boletas de esa paciente
// (API Gateway 400). Ahora la comuna se elige de esta lista y, antes de emitir,
// se limpia con normalizarComuna(); si aun así no se reconoce, la boleta sale
// sin comuna (como todas antes del 4 oct 2026, y el SII las aceptaba).

export const COMUNAS_POR_REGION: { region: string; comunas: string[] }[] = [
  { region: "Arica y Parinacota", comunas: ["Arica", "Camarones", "Putre", "General Lagos"] },
  { region: "Tarapacá", comunas: ["Iquique", "Alto Hospicio", "Pozo Almonte", "Camiña", "Colchane", "Huara", "Pica"] },
  { region: "Antofagasta", comunas: ["Antofagasta", "Mejillones", "Sierra Gorda", "Taltal", "Calama", "Ollagüe", "San Pedro de Atacama", "Tocopilla", "María Elena"] },
  { region: "Atacama", comunas: ["Copiapó", "Caldera", "Tierra Amarilla", "Chañaral", "Diego de Almagro", "Vallenar", "Alto del Carmen", "Freirina", "Huasco"] },
  { region: "Coquimbo", comunas: ["La Serena", "Coquimbo", "Andacollo", "La Higuera", "Paiguano", "Vicuña", "Illapel", "Canela", "Los Vilos", "Salamanca", "Ovalle", "Combarbalá", "Monte Patria", "Punitaqui", "Río Hurtado"] },
  { region: "Valparaíso", comunas: ["Valparaíso", "Casablanca", "Concón", "Juan Fernández", "Puchuncaví", "Quintero", "Viña del Mar", "Isla de Pascua", "Los Andes", "Calle Larga", "Rinconada", "San Esteban", "La Ligua", "Cabildo", "Papudo", "Petorca", "Zapallar", "Quillota", "Calera", "Hijuelas", "La Cruz", "Nogales", "San Antonio", "Algarrobo", "Cartagena", "El Quisco", "El Tabo", "Santo Domingo", "San Felipe", "Catemu", "Llaillay", "Panquehue", "Putaendo", "Santa María", "Quilpué", "Limache", "Olmué", "Villa Alemana"] },
  { region: "O'Higgins", comunas: ["Rancagua", "Codegua", "Coinco", "Coltauco", "Doñihue", "Graneros", "Las Cabras", "Machalí", "Malloa", "Mostazal", "Olivar", "Peumo", "Pichidegua", "Quinta de Tilcoco", "Rengo", "Requínoa", "San Vicente", "Pichilemu", "La Estrella", "Litueche", "Marchihue", "Navidad", "Paredones", "San Fernando", "Chépica", "Chimbarongo", "Lolol", "Nancagua", "Palmilla", "Peralillo", "Placilla", "Pumanque", "Santa Cruz"] },
  { region: "Maule", comunas: ["Talca", "Constitución", "Curepto", "Empedrado", "Maule", "Pelarco", "Pencahue", "Río Claro", "San Clemente", "San Rafael", "Cauquenes", "Chanco", "Pelluhue", "Curicó", "Hualañé", "Licantén", "Molina", "Rauco", "Romeral", "Sagrada Familia", "Teno", "Vichuquén", "Linares", "Colbún", "Longaví", "Parral", "Retiro", "San Javier", "Villa Alegre", "Yerbas Buenas"] },
  { region: "Ñuble", comunas: ["Cobquecura", "Coelemu", "Ninhue", "Portezuelo", "Quirihue", "Ránquil", "Treguaco", "Bulnes", "Chillán Viejo", "Chillán", "El Carmen", "Pemuco", "Pinto", "Quillón", "San Ignacio", "Yungay", "Coihueco", "Ñiquén", "San Carlos", "San Fabián", "San Nicolás"] },
  { region: "Biobío", comunas: ["Concepción", "Coronel", "Chiguayante", "Florida", "Hualqui", "Lota", "Penco", "San Pedro de la Paz", "Santa Juana", "Talcahuano", "Tomé", "Hualpén", "Lebu", "Arauco", "Cañete", "Contulmo", "Curanilahue", "Los Álamos", "Tirúa", "Los Ángeles", "Antuco", "Cabrero", "Laja", "Mulchén", "Nacimiento", "Negrete", "Quilaco", "Quilleco", "San Rosendo", "Santa Bárbara", "Tucapel", "Yumbel", "Alto Biobío"] },
  { region: "Araucanía", comunas: ["Temuco", "Carahue", "Cunco", "Curarrehue", "Freire", "Galvarino", "Gorbea", "Lautaro", "Loncoche", "Melipeuco", "Nueva Imperial", "Padre las Casas", "Perquenco", "Pitrufquén", "Pucón", "Saavedra", "Teodoro Schmidt", "Toltén", "Vilcún", "Villarrica", "Cholchol", "Angol", "Collipulli", "Curacautín", "Ercilla", "Lonquimay", "Los Sauces", "Lumaco", "Purén", "Renaico", "Traiguén", "Victoria"] },
  { region: "Los Ríos", comunas: ["Valdivia", "Corral", "Lanco", "Los Lagos", "Máfil", "Mariquina", "Paillaco", "Panguipulli", "La Unión", "Futrono", "Lago Ranco", "Río Bueno"] },
  { region: "Los Lagos", comunas: ["Puerto Montt", "Calbuco", "Cochamó", "Fresia", "Frutillar", "Los Muermos", "Llanquihue", "Maullín", "Puerto Varas", "Castro", "Ancud", "Chonchi", "Curaco de Vélez", "Dalcahue", "Puqueldón", "Queilén", "Quellón", "Quemchi", "Quinchao", "Osorno", "Puerto Octay", "Purranque", "Puyehue", "Río Negro", "San Juan de la Costa", "San Pablo", "Chaitén", "Futaleufú", "Hualaihué", "Palena"] },
  { region: "Aysén", comunas: ["Coihaique", "Lago Verde", "Aisén", "Cisnes", "Guaitecas", "Cochrane", "O'Higgins", "Tortel", "Chile Chico", "Río Ibáñez"] },
  { region: "Magallanes", comunas: ["Punta Arenas", "Laguna Blanca", "Río Verde", "San Gregorio", "Cabo de Hornos", "Antártica", "Porvenir", "Primavera", "Timaukel", "Natales", "Torres del Paine"] },
  { region: "Metropolitana", comunas: ["Cerrillos", "Cerro Navia", "Conchalí", "El Bosque", "Estación Central", "Huechuraba", "Independencia", "La Cisterna", "La Florida", "La Granja", "La Pintana", "La Reina", "Las Condes", "Lo Barnechea", "Lo Espejo", "Lo Prado", "Macul", "Maipú", "Ñuñoa", "Pedro Aguirre Cerda", "Peñalolén", "Providencia", "Pudahuel", "Quilicura", "Quinta Normal", "Recoleta", "Renca", "Santiago", "San Joaquín", "San Miguel", "San Ramón", "Vitacura", "Puente Alto", "Pirque", "San José de Maipo", "Colina", "Lampa", "Tiltil", "San Bernardo", "Buin", "Calera de Tango", "Paine", "Melipilla", "Alhué", "Curacaví", "María Pinto", "San Pedro", "Talagante", "El Monte", "Isla de Maipo", "Padre Hurtado", "Peñaflor"] },
];

/** Todas las comunas, en orden alfabético (para la lista del formulario). */
export const COMUNAS: string[] = COMUNAS_POR_REGION.flatMap(r => r.comunas).sort((a, b) => a.localeCompare(b, 'es'));

/** Clave de comparación: sin tildes, minúsculas, sin puntuación. */
export function claveComuna(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’'.\-]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Otras formas comunes de escribir algunas comunas.
const ALIAS: Record<string, string> = {
  'santiago centro': 'Santiago', 'stgo': 'Santiago', 'stgo centro': 'Santiago',
  'coyhaique': 'Coihaique', 'aysen': 'Aisén', 'puerto aysen': 'Aisén',
  'til til': 'Tiltil', 'llay llay': 'Llaillay', 'marchigue': 'Marchihue',
  'paihuano': 'Paiguano', 'la calera': 'Calera', 'navarino': 'Cabo de Hornos',
  'puerto williams': 'Cabo de Hornos', 'puerto natales': 'Natales',
  'chol chol': 'Cholchol', 'san jose de maipo': 'San José de Maipo',
  'santiago de chile': 'Santiago', 'vina': 'Viña del Mar', 'con con': 'Concón',
  // Sectores que la gente escribe como si fueran comunas.
  'chicureo': 'Colina', 'piedra roja': 'Colina', 'la dehesa': 'Lo Barnechea',
  'san carlos de apoquindo': 'Las Condes', 'renaca': 'Viña del Mar',
};

const POR_CLAVE = new Map<string, string>(COMUNAS.map(c => [claveComuna(c), c]));
for (const [k, v] of Object.entries(ALIAS)) POR_CLAVE.set(claveComuna(k), v);

/**
 * Devuelve el nombre oficial de la comuna, o null si no se reconoce.
 * Acepta tildes/mayúsculas distintas, "comuna de …" y lo que agrega el
 * autocompletar después de una coma ("Las Condes, Metropolitana de Santiago").
 */
export function normalizarComuna(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  // Lo que va antes de una coma o un guion: "Vitacura - Santiago", "Las Condes, RM".
  for (const parte of [s, s.split(',')[0], s.split(/\s[-–]\s/)[0]]) {
    const k = claveComuna(parte).replace(/^comuna de /, '');
    const c = POR_CLAVE.get(k);
    if (c) return c;
  }
  return null;
}
