'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Circle, Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import { STATIONS, stationClasses, currentLabelKey, isProcessing, isQueued } from '../stages.js';

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const RELATIVE_UNITS = [
  ['year', 365 * 24 * 60 * 60],
  ['month', 30 * 24 * 60 * 60],
  ['day', 24 * 60 * 60],
  ['hour', 60 * 60],
  ['minute', 60],
  ['second', 1],
];

/** Intl.RelativeTimeFormat, no una libreria — ya viene en el navegador y respeta el idioma
 * activo solo (ES -> "hace 2 dias", EN -> "2 days ago") sin tener que mantener las cadenas de
 * texto a mano en messages/es.json|en.json. */
function formatRelativeTime(timestampMs, locale) {
  if (!timestampMs) return null;
  const diffSec = (timestampMs - Date.now()) / 1000;
  const absSec = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, secInUnit] of RELATIVE_UNITS) {
    if (absSec >= secInUnit || unit === 'second') {
      return rtf.format(Math.round(diffSec / secInUnit), unit);
    }
  }
}

const STATION_COLOR = {
  done: 'bg-success',
  active: 'bg-warn',
  errored: 'bg-error',
  pending: 'bg-secondary',
};

function canOpenReader(v) {
  return v.stage === 'DONE' || (v.stage === 'EMAIL' && v.bucket === 'output');
}

/** verde para enviado, rojo para fallo, ambar mientras esta activo, gris mientras espera turno. */
function StatusDot({ video, processing }) {
  const color = video.bucket === 'error' ? 'bg-error'
    : video.stage === 'DONE' ? 'bg-success'
    : processing ? 'bg-warn'
    : 'bg-muted';
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />;
}

export function VideoCard({ video, onOpenReader }) {
  const t = useTranslations('VideoCard');
  const tStageLabel = useTranslations('StageLabel');
  const locale = useLocale();
  const [requeuing, setRequeuing] = useState(false);
  const [requeued, setRequeued] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Estado local optimista: video.readAt viene del sondeo de useQueueState (hasta 1.5s de
  // retraso) — sin esto, el boton tarda en reflejar el propio click que lo disparo.
  const [readAt, setReadAt] = useState(video.readAt);
  const [togglingRead, setTogglingRead] = useState(false);
  const classes = stationClasses(video);
  const { key: labelKey, failed } = currentLabelKey(video);
  const label = failed
    ? tStageLabel('failedSuffix', { stage: tStageLabel(labelKey) })
    : tStageLabel(labelKey);
  const processing = isProcessing(video);
  const queued = isQueued(video);
  const isError = video.bucket === 'error';

  async function toggleRead() {
    setTogglingRead(true);
    try {
      const res = await fetch(`/api/videos/${video.videoId}/read`, { method: readAt ? 'DELETE' : 'POST' });
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json();
      setReadAt(body.readAt);
    } catch (err) {
      alert(t('markReadFailed', { error: err.message }));
    } finally {
      setTogglingRead(false);
    }
  }

  async function cancel() {
    setCancelling(true);
    try {
      const res = await fetch(`/api/videos/${video.videoId}/cancel`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      alert(t('cancelFailed', { error: err.message }));
    } finally {
      setCancelling(false);
    }
  }

  async function requeue() {
    setRequeuing(true);
    try {
      const res = await fetch(`/api/videos/${video.videoId}/requeue`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      setRequeued(true);
    } catch (err) {
      alert(t('reprocessFailed', { error: err.message }));
    } finally {
      setRequeuing(false);
    }
  }

  async function deleteVideo() {
    if (!confirm(t('confirmDelete', { videoId: video.videoId }))) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/videos/${video.videoId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      setDeleted(true);
    } catch (err) {
      alert(t('deleteFailed', { error: err.message }));
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
        {canOpenReader(video) ? (
          <button
            onClick={() => onOpenReader(video.videoId)}
            className="flex-shrink-0 rounded-lg transition-opacity hover:opacity-80"
          >
            <img
              src={`https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`}
              alt=""
              width={120}
              height={68}
              loading="lazy"
              className="h-[68px] w-[120px] rounded-lg border border-border object-cover"
              onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
            />
          </button>
        ) : (
          <img
            src={`https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`}
            alt=""
            width={120}
            height={68}
            loading="lazy"
            className="h-[68px] w-[120px] flex-shrink-0 rounded-lg border border-border object-cover"
            onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
          />
        )}

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

          {canOpenReader(video) ? (
            <button
              onClick={() => onOpenReader(video.videoId)}
              className="mt-0.5 block w-full truncate text-left text-base font-semibold text-text hover:text-muted"
            >
              {video.title || t('pendingTitle')}
            </button>
          ) : (
            <div className={video.title ? 'mt-0.5 truncate text-base font-semibold text-text' : 'mt-0.5 text-base italic text-muted'}>
              {video.title || t('pendingTitle')}
            </div>
          )}

          <div className="mt-1 flex min-w-0 items-center gap-2 text-sm text-muted">
            <StatusDot video={video} processing={processing} />
            <span className="flex flex-shrink-0 items-center gap-1">
              {processing && <Loader2 size={11} className="animate-spin" />}
              {queued ? t('queued') : label}
            </span>
            {video.language && <span className="flex-shrink-0">· {video.language}</span>}
            {video.model && <span className="min-w-0 flex-1 truncate font-mono text-xs">· {video.model}</span>}
          </div>

          {video.updatedAt && (
            <div className="mt-0.5 text-xs text-muted">{formatRelativeTime(video.updatedAt, locale)}</div>
          )}

          {processing && video.stage === 'AI_SUMMARIZE' && video.aiProgress && (
            <AiProgressBar progress={video.aiProgress} t={t} />
          )}

          {video.lastError && (
            <div className="mt-2 rounded-lg bg-error/5 px-2.5 py-1.5 text-sm text-error">{video.lastError.error}</div>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
            {canOpenReader(video) && (
              <button
                onClick={() => onOpenReader(video.videoId)}
                className="text-sm text-muted hover:text-text"
              >
                {t('readSummary')}
              </button>
            )}
            {processing && video.stage === 'AI_SUMMARIZE' && (
              <button
                onClick={cancel}
                disabled={cancelling}
                className="flex items-center gap-1 rounded-lg border border-error/30 bg-error/10 px-2.5 py-1 text-sm font-medium text-error transition-colors hover:bg-error/20 disabled:opacity-60"
              >
                <X size={12} />
                {cancelling ? t('cancelling') : t('cancel')}
              </button>
            )}
            {isError && !requeued && (
              <button
                onClick={requeue}
                disabled={requeuing}
                className="flex items-center gap-1 text-sm text-error hover:text-red-700 disabled:opacity-60"
              >
                <RotateCcw size={12} />
                {requeuing ? t('reprocessing') : t('reprocess')}
              </button>
            )}
            {requeued && <span className="text-sm text-success">{t('reprocessingNotice')}</span>}
            {video.stage === 'DONE' && (
              <button
                onClick={toggleRead}
                disabled={togglingRead}
                title={readAt ? formatRelativeTime(new Date(readAt).getTime(), locale) : undefined}
                className={
                  'flex items-center gap-1 text-sm transition-colors disabled:opacity-60 ' +
                  (readAt ? 'text-success hover:text-muted' : 'text-muted hover:text-text')
                }
              >
                {readAt ? <Check size={12} /> : <Circle size={12} />}
                {readAt ? t('markUnread') : t('markRead')}
              </button>
            )}
            {isError && (
              <button
                onClick={deleteVideo}
                disabled={deleting}
                className="flex items-center gap-1 text-sm text-muted hover:text-text disabled:opacity-60"
              >
                <Trash2 size={12} />
                {deleting ? t('deleting') : t('delete')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Paso 1 (resumen corto) es una sola llamada, sin sub-progreso que mostrar mas alla de cuanto
 * lleva corriendo — la barra solo aparece en el paso 2 (reescritura chunk a chunk), que es
 * donde de verdad hay un "cuantos de cuantos" que enseñar. */
function AiProgressBar({ progress, t }) {
  const { step, currentChunk, totalChunks, fileSizeBytes, elapsedSec } = progress;
  const pct = step === 'rewrite' && totalChunks > 0 ? Math.round((currentChunk / totalChunks) * 100) : null;

  return (
    <div className="mt-2 rounded-lg border border-border bg-secondary/50 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted">
        <span className="truncate">
          {step === 'rewrite' ? t('aiStepRewrite', { current: currentChunk, total: totalChunks }) : t('aiStepSummary')}
        </span>
        <span className="flex-shrink-0 font-mono">{formatBytes(fileSizeBytes)} · {elapsedSec}s</span>
      </div>
      {pct !== null && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full bg-warn transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
