'use client';

import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';

const LOCALES = [
  { code: 'es', label: 'ES' },
  { code: 'en', label: 'EN' },
];

/** Sin rutas por idioma: cambiar de idioma es solo escribir la cookie que lee
 * src/i18n/request.js y pedirle al router que vuelva a pedir los Server Components — eso
 * re-resuelve el locale con la cookie nueva y manda mensajes frescos al provider de layout.jsx. */
export function LanguageSwitcher() {
  const locale = useLocale();
  const router = useRouter();

  function setLocale(code) {
    document.cookie = `NEXT_LOCALE=${code}; path=/; max-age=31536000`;
    router.refresh();
  }

  return (
    <div className="flex flex-shrink-0 items-center gap-0.5 rounded-full border border-border bg-zinc-50 p-0.5 font-mono text-xs">
      {LOCALES.map(({ code, label }) => (
        <button
          key={code}
          onClick={() => setLocale(code)}
          className={
            'rounded-full px-2 py-0.5 transition-colors ' +
            (locale === code ? 'bg-primary text-white' : 'text-muted hover:text-text')
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
}
