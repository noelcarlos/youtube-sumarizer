/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      // Mismo patron que el proxy de Vite en dev: /api/* va al backend real (server.js), que
      // sigue siendo el unico sitio que toca el pipeline y el filesystem. Next.js aqui es solo
      // la capa de frontend — a diferencia del proxy de Vite, esto TAMBIEN funciona en produccion
      // (`next start`), no solo en `next dev`.
      {
        source: '/api/:path*',
        destination: 'http://127.0.0.1:4577/api/:path*',
      },
    ];
  },
};

export default nextConfig;
