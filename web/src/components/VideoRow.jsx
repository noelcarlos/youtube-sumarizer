import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { STATIONS, stationClasses, currentLabel } from '../stages.js';

const STATION_COLOR = {
  done: 'bg-green',
  active: 'bg-amber',
  errored: 'bg-red',
  pending: 'bg-[#d8cfb4]',
};

function links(v) {
  const out = [];
  if (v.stage === 'DONE' || (v.stage === 'EMAIL' && v.bucket === 'output')) {
    out.push(['leer resumen', `/api/videos/${v.videoId}/reader`]);
    out.push(['ver email', `/api/videos/${v.videoId}/email`]);
    out.push(['.md', `/api/videos/${v.videoId}/markdown`]);
  }
  if (v.url) out.push(['youtube ↗', v.url]);
  return out;
}

export function VideoRow({ video }) {
  const [requeuing, setRequeuing] = useState(false);
  const [requeued, setRequeued] = useState(false);
  const classes = stationClasses(video);
  const label = currentLabel(video);

  async function requeue() {
    setRequeuing(true);
    try {
      const res = await fetch(`/api/videos/${video.videoId}/requeue`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      setRequeued(true);
    } catch (err) {
      alert(`No se pudo reencolar: ${err.message}`);
    } finally {
      setRequeuing(false);
    }
  }

  return (
    <div className="grid grid-cols-[92px_1fr] gap-4 border-b border-rule py-4 first:border-t">
      <div>
        <div className="flex gap-[3px]">
          {STATIONS.map((s, i) => (
            <div key={s} className={`h-[5px] flex-1 transition-colors duration-200 ${STATION_COLOR[classes[i]]}`} />
          ))}
        </div>
        <div className={`mt-1.5 font-mono text-[0.68rem] ${video.bucket === 'error' ? 'text-red' : 'text-ink-dim'}`}>
          {label}
        </div>
      </div>

      <div>
        <div className="font-mono text-xs text-ink-dim">{video.videoId}</div>
        <div className={video.title ? 'mt-0.5 mb-1' : 'mt-0.5 mb-1 italic text-ink-dim'}>
          {video.title || 'esperando título…'}
        </div>
        {video.language && (
          <div className="font-mono text-xs text-ink-dim">
            {video.language}{video.model ? ` · ${video.model}` : ''}
          </div>
        )}
        {video.lastError && (
          <div className="mt-1.5 border-l-2 border-red pl-2.5 text-sm text-red">{video.lastError.error}</div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1">
          {links(video).map(([label, href]) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="border-b border-rule font-mono text-xs text-ink hover:border-ink"
            >
              {label}
            </a>
          ))}
          {video.bucket === 'error' && !requeued && (
            <button
              onClick={requeue}
              disabled={requeuing}
              className="flex items-center gap-1 border-b border-red font-mono text-xs text-red hover:border-red-dark disabled:opacity-60"
            >
              <RotateCcw size={12} />
              {requeuing ? 'reencolando…' : 'reencolar'}
            </button>
          )}
          {requeued && <span className="font-mono text-xs text-green">reencolado — el worker lo recogerá solo</span>}
        </div>
      </div>
    </div>
  );
}
