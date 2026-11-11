import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __ANO_BUILD__: JSON.stringify(new Date().getFullYear()),
  },
});
