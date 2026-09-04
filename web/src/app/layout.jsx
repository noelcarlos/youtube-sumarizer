import { Inter, JetBrains_Mono } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import { ThemeProvider } from '../components/ThemeProvider.jsx';
import './globals.css';

// next/font en vez del <link> a Google Fonts que usaba web/index.html con Vite: descarga las
// fuentes en build time y las auto-hostea, sin request externo en cada visita ni parpadeo de
// fuente sin cargar (FOUT) - un beneficio real de venir a Next, no solo mover archivos.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono' });

export const metadata = {
  title: 'youtube-sumarizer — cola',
};

export default async function RootLayout({ children }) {
  const locale = await getLocale();

  return (
    <html lang={locale} className={`${inter.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body>
        {/* Sin `messages` explicito: las coge de src/i18n/request.js via el plugin de
            next.config.js. El Provider hace que useTranslations() funcione en TODO el arbol de
            cliente de abajo, incluido Queue.jsx aunque se monte con dynamic(ssr:false) — el
            contexto de React atraviesa ese limite sin problema, solo se desactiva el renderizado
            en servidor de ESE componente en concreto. */}
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <NextIntlClientProvider>{children}</NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
