import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// next/font en vez del <link> a Google Fonts que usaba web/index.html con Vite: descarga las
// fuentes en build time y las auto-hostea, sin request externo en cada visita ni parpadeo de
// fuente sin cargar (FOUT) - un beneficio real de venir a Next, no solo mover archivos.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono' });

export const metadata = {
  title: 'youtube-sumarizer — cola',
};

export default function RootLayout({ children }) {
  return (
    <html lang="es" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
