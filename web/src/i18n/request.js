import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';

export const SUPPORTED_LOCALES = ['es', 'en'];
export const DEFAULT_LOCALE = 'es';

/** Sin rutas /es /en — es un dashboard de una sola pagina, no hace falta enrutado por idioma
 * (asi lo soporta next-intl explicitamente, ver su modo "without i18n routing"). El idioma se
 * guarda en una cookie: si no existe todavia (primera visita), se detecta del header
 * Accept-Language del navegador; si el usuario lo cambia a mano en el selector, la cookie manda
 * a partir de ahi. */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  let locale = cookieStore.get('NEXT_LOCALE')?.value;

  if (!locale) {
    const acceptLanguage = (await headers()).get('accept-language') || '';
    locale = acceptLanguage.toLowerCase().startsWith('en') ? 'en' : DEFAULT_LOCALE;
  }
  if (!SUPPORTED_LOCALES.includes(locale)) locale = DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
