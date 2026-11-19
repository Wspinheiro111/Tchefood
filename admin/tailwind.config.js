/** @type {import('tailwindcss').Config} */
export default {
  content: { relative: true, files: ['./index.html', './src/**/*.{ts,tsx}'] },
  theme: {
    extend: {
      colors: {
        fundo: '#ffffff',
        surface: '#f8fafc',
        borda: '#e2e8f0',
        brasa: '#D2232A', // vermelho oficial da marca
        verde: '#0B7A3B', // verde oficial da marca
        amarelo: '#FFCB05', // amarelo oficial da marca
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
