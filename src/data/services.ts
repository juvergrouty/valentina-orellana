export interface Service {
  id: string;
  title: string;
  description: string;
  duration: string;
  icon: string;
  image?: string;
  grupo: 'individual' | 'pareja'; // para pre-seleccionar en la agenda
}

export interface PricingPlan {
  id: string;
  title: string;
  price: number;
  currency: string;
  duration: string;
  modality: string;
  features: string[];
  highlighted?: boolean;
}

export const SESSION_TYPES = ['online', 'presencial', 'pareja-online', 'pareja-presencial'] as const;
export type SessionType = typeof SESSION_TYPES[number];

export const SESSION_LABELS: Record<SessionType, string> = {
  'online':             'Sesión Individual Online',
  'presencial':         'Sesión Individual Presencial',
  'pareja-online':      'Sesión de Pareja Online',
  'pareja-presencial':  'Sesión de Pareja Presencial',
};

export const services: Service[] = [
  {
    id: 'psicologia-adultos',
    title: 'Psicología de Adultos',
    description:
      'Acompañamiento terapéutico individual para el manejo de ansiedad, depresión, estrés, duelo y bienestar emocional en general.',
    duration: '50 min',
    icon: 'brain',
    image: '/images/servicio-adultos.jpg',
    grupo: 'individual',
  },
  {
    id: 'terapia-pareja',
    title: 'Terapia de Pareja',
    description:
      'Espacio de escucha y trabajo conjunto para mejorar la comunicación, resolver conflictos y fortalecer el vínculo.',
    duration: '60 min',
    icon: 'users',
    image: '/images/servicio-pareja.jpg',
    grupo: 'pareja',
  },
  {
    id: 'trauma',
    title: 'Trauma y PSA',
    description:
      'Tratamiento especializado para personas que han vivido experiencias traumáticas o que se reconocen como Personas Altamente Sensibles (PAS).',
    duration: '50 min',
    icon: 'leaf',
    image: '/images/servicio-trauma.jpg',
    grupo: 'individual',
  },
  {
    id: 'parentalidad',
    title: 'Parentalidad y Apego',
    description:
      'Orientación para padres y madres que buscan fortalecer el vínculo con sus hijos y desarrollar una crianza consciente.',
    duration: '50 min',
    icon: 'home',
    image: '/images/servicio-parentalidad.jpg',
    grupo: 'individual',
  },
];

export const pricingPlans: PricingPlan[] = [
  {
    id: 'online',
    title: 'Individual Online',
    price: 60000,
    currency: 'CLP',
    duration: '50 minutos',
    modality: 'Videollamada (Zoom / Meet)',
    features: [
      'Desde cualquier lugar de Chile',
      'Flexibilidad de horarios',
      'Confirmación inmediata',
      'Recordatorio por WhatsApp',
    ],
  },
  {
    id: 'presencial',
    title: 'Individual Presencial',
    price: 60000,
    currency: 'CLP',
    duration: '50 minutos',
    modality: 'Las Condes',
    features: [
      'Consulta en Santiago',
      'Ambiente cómodo y privado',
      'Confirmación inmediata',
      'Recordatorio por WhatsApp',
    ],
    highlighted: true,
  },
  {
    id: 'pareja-online',
    title: 'Pareja Online',
    price: 75000,
    currency: 'CLP',
    duration: '60 minutos',
    modality: 'Videollamada (Zoom / Meet)',
    features: [
      'Sesión para ambos',
      'Desde cualquier lugar de Chile',
      'Confirmación inmediata',
      'Recordatorio por WhatsApp',
    ],
  },
  {
    id: 'pareja-presencial',
    title: 'Pareja Presencial',
    price: 75000,
    currency: 'CLP',
    duration: '60 minutos',
    modality: 'Las Condes',
    features: [
      'Sesión para ambos',
      'Consulta en Santiago',
      'Confirmación inmediata',
      'Recordatorio por WhatsApp',
    ],
  },
];
