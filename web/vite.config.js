import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      // 127.0.0.1, no 'localhost': server.js escucha explicitamente ahi (ver server.js) para no
      // repetir el choque de iron-agile-bot con este mismo proyecto — 'localhost' puede resolver a
      // ::1 primero, y si CUALQUIER otro proceso tiene el wildcard de ese puerto en IPv6, el proxy
      // le manda todo el trafico de /api a el en vez de a este servidor.
      '/api': 'http://127.0.0.1:4577',
    },
  },
});
