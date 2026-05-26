/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        sand:    '#FAF7F4', // background principal web
        white:   '#FFFFFF',
        ink:     '#1A1A18', // negro cálido editorial
        stone:   '#6B6860', // texto secundario
        dust:    '#DDD8CF', // bordes, separadores
        warm:    '#F4F0EC', // fondos alternativos (sección trust bar)
        review:  '#DDDCD1', // fondo sección reseñas
        header:  '#F5F1EC', // fondo header
        gold:    '#A8906C', // acento dorado (pequeños detalles)
        forest:  '#576352', // verde — color primario de CTAs e íconos
      },
      fontFamily: {
        heading: ['Cormorant Garamond', 'Georgia', 'serif'],
        body:    ['Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        'display': ['clamp(2.4rem, 5vw, 4.2rem)',   { lineHeight: '1.05', letterSpacing: '-0.02em' }],
        'title':   ['clamp(1.8rem, 3.5vw, 2.8rem)', { lineHeight: '1.1',  letterSpacing: '-0.015em' }],
        'card':    ['clamp(1.3rem, 2vw, 1.6rem)',   { lineHeight: '1.2',  letterSpacing: '-0.01em' }],
        'quote':   ['clamp(1.1rem, 2vw, 1.6rem)',   { lineHeight: '1.7' }],
      },
      letterSpacing: {
        widest2: '0.2em',
      },
      maxWidth: {
        site: '1600px',
      },
      spacing: {
        section:    '7rem',
        'section-sm': '4rem',
      },
      borderRadius: {
        btn: '4px',
      },
    },
  },
  plugins: [],
};
