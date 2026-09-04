'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { LayoutGrid, MonitorPlay } from 'lucide-react';
import { LanguageSwitcher } from './LanguageSwitcher.jsx';
import { ThemeToggle } from './ThemeToggle.jsx';
import { SettingsDrawer } from './SettingsDrawer.jsx';

/** Cabecera compartida entre "/" (cola) y "/subscriptions" — antes Suscripciones era un
 * drawer que se ensanchaba a pantalla completa y tapaba esto mismo; ahora es una pagina propia
 * para que el cambio de idioma/tema/settings siga a mano sin importar en cual estes. `center`
 * es el hueco para lo que cada pagina quiera poner en medio (el Stepper+StatusBadge de la cola,
 * por ejemplo) — Suscripciones no pasa nada y se queda vacio. */
export function AppHeader({ center }) {
  const t = useTranslations('AppHeader');
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 w-full border-b border-border bg-card/80 backdrop-blur-sm">
      <div className="flex w-full items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <h1 className="truncate text-base font-bold tracking-tight text-text lowercase">youtube-sumarizer</h1>
          <nav className="flex flex-shrink-0 items-center gap-0.5 rounded-full border border-border bg-secondary p-0.5">
            <Link
              href="/"
              title={t('navQueue')}
              aria-label={t('navQueue')}
              className={'flex items-center justify-center rounded-full p-1.5 transition-colors ' +
                (pathname === '/' ? 'bg-primary text-primary-foreground' : 'text-muted hover:text-text')}
            >
              <LayoutGrid size={14} />
            </Link>
            <Link
              href="/subscriptions"
              title={t('navSubscriptions')}
              aria-label={t('navSubscriptions')}
              className={'flex items-center justify-center rounded-full p-1.5 transition-colors ' +
                (pathname === '/subscriptions' ? 'bg-primary text-primary-foreground' : 'text-muted hover:text-text')}
            >
              <MonitorPlay size={14} />
            </Link>
          </nav>
        </div>
        {center}
        <div className="flex flex-shrink-0 items-center gap-2 sm:gap-3">
          <Clock />
          <ThemeToggle />
          <LanguageSwitcher />
          <SettingsDrawer />
        </div>
      </div>
    </header>
  );
}

function Clock() {
  const locale = useLocale();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="hidden flex-shrink-0 font-mono text-xs text-muted sm:inline">{now.toLocaleTimeString(locale)}</span>;
}
