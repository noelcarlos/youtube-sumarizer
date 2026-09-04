import { useEffect, useState } from 'react';
import { useQueueState } from '../hooks/useQueueState.js';
import { EnqueueForm } from '../components/EnqueueForm.jsx';
import { StageTabs } from '../components/StageTabs.jsx';
import { VideoCard } from '../components/VideoCard.jsx';
import { VideoCardSkeleton } from '../components/VideoCardSkeleton.jsx';
import { matchesTab, isProcessing } from '../stages.js';

const PIPELINE_STEPS = ['descarga', 'resume', 'interpreta', 'envía'];

export function Queue() {
  const { videos, error, loading } = useQueueState();
  const [tab, setTab] = useState('ALL');
  const visible = videos.filter((v) => matchesTab(v, tab));
  const activeCount = videos.filter(isProcessing).length;

  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-10 border-b border-border bg-white/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <h1 className="truncate text-base font-bold tracking-tight text-text lowercase">youtube-sumarizer</h1>
            <StatusBadge activeCount={activeCount} />
          </div>
          <Stepper />
          <Clock />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8 pb-20">
        {error && (
          <p className="mb-4 rounded-xl border border-error/20 bg-error-bg px-3 py-2 text-sm text-error">
            No se pudo hablar con el servidor: {error}
          </p>
        )}

        <EnqueueForm onEnqueued={() => {}} />
        <StageTabs videos={videos} active={tab} onChange={setTab} />

        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <VideoCardSkeleton key={i} />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-16 text-center">
            <p className="text-sm text-muted">
              {videos.length === 0 ? 'Nada en cola todavía. Pega una URL arriba para empezar.' : 'Nada en esta pestaña.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {visible.map((v) => (
              <VideoCard key={v.videoId} video={v} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function Stepper() {
  return (
    <div className="hidden items-center gap-1.5 font-mono text-xs text-muted md:flex">
      {PIPELINE_STEPS.map((step, i) => (
        <span key={step} className="flex items-center gap-1.5">
          {step}
          {i < PIPELINE_STEPS.length - 1 && <span className="text-zinc-300">→</span>}
        </span>
      ))}
    </div>
  );
}

function StatusBadge({ activeCount }) {
  const active = activeCount > 0;
  return (
    <span
      className={
        'flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-xs font-medium ' +
        (active ? 'border-warn/30 bg-warn-bg text-warn' : 'border-border bg-zinc-50 text-muted')
      }
    >
      <span className={'relative flex h-2 w-2 items-center justify-center'}>
        <span className={'absolute h-2 w-2 animate-pulse rounded-full ' + (active ? 'bg-warn' : 'bg-zinc-400')} />
      </span>
      {active ? `procesando (${activeCount})` : 'inactivo'}
    </span>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="hidden flex-shrink-0 font-mono text-xs text-muted sm:inline">{now.toLocaleTimeString('es-ES')}</span>;
}
