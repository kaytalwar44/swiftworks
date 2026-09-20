/// <reference types="vite/client" />

/** Injected by vite.config.ts `define`. Surfaced in the app footer. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Supabase project URL, e.g. [xxxx.supabase.co](https://xxxx.supabase.co) */
  readonly VITE_SUPABASE_URL: string;

  /** Supabase anon (publishable) key. Safe in the client — RLS protects data. */
  readonly VITE_SUPABASE_ANON_KEY: string;

  /** Public origin of this app, used to build QR booking URLs. */
  readonly VITE_APP_URL: string;

  /** Deployment environment. Drives logging and error reporting. */
  readonly VITE_APP_ENV: 'development' | 'staging' | 'production';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
