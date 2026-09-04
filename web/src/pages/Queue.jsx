import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useQueueState } from '../hooks/useQueueState.js';
import { EnqueueForm } from '../components/EnqueueForm.jsx';
import { StageTabs } from '../components/StageTabs.jsx';
import { VideoRow } from '../components/VideoRow.jsx';
import { matchesTab, isProcessing } from '../stages.js';

export function Queue() {
  const { videos, error } = useQueueState();
  const [tab, setTab] = useState('ALL');
  const visible = videos.filter((v) => matchesTab(v, tab));
  const activeCount = videos.filter(isProcessing).length;

  return (
    <main className="mx-auto max-w-4xl px-6 py-9 pb-20">
      <header className="mb-1.5 flex items-baseline justify-between border-b-2 border-ink pb-2.5">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-wide">youtube-sumarizer</h1>
          <StatusBadge activeCount={activeCount} />
        </div>
        <Clock />
      </header>
      <p className="mb-7 font-mono text-xs text-ink-dim">
        descarga → resume (IA) → interpreta → envía — se actualiza sola cada 1.5s
      </p>

      {error && (
        <p className="mb-4 border-l-2 border-red bg-paper-card p-2 text-sm text-red">
          No se pudo hablar con el servidor: {error}
        </p>
      )}

      <EnqueueForm onEnqueued={() => {}} />
      <StageTabs videos={videos} active={tab} onChange={setTab} />

      {visible.length === 0 ? (
        <p className="py-14 text-center italic text-ink-dim">
          {videos.length === 0 ? 'Nada en cola todavía. Pega una URL arriba para empezar.' : 'Nada en esta pestaña.'}
        </p>
      ) : (
        <div>
          {visible.map((v) => (
            <VideoRow key={v.videoId} video={v} />
          ))}
        </div>
      )}
    </main>
  );
}

function StatusBadge({ activeCount }) {
  const active = activeCount > 0;
  return (
    <span
      className={
        'flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-xs font-semibold ' +
        (active ? 'border-amber bg-[#f2e6c8] text-amber' : 'border-rule bg-paper-card text-ink-dim')
      }
    >
      {active ? <Loader2 size={14} className="animate-spin" /> : <span className="h-2.5 w-2.5 rounded-full bg-ink-dim" />}
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
  return <span className="font-mono text-xs text-ink-dim">{now.toLocaleTimeString('es-ES')}</span>;
}
