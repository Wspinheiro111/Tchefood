/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#0f172a',
        surface: '#1e293b',
        brasa: '#D2232A', // vermelho oficial da marca
        verde: '#0B7A3B', // verde oficial da marca
        amarelo: '#FFCB05', // amarelo oficial da marca
        ouro: '#f59e0b',
        stone: '#10b981',
        pagbank: '#eab308',
      },
      minHeight: { touch: '48px', 'touch-lg': '56px' },
      keyframes: {
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(210,35,42,0.6)' },
          '100%': { boxShadow: '0 0 0 14px rgba(210,35,42,0)' },
        },
        'slide-up': {
          '0%': { transform: 'translateY(100%)' },
          '100%': { transform: 'translateY(0)' },
        },
      },
      animation: {
        'pulse-ring': 'pulse-ring 1.2s ease-out infinite',
        'slide-up': 'slide-up 180ms ease-out',
      },
    },
  },
  plugins: [],
};
