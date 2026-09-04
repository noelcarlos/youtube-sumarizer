'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSession, signIn, signOut } from 'next-auth/react';
import { Loader2, RotateCcw, Send, MonitorPlay } from 'lucide-react';
import { Sheet, SheetContent } from './ui/sheet.jsx';

export function SubscriptionsDrawer() {
  const t = useTranslations('SubscriptionsDrawer');
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={t('openTitle')}
        aria-label={t('openTitle')}
        className="flex flex-shrink-0 items-center justify-center rounded-full p-1.5 text-muted transition-colors hover:bg-accent hover:text-text"
      >
        <MonitorPlay size={16} />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-none sm:w-[480px]">
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <h2 className="text-lg font-semibold tracking-tight text-text">{t('title')}</h2>
          </div>
          <SubscriptionsBody t={t} />
        </SheetContent>
      </Sheet>
    </>
  );
}

function SubscriptionsBody({ t }) {
  const { data: session, status } = useSession();

  if (status === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center text-muted">
        <Loader2 size={18} className="mr-2 animate-spin" /> {t('loading')}
      </div>
    );
  }

  if (status !== 'authenticated' || session?.error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <MonitorPlay size={32} className="text-muted" />
        <p className="text-sm text-muted">{session?.error ? t('reauthNeeded') : t('connectIntro')}</p>
        <button
          onClick={() => signIn('google')}
          className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          {t('connect')}
        </button>
      </div>
    );
  }

  return <VideoList t={t} />;
}

function VideoList({ t }) {
  const [videos, setVideos] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [enqueued, setEnqueued] = useState(() => new Set());

  async function load(refresh) {
    refresh ? setRefreshing(true) : setLoading(true);
    try {
      const res = await fetch(`/api/youtube/subscriptions${refresh ? '?refresh=1' : ''}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setVideos(body.videos);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { load(false); }, []);

  async function enqueue(url, videoId) {
    try {
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error(await res.text());
      setEnqueued((s) => new Set(s).add(videoId));
    } catch (err) {
      setError(t('enqueueFailed', { error: err.message }));
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-3">
        <p className="text-xs text-muted">{t('subscriptionsIntro')}</p>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          title={t('refresh')}
          aria-label={t('refresh')}
          className="flex flex-shrink-0 items-center justify-center rounded-lg border border-border p-1.5 text-muted transition-colors hover:bg-accent hover:text-text disabled:opacity-60"
        >
          <RotateCcw size={13} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading && (
        <div className="flex flex-1 items-center justify-center text-muted">
          <Loader2 size={18} className="mr-2 animate-spin" /> {t('loading')}
        </div>
      )}
      {error && <div className="p-6 text-sm text-error">{error}</div>}

      {!loading && !error && videos?.length === 0 && (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted">{t('empty')}</div>
      )}

      {!loading && videos?.length > 0 && (
        <div className="flex-1 divide-y divide-border overflow-y-auto">
          {videos.map((v) => (
            <div key={v.videoId} className="flex gap-3 px-6 py-3">
              <img
                src={v.thumbnail || `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`}
                alt=""
                width={120}
                height={68}
                className="h-[68px] w-[120px] flex-shrink-0 rounded-lg border border-border object-cover"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">{v.title}</p>
                <p className="mt-0.5 truncate text-xs text-muted">{v.channelTitle}</p>
                <button
                  onClick={() => enqueue(v.url, v.videoId)}
                  disabled={enqueued.has(v.videoId)}
                  className="mt-1.5 flex items-center gap-1 text-sm text-muted hover:text-text disabled:text-success"
                >
                  <Send size={12} />
                  {enqueued.has(v.videoId) ? t('enqueued') : t('enqueue')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Texto, no un icono al lado de "Actualizar" — un desconectar accidental de un click en
          el icono equivocado obliga a repetir todo el login de Google por nada. */}
      <div className="border-t border-border px-6 py-3">
        <button
          onClick={() => { if (confirm(t('disconnectConfirm'))) signOut(); }}
          className="text-xs text-muted underline-offset-2 hover:text-text hover:underline"
        >
          {t('disconnect')}
        </button>
      </div>
    </div>
  );
}
