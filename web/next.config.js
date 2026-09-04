import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.js');

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      // Mismo patron que el proxy de Vite en dev: /api/* del PIPELINE va al backend real
      // (server.js), que sigue siendo el unico sitio que toca el pipeline y el filesystem.
      // Next.js aqui es solo la capa de frontend — a diferencia del proxy de Vite, esto TAMBIEN
      // funciona en produccion (`next start`), no solo en `next dev`.
      //
      // A proposito NO es un catch-all `/api/:path*`: /api/auth/* (next-auth) y /api/youtube/*
      // (Data API de YouTube) son rutas de ESTE Next.js, no del backend — un catch-all las
      // interceptaria antes de que Next.js llegue a resolverlas el mismo, porque las rutas
      // dinamicas (`[...nextauth]`) se comprueban DESPUES de estos rewrites, no antes.
      {
        source: '/api/state',
        destination: 'http://127.0.0.1:4577/api/state',
      },
      {
        source: '/api/enqueue',
        destination: 'http://127.0.0.1:4577/api/enqueue',
      },
      {
        source: '/api/settings',
        destination: 'http://127.0.0.1:4577/api/settings',
      },
      {
        source: '/api/settings/models',
        destination: 'http://127.0.0.1:4577/api/settings/models',
      },
      {
        source: '/api/videos/:path*',
        destination: 'http://127.0.0.1:4577/api/videos/:path*',
      },
    ];
  },
};

export default withNextIntl(nextConfig);
