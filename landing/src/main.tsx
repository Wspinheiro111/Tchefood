import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const raiz = document.getElementById('root')!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

// No build a página já vem pré-renderizada (scripts/prerender.mjs): só hidrata.
// No `npm run dev` a raiz vem vazia e o React monta do zero.
if (raiz.hasChildNodes()) hydrateRoot(raiz, app);
else createRoot(raiz).render(app);
