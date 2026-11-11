/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Endereço público do site (ex.: https://tchefood.com.br). Ver src/lib/config.ts. */
  readonly VITE_SITE_URL?: string;
}

/** Ano do build, fixo no HTML pré-renderizado e no JavaScript (sem divergir na hidratação). */
declare const __ANO_BUILD__: number;
