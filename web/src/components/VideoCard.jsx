import { useState } from 'react';
import { Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { STATIONS, stationClasses, currentLabel, isProcessing } from '../stages.js';

const STATION_COLOR = {
  done: 'bg-success',
  active: 'bg-warn',
  errored: 'bg-error',
  pending: 'bg-zinc-200',
};

function links(v) {
  const out = [];
  if (v.stage === 'DONE' || (v.stage === 'EMAIL' && v.bucket === 'output')) {
    out.push(['leer resumen', `/api/videos/${v.videoId}/reader`]);
    out.push(['ver email', `/api/videos/${v.videoId}/email`]);
    out.push(['.md', `/api/videos/${v.videoId}/markdown`]);
  }
  return out;
}

/** verde para enviado, rojo para fallo, ambar mientras esta activo, gris mientras espera turno. */
function StatusDot({ video, processing }) {
  const color = video.bucket === 'error' ? 'bg-error'
    : video.stage === 'DONE' ? 'bg-success'
    : processing ? 'bg-warn'
    : 'bg-zinc-300';
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />;
}

export function VideoCard({ video }) {
  const [requeuing, setRequeuing] = useState(false);
  const [requeued, setRequeued] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const classes = stationClasses(video);
  const label = currentLabel(video);
  const processing = isProcessing(video);
  const isError = video.bucket === 'error';

  async function requeue() {
    setRequeuing(true);
    try {
      const res = await fetch(`/api/videos/${video.videoId}/requeue`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      setRequeued(true);
    } catch (err) {
      alert(`No se pudo reprocesar: ${err.message}`);
    } finally {
      setRequeuing(false);
    }
  }

  async function deleteVideo() {
    if (!confirm(`¿Borrar ${video.videoId} definitivamente? No hay vuelta atrás.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/videos/${video.videoId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      setDeleted(true);
    } catch (err) {
      alert(`No se pudo borrar: ${err.message}`);
    } finally {
      setDeleting(false);
    }
  }

  if (deleted) return null;

  return (
    <div
      className={
        'rounded-2xl border p-4 shadow-[var(--shadow-soft)] transition-all hover:shadow-[var(--shadow-hover)] ' +
        (isError ? 'border-error/20 bg-error-bg' : 'border-border bg-card hover:border-border-hover')
      }
    >
      <div className="mb-3.5 flex gap-[3px]">
        {STATIONS.map((s, i) => (
          <div key={s} className={`h-1 flex-1 rounded-full transition-colors duration-200 ${STATION_COLOR[classes[i]]}`} />
        ))}
      </div>

      <div className="flex gap-3.5">
        <img
          src={`https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`}
          alt=""
          width={120}
          height={68}
          loading="lazy"
          className="h-[68px] w-[120px] flex-shrink-0 rounded-lg border border-border object-cover"
          onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
        />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {video.url ? (
              <a
                href={video.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate font-mono text-xs text-muted hover:text-text"
              >
                {video.url}
              </a>
            ) : (
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{video.videoId}</span>
            )}
          </div>

          <div className={video.title ? 'mt-0.5 truncate text-base font-semibold text-text' : 'mt-0.5 text-base italic text-muted'}>
            {video.title || 'esperando título…'}
          </div>

          <div className="mt-1 flex min-w-0 items-center gap-2 text-sm text-muted">
            <StatusDot video={video} processing={processing} />
            <span className="flex flex-shrink-0 items-center gap-1">
              {processing && <Loader2 size={11} className="animate-spin" />}
              {label}
            </span>
            {video.language && <span className="flex-shrink-0">· {video.language}</span>}
            {video.model && <span className="min-w-0 flex-1 truncate font-mono text-xs">· {video.model}</span>}
          </div>

          {video.lastError && (
            <div className="mt-2 rounded-lg bg-error/5 px-2.5 py-1.5 text-sm text-error">{video.lastError.error}</div>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
            {links(video).map(([label, href]) => (
              <a
                key={label}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-muted hover:text-text"
              >
                {label}
              </a>
            ))}
            {isError && !requeued && (
              <button
                onClick={requeue}
                disabled={requeuing}
                className="flex items-center gap-1 text-sm text-error hover:text-red-700 disabled:opacity-60"
              >
                <RotateCcw size={12} />
                {requeuing ? 'reprocesando…' : 'reprocesar'}
              </button>
            )}
            {requeued && <span className="text-sm text-success">reprocesando — el worker lo recogerá solo</span>}
            {isError && (
              <button
                onClick={deleteVideo}
                disabled={deleting}
                className="flex items-center gap-1 text-sm text-muted hover:text-text disabled:opacity-60"
              >
                <Trash2 size={12} />
                {deleting ? 'borrando…' : 'borrar'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
