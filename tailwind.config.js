/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#0f172a',
        surface: '#1e293b',
        brasa: '#e11d48',
        ouro: '#f59e0b',
        stone: '#10b981',
        pagbank: '#eab308',
      },
      minHeight: { touch: '48px', 'touch-lg': '56px' },
      keyframes: {
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(225,29,72,0.6)' },
          '100%': { boxShadow: '0 0 0 14px rgba(225,29,72,0)' },
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
