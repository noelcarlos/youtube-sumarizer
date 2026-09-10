import { Fraunces, IBM_Plex_Sans, JetBrains_Mono } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import { ThemeProvider } from '../components/ThemeProvider.jsx';
import { AuthProvider } from '../components/AuthProvider.jsx';
import './globals.css';

// next/font en vez del <link> a Google Fonts que usaba web/index.html con Vite: descarga las
// fuentes en build time y las auto-hostea, sin request externo en cada visita ni parpadeo de
// fuente sin cargar (FOUT) - un beneficio real de venir a Next, no solo mover archivos.
// Fraunces para titulos/lectura (caracter editorial, la app termina en "leer un resumen"),
// IBM Plex Sans para la interfaz (temperamento tecnico, coherente con un panel de control de
// pipeline) — dos papeles bien distintos, no la pareja Inter+system-ui por defecto.
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', axes: ['opsz', 'SOFT', 'WONK'] });
const plexSans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-plex-sans' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono' });

export const metadata = {
  title: 'youtube-sumarizer — cola',
};

export default async function RootLayout({ children }) {
  const locale = await getLocale();

  return (
    <html lang={locale} className={`${fraunces.variable} ${plexSans.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body>
        {/* Sin `messages` explicito: las coge de src/i18n/request.js via el plugin de
            next.config.js. El Provider hace que useTranslations() funcione en TODO el arbol de
            cliente de abajo, incluido Queue.jsx aunque se monte con dynamic(ssr:false) — el
            contexto de React atraviesa ese limite sin problema, solo se desactiva el renderizado
            en servidor de ESE componente en concreto. */}
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <NextIntlClientProvider>
            <AuthProvider>{children}</AuthProvider>
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
