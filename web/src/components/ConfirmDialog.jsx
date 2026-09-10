'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.jsx';

/** Reemplaza el `confirm()` nativo del navegador (feo, no respeta el tema/idioma de la app, y en
 * algunos navegadores se puede desactivar sin que el código se entere) por un dialogo propio.
 * Uso: `const { confirm, ConfirmDialog } = useConfirmDialog(); if (!(await confirm(mensaje)))
 * return; ... renderiza {ConfirmDialog} una vez en el JSX del componente. */
export function useConfirmDialog() {
  const t = useTranslations('Common');
  const [pending, setPending] = useState(null); // { message, resolve } | null

  const confirm = useCallback((message) => {
    return new Promise((resolve) => setPending({ message, resolve }));
  }, []);

  function respond(value) {
    pending?.resolve(value);
    setPending(null);
  }

  const ConfirmDialog = (
    <Dialog open={Boolean(pending)} onOpenChange={(open) => { if (!open) respond(false); }}>
      <DialogContent className="max-w-sm gap-4 rounded-md">
        <DialogHeader>
          <DialogTitle className="font-serif text-base">{t('confirmTitle')}</DialogTitle>
          <DialogDescription className="text-sm text-muted">{pending?.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <button
            onClick={() => respond(false)}
            className="rounded-sm px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-accent hover:text-text"
          >
            {t('cancel')}
          </button>
          <button
            onClick={() => respond(true)}
            className="rounded-sm bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            {t('confirm')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, ConfirmDialog };
}
