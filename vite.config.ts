import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Only proxy "/api/..." — a bare "/api" prefix would also capture the
    // frontend module "/api.ts" and break the dev build.
    proxy: {
      '/api/': 'http://localhost:3000',
    },
  },
});
