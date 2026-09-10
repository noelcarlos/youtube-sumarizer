'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check, FastForward, Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import { STATIONS, stationClasses, currentLabelKey, isProcessing, isQueued } from '../stages.js';
import { formatRelativeTime } from '../lib/relativeTime.js';
import { useConfirmDialog } from './ConfirmDialog.jsx';

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** El punto en si — hueco mientras espera turno, relleno solido en cuanto pasa por esa etapa. El
 * anillo ambar en "active" es la unica animacion de la tarjeta, y solo corre mientras esa etapa
 * de verdad esta trabajando (motion-safe: respeta prefers-reduced-motion). */
const STATION_DOT = {
  done: 'border-success bg-success',
  active: 'border-warn bg-warn',
  errored: 'border-error bg-error',
  pending: 'border-border-hover bg-transparent',
};

/** El tramo de cable ENTRE dos puntos: coloreado si la señal ya paso por ahi (el punto anterior
 * esta done/active/errored), neutro si todavia no llega. Clases literales a proposito — Tailwind
 * no detecta nombres de clase construidos por interpolacion de string. */
function wireClass(prevState) {
  if (prevState === 'done') return 'bg-success';
  if (prevState === 'active') return 'bg-warn/50';
  if (prevState === 'errored') return 'bg-error/50';
  return 'bg-border';
}

// Resumen y Reescritura corren en PARALELO — si Resumen ya termino (existe summaryModel), no
// hay motivo para bloquear la lectura hasta que Reescritura/Fusion tambien acaben. El drawer
// sirve entonces una vista previa (ver ReaderDrawer.jsx: fullContentIsPreview).
function canOpenReader(v) {
  return v.stage === 'DONE' || (v.stage === 'EMAIL' && v.bucket === 'output') || Boolean(v.summaryModel);
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
  const { confirm: confirmDialog, ConfirmDialog } = useConfirmDialog();
  const [requeuing, setRequeuing] = useState(false);
  const [requeued, setRequeued] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [skipped, setSkipped] = useState(false);
  // Estado local optimista: video.readAt viene del sondeo de useQueueState (hasta 1.5s de
  // retraso) — sin esto, el boton tarda en reflejar el propio click que lo disparo. Pero
  // useState(video.readAt) solo lee el prop UNA vez, al montar — si el toggle se hace desde el
  // drawer de lectura (otra instancia, otro estado local), esta tarjeta se queda con el valor
  // viejo para siempre porque nunca vuelve a mirar el prop. El useEffect de abajo es lo que la
  // mantiene sincronizada con lo que de verdad diga el proximo sondeo.
  const [readAt, setReadAt] = useState(video.readAt);
  useEffect(() => { setReadAt(video.readAt); }, [video.readAt]);
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

  async function skipRewrite() {
    if (!(await confirmDialog(t('confirmSkipRewrite')))) return;
    setSkipping(true);
    try {
      const res = await fetch(`/api/videos/${video.videoId}/skip-rewrite`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      setSkipped(true);
    } catch (err) {
      alert(t('skipRewriteFailed', { error: err.message }));
    } finally {
      setSkipping(false);
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
    if (!(await confirmDialog(t('confirmDelete', { videoId: video.videoId })))) return;
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
        'rounded-md border p-4 shadow-[var(--shadow-soft)] transition-colors hover:shadow-[var(--shadow-hover)] ' +
        (isError ? 'border-error/25 bg-error-bg' : 'border-border bg-card hover:border-border-hover')
      }
    >
      {ConfirmDialog}
      <div className="mb-4 flex items-center" aria-hidden="true">
        {STATIONS.map((s, i) => (
          <div key={s} className="flex items-center" style={{ flex: i === STATIONS.length - 1 ? '0 0 auto' : '1 1 auto' }}>
            <span className="relative flex h-2.5 w-2.5 flex-shrink-0 items-center justify-center">
              {classes[i] === 'active' && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warn opacity-40 motion-reduce:hidden" />
              )}
              <span className={`h-2.5 w-2.5 rounded-full border-[1.5px] transition-colors duration-300 ${STATION_DOT[classes[i]]}`} />
            </span>
            {i < STATIONS.length - 1 && (
              <div className={`h-px flex-1 transition-colors duration-300 ${wireClass(classes[i])}`} />
            )}
          </div>
        ))}
      </div>

      {/* Titulo primero, a todo el ancho de la tarjeta, hasta 2 lineas — antes compartia fila
          con la miniatura y se veia cortado casi siempre. La miniatura baja a la fila de abajo,
          junto al resto de metadatos, en vez de competir por espacio con el titulo. */}
      {canOpenReader(video) ? (
        <button
          onClick={() => onOpenReader(video.videoId)}
          className="block w-full cursor-pointer text-left font-serif text-[17px] font-medium leading-snug text-text line-clamp-2 hover:text-muted"
        >
          {video.title || t('pendingTitle')}
        </button>
      ) : (
        <div className={video.title ? 'font-serif text-[17px] font-medium leading-snug text-text line-clamp-2' : 'font-serif text-[17px] italic leading-snug text-muted'}>
          {video.title || t('pendingTitle')}
        </div>
      )}

      <div className="mt-2.5 flex gap-3">
        {canOpenReader(video) ? (
          <button
            onClick={() => onOpenReader(video.videoId)}
            className="flex-shrink-0 cursor-pointer self-start rounded-sm transition-opacity hover:opacity-80"
          >
            <img
              src={`https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`}
              alt=""
              width={112}
              height={63}
              loading="lazy"
              className="h-[63px] w-[112px] rounded-sm border border-border object-cover"
              onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
            />
          </button>
        ) : (
          <img
            src={`https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`}
            alt=""
            width={112}
            height={63}
            loading="lazy"
            className="h-[63px] w-[112px] flex-shrink-0 self-start rounded-sm border border-border object-cover"
            onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
          />
        )}

        <div className="min-w-0 flex-1">
          {video.url ? (
            <a
              href={video.url}
              target="_blank"
              rel="noreferrer"
              className="block min-w-0 truncate font-mono text-xs text-muted hover:text-text"
            >
              {video.url}
            </a>
          ) : (
            <span className="block min-w-0 truncate font-mono text-xs text-muted">{video.videoId}</span>
          )}

          <div className="mt-1 flex min-w-0 items-center gap-2 text-sm text-muted">
            <StatusDot video={video} processing={processing} />
            <span className="flex flex-shrink-0 items-center gap-1">
              {processing && <Loader2 size={11} className="animate-spin" />}
              {queued ? t('queued') : label}
            </span>
            {video.language && <span className="flex-shrink-0">· {video.language}</span>}
            {!video.summaryModel && !video.rewriteModel && video.model && (
              <span className="min-w-0 flex-1 truncate font-mono text-xs">· {video.model}</span>
            )}
          </div>

          {(video.summaryModel || video.rewriteModel) && (
            <div className="mt-0.5 flex flex-col gap-0.5 font-mono text-xs text-muted">
              {video.summaryModel && (
                <div className="truncate">
                  {t('modelSummarizeLabel')}: {video.summaryModel}
                  {video.currentSummarizeModel && video.summaryModel !== video.currentSummarizeModel && (
                    <span className="text-warn"> ({t('modelOutdated')})</span>
                  )}
                </div>
              )}
              {video.rewriteModel && (
                <div className="truncate">
                  {t('modelRewriteLabel')}: {video.rewriteModel}
                  {video.currentRewriteModel && video.rewriteModel !== video.currentRewriteModel && (
                    <span className="text-warn"> ({t('modelOutdated')})</span>
                  )}
                </div>
              )}
            </div>
          )}

          {video.updatedAt && (
            <div className="mt-0.5 text-xs text-muted">{formatRelativeTime(video.updatedAt, locale)}</div>
          )}

          {processing && (video.stage === 'SUMMARIZE' || video.stage === 'REWRITE') && video.aiProgress && (
            <AiProgressBar progress={video.aiProgress} t={t} />
          )}

          {video.lastError && (
            <div className="mt-2 rounded-sm bg-error/5 px-2.5 py-1.5 text-sm text-error">{video.lastError.error}</div>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
            {canOpenReader(video) && video.stage !== 'DONE' && !(video.stage === 'EMAIL' && video.bucket === 'output') && (
              // Mismo boton que "leer resumen", pero etiquetado distinto y en el color de "en
              // curso" — si no, no hay ninguna señal de que esto sea nuevo (resumen ya listo,
              // pero Rewrite/Fusion todavia trabajando) y se confunde con el video normal ya
              // terminado, que se ve exactamente igual.
              <button
                onClick={() => onOpenReader(video.videoId)}
                className="text-sm font-medium text-warn hover:text-warn"
              >
                {t('readPreview')}
              </button>
            )}
            {canOpenReader(video) && (video.stage === 'DONE' || (video.stage === 'EMAIL' && video.bucket === 'output')) && (
              <button
                onClick={() => onOpenReader(video.videoId)}
                className="text-sm text-muted hover:text-text"
              >
                {t('readSummary')}
              </button>
            )}
            {processing && (video.stage === 'SUMMARIZE' || video.stage === 'REWRITE') && (
              <button
                onClick={cancel}
                disabled={cancelling}
                className="flex items-center gap-1 rounded-sm border border-error/30 bg-error/10 px-2.5 py-1 text-sm font-medium text-error transition-colors hover:bg-error/20 disabled:opacity-60"
              >
                <X size={12} />
                {cancelling ? t('cancelling') : t('cancel')}
              </button>
            )}
            {video.stage === 'REWRITE' && Boolean(video.summaryModel) && !skipped && (
              // Resumen ya termino, Rewrite va lento o esta atascado — esto saca el video de la
              // cola de Rewrite y lo manda a Fusion/email YA, con el transcript crudo como
              // cuerpo completo en vez de la reescritura fiel. Irreversible (por eso el confirm):
              // no hay vuelta atras a "espera a que Rewrite termine" una vez hecho esto.
              <button
                onClick={skipRewrite}
                disabled={skipping}
                className="flex items-center gap-1 text-sm text-muted transition-colors hover:text-text disabled:opacity-60"
              >
                <FastForward size={12} />
                {skipping ? t('skippingRewrite') : t('skipRewrite')}
              </button>
            )}
            {skipped && <span className="text-sm text-success">{t('skipRewriteNotice')}</span>}
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
                role="checkbox"
                aria-checked={Boolean(readAt)}
                title={readAt ? formatRelativeTime(new Date(readAt).getTime(), locale) : t('markRead')}
                className="flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-text disabled:opacity-60"
              >
                <span
                  className={
                    'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors ' +
                    (readAt ? 'border-success bg-success text-white' : 'border-border bg-card')
                  }
                >
                  {readAt && <Check size={11} strokeWidth={3} />}
                </span>
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

/** Resumen tiene dos caminos: llamada unica (sin sub-progreso, es una sola peticion) o
 * map-reduce (summary-map/summary-reduce) para transcripts largos — igual que Rewrite, ese
 * camino si tiene un "cuantos de cuantos" real que enseñar. */
const CHUNKED_STEPS = ['rewrite', 'summary-map', 'summary-reduce'];

function AiProgressBar({ progress, t }) {
  const { step, currentChunk, totalChunks, fileSizeBytes, elapsedSec, model } = progress;
  const pct = CHUNKED_STEPS.includes(step) && totalChunks > 0 ? Math.round((currentChunk / totalChunks) * 100) : null;

  return (
    <div className="mt-2 rounded-sm border border-border bg-secondary/50 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted">
        <span className="truncate">
          {step === 'rewrite' && t('aiStepRewrite', { current: currentChunk, total: totalChunks })}
          {(step === 'summary-map' || step === 'summary-reduce') && t('aiStepSummaryChunk', { current: currentChunk, total: totalChunks })}
          {step === 'summary' && t('aiStepSummary')}
        </span>
        <span className="flex-shrink-0 font-mono">{formatBytes(fileSizeBytes)} · {elapsedSec}s</span>
      </div>
      {model && <div className="mt-0.5 truncate font-mono text-xs text-muted">{model}</div>}
      {pct !== null && (
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full bg-warn transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
