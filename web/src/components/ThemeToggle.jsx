'use client';

import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { Monitor, Moon, Sun } from 'lucide-react';

const MODES = [
  { value: 'light', Icon: Sun },
  { value: 'dark', Icon: Moon },
  { value: 'system', Icon: Monitor },
];

/** Espera al mount antes de leer `theme`: next-themes no conoce el tema real hasta que el
 * script inyectado en <html> corre en el navegador, así que en el primer render de servidor
 * `theme` siempre es undefined — evita ese parpadeo mostrando nada hasta entonces. */
export function ThemeToggle() {
  const t = useTranslations('ThemeToggle');
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="flex flex-shrink-0 items-center gap-0.5 rounded-full border border-border bg-secondary p-0.5">
      {MODES.map(({ value, Icon }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          title={t('switchTo', { mode: t(value) })}
          aria-label={t('switchTo', { mode: t(value) })}
          className={
            'flex items-center justify-center rounded-full p-1.5 transition-colors ' +
            (mounted && theme === value ? 'bg-primary text-primary-foreground' : 'text-muted hover:text-text')
          }
        >
          <Icon size={13} />
        </button>
      ))}
    </div>
  );
}
