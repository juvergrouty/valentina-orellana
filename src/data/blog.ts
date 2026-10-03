// Artículos del blog. Los que tienen `publicado: false` aparecen en la portada
// del blog como "Próximamente" y no enlazan a ninguna página.

export type Categoria = 'Patrones' | 'Trauma' | 'Vínculos' | 'Autoestima' | 'Hombres';

export interface Articulo {
  slug: string;
  titulo: string;
  bajada: string;
  categoria: Categoria;
  etiqueta: string;
  publicado: boolean;
}

export const articulos: Articulo[] = [
  {
    slug: 'la-loza-de-las-visitas',
    titulo: 'La loza de las visitas',
    bajada: 'Por qué guardamos lo mejor para los demás, nos castigamos al fallar y qué cambia cuando nos sentimos queridos solo por existir.',
    categoria: 'Autoestima',
    etiqueta: 'Autoestima',
    publicado: true,
  },
  {
    slug: 'ya-no-nos-amamos',
    titulo: '¿Ya no nos amamos?',
    bajada: 'Cuando una pareja se desconecta, la distancia suele armarse con todo lo que no se dice.',
    categoria: 'Vínculos',
    etiqueta: 'Pareja',
    publicado: true,
  },
  {
    slug: 'el-hombre-que-puede-solo',
    titulo: 'El hombre que puede solo',
    bajada: 'Sobre la desconexión que funciona durante años, hasta que un día deja de funcionar.',
    categoria: 'Hombres',
    etiqueta: 'Hombres y salud emocional',
    publicado: true,
  },
  {
    slug: 'lo-entiendo-todo-y-aun-asi-no-cambio',
    titulo: 'Lo entiendo todo y aun así no cambio',
    bajada: 'Por qué entender tu historia no siempre alcanza.',
    categoria: 'Patrones',
    etiqueta: 'Patrones',
    publicado: true,
  },
  {
    slug: 'el-personaje-que-sacamos-a-pasear',
    titulo: 'El personaje que sacamos a pasear',
    bajada: 'Cuando sentimos que tenemos que ser otra persona para que nos quieran.',
    categoria: 'Autoestima',
    etiqueta: 'Autoestima',
    publicado: true,
  },
  {
    slug: 'puedo',
    titulo: '¿Puedo?',
    bajada: 'La pregunta que muchos se hacen antes de necesitar, descansar o decir que no.',
    categoria: 'Vínculos',
    etiqueta: 'Vínculos',
    publicado: true,
  },
  {
    slug: 'tu-patron-te-protegio-de-algo',
    titulo: 'Tu patrón te protegió de algo',
    bajada: 'Lo que quedaría expuesto si dejaras de funcionar así.',
    categoria: 'Patrones',
    etiqueta: 'Patrones',
    publicado: true,
  },
  {
    slug: 'lo-que-te-paso-te-organizo',
    titulo: 'Lo que te pasó te organizó',
    bajada: 'Cómo las experiencias de la infancia forman nuestra manera de ver el mundo, y por qué eso puede reorganizarse.',
    categoria: 'Trauma',
    etiqueta: 'Trauma de infancia',
    publicado: true,
  },
];

export const categorias: Categoria[] = ['Patrones', 'Trauma', 'Vínculos', 'Autoestima', 'Hombres'];
