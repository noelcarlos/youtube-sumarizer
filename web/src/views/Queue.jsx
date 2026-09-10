'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueueState } from '../hooks/useQueueState.js';
import { EnqueueForm } from '../components/EnqueueForm.jsx';
import { StageTabs } from '../components/StageTabs.jsx';
import { VideoCard } from '../components/VideoCard.jsx';
import { VideoCardSkeleton } from '../components/VideoCardSkeleton.jsx';
import { ReaderDrawer } from '../components/ReaderDrawer.jsx';
import { AppHeader } from '../components/AppHeader.jsx';
import { matchesTab, isProcessing } from '../stages.js';

export function Queue() {
  const t = useTranslations('Queue');
  const { videos, error, loading } = useQueueState();
  // DONE por defecto, no ALL: al entrar lo mas probable es que vengas a LEER algo ya terminado,
  // no a mirar el estado de la cola — quien quiera ver todo solo tiene que pulsar esa pestaña.
  const [tab, setTab] = useState('DONE');
  const [readFilter, setReadFilter] = useState('all'); // 'all' | 'unread' | 'read' — solo aplica dentro de Done
  const [readerVideoId, setReaderVideoId] = useState(null);
  const visible = videos
    .filter((v) => matchesTab(v, tab))
    .filter((v) => {
      if (tab !== 'DONE' || readFilter === 'all') return true;
      return readFilter === 'read' ? Boolean(v.readAt) : !v.readAt;
    });
  const activeCount = videos.filter(isProcessing).length;
  const activeJobs = videos.filter((v) => v.processing && v.aiProgress);

  return (
    <div className="min-h-screen w-full bg-bg">
      <AppHeader center={<><StatusBadge activeCount={activeCount} /><ActiveJobs jobs={activeJobs} /><Stepper /></>} />

      {/* w-full max-w-none a proposito: nada de contenedor centrado con margenes muertos a los
          lados en pantallas anchas — el espacio extra lo absorbe la grid de tarjetas de mas
          columnas, no un hueco vacio. */}
      <main className="w-full max-w-none px-4 py-8 pb-20 sm:px-6">
        {error && (
          <p className="mb-4 rounded-sm border border-error/20 bg-error-bg px-3 py-2 text-sm text-error">
            {t('serverError', { error })}
          </p>
        )}

        <EnqueueForm onEnqueued={() => {}} />
        <StageTabs videos={videos} active={tab} onChange={setTab} />
        {tab === 'DONE' && <ReadFilter videos={videos} active={readFilter} onChange={setReadFilter} />}

        {loading ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <VideoCardSkeleton key={i} />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-md border border-dashed border-border py-16 text-center">
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

function formatElapsed(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

/** Se ve el "processing (N)" del StatusBadge desde cualquier pestaña, pero para saber SI algo
 * esta realmente atascado (un chunk que lleva 20 minutos, por ejemplo) antes había que ir a
 * buscar la tarjeta en la lista — con muchas colas pausadas o filtradas puede ni estar visible.
 * Esto pone el modelo + tiempo transcurrido de cada job de IA activo directamente en la
 * cabecera, siempre visible sin tener que hacer scroll. */
function ActiveJobs({ jobs }) {
  const tStages = useTranslations('Stages');
  if (jobs.length === 0) return null;
  return (
    <div className="hidden items-center gap-2 overflow-hidden font-mono text-xs text-muted lg:flex">
      {jobs.map((v) => (
        <span
          key={v.videoId}
          title={`${v.videoId} · ${v.aiProgress.model || ''}`}
          className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-secondary px-2.5 py-1"
        >
          <span>{tStages(v.stage === 'REWRITE' ? 'rewrite' : 'summarize')}</span>
          {v.aiProgress.model && <span className="max-w-[160px] truncate text-text">{v.aiProgress.model}</span>}
          <span className="text-warn">{formatElapsed(v.aiProgress.elapsedSec)}</span>
        </span>
      ))}
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

/** Sub-filtro dentro de Done, no una pestaña propia — "leido" es una anotacion manual sobre un
 * video ya terminado (para simular haberlo abierto), no una etapa mas del pipeline. */
function ReadFilter({ videos, active, onChange }) {
  const t = useTranslations('Queue');
  const done = videos.filter((v) => v.stage === 'DONE');
  const counts = {
    all: done.length,
    unread: done.filter((v) => !v.readAt).length,
    read: done.filter((v) => v.readAt).length,
  };
  return (
    <div className="-mt-3 mb-6 flex flex-wrap gap-1.5 rounded-sm border border-border bg-secondary/50 p-1.5">
      {['all', 'unread', 'read'].map((key) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={
            'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ' +
            (active === key ? 'bg-primary text-primary-foreground' : 'text-muted hover:bg-accent hover:text-text')
          }
        >
          {t(`readFilter${key.charAt(0).toUpperCase()}${key.slice(1)}`)}
          <span className="font-mono">{counts[key]}</span>
        </button>
      ))}
    </div>
  );
}
