/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        sand:    '#F5F0E8', // cream background principal
        white:   '#FFFFFF',
        ink:     '#1A1A18', // negro cálido editorial
        stone:   '#6B6860', // texto secundario
        dust:    '#DDD8CF', // bordes, separadores
        warm:    '#ECE8E0', // fondos alternativos
        gold:    '#A8906C', // acento dorado (pequeños detalles)
        forest:  '#3B5040', // verde oscuro — color primario de CTAs e íconos
      },
      fontFamily: {
        heading: ['Cormorant Garamond', 'Georgia', 'serif'],
        body:    ['Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        'display': ['clamp(2.5rem, 5.5vw, 5rem)', { lineHeight: '1.05', letterSpacing: '-0.02em' }],
        'title':   ['clamp(1.75rem, 3.5vw, 3rem)', { lineHeight: '1.1', letterSpacing: '-0.015em' }],
        'lead':    ['clamp(0.95rem, 1.5vw, 1.1rem)', { lineHeight: '1.75' }],
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
