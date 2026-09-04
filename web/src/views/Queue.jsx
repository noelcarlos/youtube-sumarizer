'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useQueueState } from '../hooks/useQueueState.js';
import { EnqueueForm } from '../components/EnqueueForm.jsx';
import { StageTabs } from '../components/StageTabs.jsx';
import { VideoCard } from '../components/VideoCard.jsx';
import { VideoCardSkeleton } from '../components/VideoCardSkeleton.jsx';
import { ReaderDrawer } from '../components/ReaderDrawer.jsx';
import { LanguageSwitcher } from '../components/LanguageSwitcher.jsx';
import { ThemeToggle } from '../components/ThemeToggle.jsx';
import { matchesTab, isProcessing } from '../stages.js';

export function Queue() {
  const t = useTranslations('Queue');
  const { videos, error, loading } = useQueueState();
  const [tab, setTab] = useState('ALL');
  const [readerVideoId, setReaderVideoId] = useState(null);
  const visible = videos.filter((v) => matchesTab(v, tab));
  const activeCount = videos.filter(isProcessing).length;

  return (
    <div className="min-h-screen w-full bg-bg">
      <header className="sticky top-0 z-10 w-full border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="flex w-full items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <h1 className="truncate text-base font-bold tracking-tight text-text lowercase">youtube-sumarizer</h1>
            <StatusBadge activeCount={activeCount} />
          </div>
          <Stepper />
          <div className="flex flex-shrink-0 items-center gap-2 sm:gap-3">
            <Clock />
            <ThemeToggle />
            <LanguageSwitcher />
          </div>
        </div>
      </header>

      {/* w-full max-w-none a proposito: nada de contenedor centrado con margenes muertos a los
          lados en pantallas anchas — el espacio extra lo absorbe la grid de tarjetas de mas
          columnas, no un hueco vacio. */}
      <main className="w-full max-w-none px-4 py-8 pb-20 sm:px-6">
        {error && (
          <p className="mb-4 rounded-xl border border-error/20 bg-error-bg px-3 py-2 text-sm text-error">
            {t('serverError', { error })}
          </p>
        )}

        <EnqueueForm onEnqueued={() => {}} />
        <StageTabs videos={videos} active={tab} onChange={setTab} />

        {loading ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <VideoCardSkeleton key={i} />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-16 text-center">
            <p className="text-sm text-muted">{videos.length === 0 ? t('emptyAll') : t('emptyTab')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {visible.map((v) => (
              <VideoCard key={v.videoId} video={v} onOpenReader={setReaderVideoId} />
            ))}
          </div>
        )}
      </main>

      <ReaderDrawer videoId={readerVideoId} onClose={() => setReaderVideoId(null)} />
    </div>
  );
}

function Stepper() {
  const t = useTranslations('Header');
  const steps = t.raw('pipelineSteps');
  return (
    <div className="hidden items-center gap-1.5 font-mono text-xs text-muted md:flex">
      {steps.map((step, i) => (
        <span key={step} className="flex items-center gap-1.5">
          {step}
          {i < steps.length - 1 && <span className="text-border-hover">→</span>}
        </span>
      ))}
    </div>
  );
}

function StatusBadge({ activeCount }) {
  const t = useTranslations('Header');
  const active = activeCount > 0;
  return (
    <span
      className={
        'flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-xs font-medium ' +
        (active ? 'border-warn/30 bg-warn-bg text-warn' : 'border-border bg-secondary text-muted')
      }
    >
      <span className={'relative flex h-2 w-2 items-center justify-center'}>
        <span className={'absolute h-2 w-2 animate-pulse rounded-full ' + (active ? 'bg-warn' : 'bg-muted')} />
      </span>
      {active ? t('processing', { count: activeCount }) : t('idle')}
    </span>
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
