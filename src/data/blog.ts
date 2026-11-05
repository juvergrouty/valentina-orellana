// Artículos del blog. Los que tienen `publicado: false` aparecen en la portada
// del blog como "Próximamente" y no enlazan a ninguna página.

export type Categoria = 'Patrones' | 'Trauma' | 'Vínculos' | 'Autoestima' | 'Hombres';

export interface Articulo {
  slug: string;
  titulo: string;
  /** Título para Google (pestaña y resultados). El `titulo` poético queda en la página. */
  seoTitulo?: string;
  bajada: string;
  categoria: Categoria;
  etiqueta: string;
  publicado: boolean;
}

export const articulos: Articulo[] = [
  {
    slug: 'manifiestas-y-sigues-en-el-mismo-lugar',
    titulo: '¿Manifiestas año a año y sigues en el mismo lugar?',
    seoTitulo: 'Manifestación: por qué no basta para cambiar',
    bajada: 'Por qué decir lo que queremos no basta para crear una nueva realidad, y qué hace falta, en todos los niveles, para que el cambio sea posible.',
    categoria: 'Patrones',
    etiqueta: 'Identidad y cambio',
    publicado: true,
  },
  {
    slug: 'cuando-su-silencio-se-siente-como-abandono',
    titulo: 'Cuando su silencio se siente como abandono',
    seoTitulo: 'Ansiedad cuando no responde: apego y abandono',
    bajada: 'Por qué la demora de alguien que queremos puede sentirse como abandono, y qué tiene que ver eso con el lugar donde buscamos nuestro valor.',
    categoria: 'Vínculos',
    etiqueta: 'Apego',
    publicado: true,
  },
  {
    slug: 'por-que-se-pelea-mas-en-vacaciones',
    titulo: 'Por qué se pelea más en vacaciones',
    seoTitulo: 'Peleas de pareja en vacaciones: por qué pasan',
    bajada: 'Lo que las vacaciones dejan a la vista de una pareja cuando se cae la rutina, si funciona como equipo y cómo se comunica.',
    categoria: 'Vínculos',
    etiqueta: 'Pareja',
    publicado: true,
  },
  {
    slug: 'la-casa-de-tus-papas-como-espejo',
    titulo: 'La casa de tus papás como espejo',
    seoTitulo: 'Volver a la casa de tus papás en las fiestas',
    bajada: 'Por qué volver a la casa familiar en las fiestas destapa lo que la vida adulta nos permitió tapar, y cómo vivir esos días con más calma.',
    categoria: 'Vínculos',
    etiqueta: 'Familia',
    publicado: true,
  },
  {
    slug: 'lo-que-haces-tambien-cambia-quien-crees-ser',
    titulo: 'Lo que haces también cambia quién crees ser',
    seoTitulo: 'Cómo cambiar la idea que tienes de ti',
    bajada: 'Por qué ante un mismo comentario dos personas reaccionan distinto, y cómo actuar diferente también va cambiando la idea que tenemos de nosotros.',
    categoria: 'Patrones',
    etiqueta: 'Identidad y cambio',
    publicado: true,
  },
  {
    slug: 'la-loza-de-las-visitas',
    titulo: 'La loza de las visitas',
    seoTitulo: 'Autoestima: por qué nos castigamos al fallar',
    bajada: 'Por qué guardamos lo mejor para los demás, nos castigamos al fallar y qué cambia cuando nos sentimos queridos solo por existir.',
    categoria: 'Autoestima',
    etiqueta: 'Autoestima',
    publicado: true,
  },
  {
    slug: 'ya-no-nos-amamos',
    titulo: '¿Ya no nos amamos?',
    seoTitulo: '¿Ya no nos amamos? Desconexión en la pareja',
    bajada: 'Cuando una pareja se desconecta, la distancia suele armarse con todo lo que no se dice.',
    categoria: 'Vínculos',
    etiqueta: 'Pareja',
    publicado: true,
  },
  {
    slug: 'volver-a-elegirse',
    titulo: 'Volver a elegirse',
    seoTitulo: 'Cómo reencontrarse como pareja después de alejarse',
    bajada: 'Qué hace falta para que una pareja que se alejó pueda reencontrarse.',
    categoria: 'Vínculos',
    etiqueta: 'Pareja',
    publicado: true,
  },
  {
    slug: 'nadie-nos-ensena-a-ser-pareja',
    titulo: 'Nadie nos enseña a ser pareja',
    seoTitulo: 'Lo que nadie nos enseña sobre ser pareja',
    bajada: 'Para quienes descubrieron, al terminar una relación importante, que nadie les enseñó a cuidarla.',
    categoria: 'Vínculos',
    etiqueta: 'Pareja',
    publicado: true,
  },
  {
    slug: 'el-hombre-que-puede-solo',
    titulo: 'El hombre que puede solo',
    seoTitulo: 'Hombres que no piden ayuda: el costo de poder solo',
    bajada: 'Sobre la desconexión que funciona durante años, hasta que un día deja de funcionar.',
    categoria: 'Hombres',
    etiqueta: 'Hombres y salud emocional',
    publicado: true,
  },
  {
    slug: 'lo-entiendo-todo-y-aun-asi-no-cambio',
    titulo: 'Lo entiendo todo y aun así no cambio',
    seoTitulo: 'Por qué entender tu historia no basta para cambiar',
    bajada: 'Por qué entender tu historia no siempre alcanza.',
    categoria: 'Patrones',
    etiqueta: 'Patrones',
    publicado: true,
  },
  {
    slug: 'el-personaje-que-sacamos-a-pasear',
    titulo: 'El personaje que sacamos a pasear',
    seoTitulo: 'Ser otra persona para que te quieran',
    bajada: 'Cuando sentimos que tenemos que ser otra persona para que nos quieran.',
    categoria: 'Autoestima',
    etiqueta: 'Autoestima',
    publicado: true,
  },
  {
    slug: 'puedo',
    titulo: '¿Puedo?',
    seoTitulo: 'Culpa al descansar, necesitar o decir que no',
    bajada: 'La pregunta que muchos se hacen antes de necesitar, descansar o decir que no.',
    categoria: 'Vínculos',
    etiqueta: 'Vínculos',
    publicado: true,
  },
  {
    slug: 'tu-patron-te-protegio-de-algo',
    titulo: 'Tu patrón te protegió de algo',
    seoTitulo: 'Patrones que se repiten: de qué te protegieron',
    bajada: 'Lo que quedaría expuesto si dejaras de funcionar así.',
    categoria: 'Patrones',
    etiqueta: 'Patrones',
    publicado: true,
  },
  {
    slug: 'lo-que-te-paso-te-organizo',
    titulo: 'Lo que te pasó te organizó',
    seoTitulo: 'Cómo la infancia organiza tu forma de ver el mundo',
    bajada: 'Cómo las experiencias de la infancia forman nuestra manera de ver el mundo, y por qué eso puede reorganizarse.',
    categoria: 'Trauma',
    etiqueta: 'Trauma de infancia',
    publicado: true,
  },
];

export const categorias: Categoria[] = ['Patrones', 'Trauma', 'Vínculos', 'Autoestima', 'Hombres'];

// Fechas de publicación y última edición del texto de cada artículo (AAAA-MM-DD),
// tomadas del historial de git. Las usan el JSON-LD del artículo y el <lastmod>
// del mapa del sitio. Artículo nuevo o editado: agregarlo o actualizarlo aquí.
export const FECHAS: Record<string, [string, string]> = {
  'manifiestas-y-sigues-en-el-mismo-lugar':      ['2026-11-05', '2026-11-05'],
  'lo-entiendo-todo-y-aun-asi-no-cambio':        ['2026-09-29', '2026-10-04'],
  'el-personaje-que-sacamos-a-pasear':           ['2026-09-29', '2026-10-04'],
  'puedo':                                       ['2026-09-29', '2026-10-04'],
  'tu-patron-te-protegio-de-algo':               ['2026-09-29', '2026-10-04'],
  'lo-que-te-paso-te-organizo':                  ['2026-09-29', '2026-10-04'],
  'el-hombre-que-puede-solo':                    ['2026-09-29', '2026-10-04'],
  'la-loza-de-las-visitas':                      ['2026-09-30', '2026-10-08'],
  'ya-no-nos-amamos':                            ['2026-10-03', '2026-10-04'],
  'volver-a-elegirse':                           ['2026-10-03', '2026-10-04'],
  'nadie-nos-ensena-a-ser-pareja':               ['2026-10-17', '2026-10-17'],
  'lo-que-haces-tambien-cambia-quien-crees-ser': ['2026-10-17', '2026-10-17'],
  'la-casa-de-tus-papas-como-espejo':            ['2026-11-03', '2026-11-03'],
  'por-que-se-pelea-mas-en-vacaciones':          ['2026-11-03', '2026-11-03'],
  'cuando-su-silencio-se-siente-como-abandono':  ['2026-11-04', '2026-11-04'],
};
