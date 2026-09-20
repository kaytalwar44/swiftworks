import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],

    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },

    server: {
      port: 5173,
      strictPort: true,
      host: true,
    },

    preview: {
      port: 4173,
      strictPort: true,
    },

    build: {
      target: 'es2022',
      outDir: 'dist',
      sourcemap: mode !== 'production',
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          // Split the heavy vendors so an app-code change does not invalidate
          // the whole bundle for a returning user.
          manualChunks: {
            'react-vendor': ['react', 'react-dom', 'react-router'],
            'supabase': ['@supabase/supabase-js'],
            'query': ['@tanstack/react-query'],
            'charts': ['recharts'],
            'forms': ['react-hook-form', 'zod', '@hookform/resolvers'],
          },
        },
      },
    },

    define: {
      __APP_VERSION__: JSON.stringify(env.npm_package_version ?? '0.0.0'),
    },

    optimizeDeps: {
      include: ['react', 'react-dom', 'react-router', '@supabase/supabase-js'],
    },
  };
});
