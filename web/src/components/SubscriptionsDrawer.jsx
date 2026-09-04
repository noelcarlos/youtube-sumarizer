'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSession, signIn, signOut } from 'next-auth/react';
import { ArrowLeft, Loader2, RotateCcw, Search, Send, MonitorPlay } from 'lucide-react';
import { Sheet, SheetContent } from './ui/sheet.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.jsx';
import { YouTubePlayer } from './YouTubePlayer.jsx';

const PAGE_SIZE = 20;
const DATE_RANGES = ['all', 'day', 'week', 'month'];
const RANGE_MS = { day: 24 * 60 * 60 * 1000, week: 7 * 24 * 60 * 60 * 1000, month: 30 * 24 * 60 * 60 * 1000 };

export function SubscriptionsDrawer() {
  const t = useTranslations('SubscriptionsDrawer');
  const [open, setOpen] = useState(false);
  const [previewVideo, setPreviewVideo] = useState(null);

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

      <Sheet open={open} onOpenChange={(v) => { setOpen(v); if (!v) setPreviewVideo(null); }}>
        <SheetContent
          side="right"
          className={`flex flex-col gap-0 p-0 ${previewVideo ? 'w-full sm:max-w-none sm:w-screen' : 'w-full sm:max-w-none sm:w-[480px]'}`}
        >
          <div className="flex items-center gap-3 border-b border-border px-6 py-4">
            {previewVideo && (
              <button
                onClick={() => setPreviewVideo(null)}
                aria-label={t('backToList')}
                className="flex-shrink-0 rounded-lg p-1 text-muted transition-colors hover:bg-accent hover:text-text"
              >
                <ArrowLeft size={18} />
              </button>
            )}
            <h2 className="truncate text-lg font-semibold tracking-tight text-text">
              {previewVideo ? previewVideo.title : t('title')}
            </h2>
          </div>
          {previewVideo ? (
            <VideoPreview video={previewVideo} t={t} />
          ) : (
            <SubscriptionsBody t={t} onPreview={setPreviewVideo} />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function VideoPreview({ video, t }) {
  const [enqueued, setEnqueued] = useState(false);
  const [error, setError] = useState(null);

  async function enqueue() {
    try {
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: video.url }),
      });
      if (!res.ok) throw new Error(await res.text());
      setEnqueued(true);
    } catch (err) {
      setError(t('enqueueFailed', { error: err.message }));
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-6">
      <YouTubePlayer videoId={video.videoId} />
      <div className="mt-4 flex items-center justify-between gap-4">
        <p className="text-sm text-muted">{video.channelTitle}</p>
        <button
          onClick={enqueue}
          disabled={enqueued}
          className="flex flex-shrink-0 items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          <Send size={14} />
          {enqueued ? t('enqueued') : t('enqueue')}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-error">{error}</p>}
    </div>
  );
}

function SubscriptionsBody({ t, onPreview }) {
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

  return <VideoList t={t} onPreview={onPreview} />;
}

function VideoList({ t, onPreview }) {
  const [videos, setVideos] = useState(null);
  const [queuedIds, setQueuedIds] = useState(() => new Set());
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [enqueued, setEnqueued] = useState(() => new Set());

  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('all');
  const [range, setRange] = useState('all');
  const [hideQueued, setHideQueued] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  async function load(refresh) {
    refresh ? setRefreshing(true) : setLoading(true);
    try {
      const [subsRes, stateRes] = await Promise.all([
        fetch(`/api/youtube/subscriptions${refresh ? '?refresh=1' : ''}`),
        fetch('/api/state'),
      ]);
      const subsBody = await subsRes.json();
      if (!subsRes.ok) throw new Error(subsBody.error || `HTTP ${subsRes.status}`);
      setVideos(subsBody.videos);
      if (stateRes.ok) setQueuedIds(new Set((await stateRes.json()).map((v) => v.videoId)));
      setError(null);
      setVisibleCount(PAGE_SIZE);
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

  const isQueued = (videoId) => enqueued.has(videoId) || queuedIds.has(videoId);

  const channels = useMemo(() => {
    if (!videos) return [];
    return [...new Set(videos.map((v) => v.channelTitle))].sort();
  }, [videos]);

  const filtered = useMemo(() => {
    if (!videos) return [];
    const cutoff = range === 'all' ? null : Date.now() - RANGE_MS[range];
    const needle = search.trim().toLowerCase();
    return videos.filter((v) => {
      if (channel !== 'all' && v.channelTitle !== channel) return false;
      if (cutoff && new Date(v.publishedAt).getTime() < cutoff) return false;
      if (needle && !v.title.toLowerCase().includes(needle)) return false;
      if (hideQueued && isQueued(v.videoId)) return false;
      return true;
    });
  }, [videos, channel, range, search, hideQueued, enqueued, queuedIds]);

  const visible = filtered.slice(0, visibleCount);

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

      {!loading && videos?.length > 0 && (
        <div className="flex flex-col gap-2 border-b border-border px-6 py-3">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
              placeholder={t('searchPlaceholder')}
              className="w-full rounded-lg border border-border bg-card py-1.5 pl-8 pr-3 text-sm text-text placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={channel} onValueChange={(v) => { setChannel(v); setVisibleCount(PAGE_SIZE); }}>
              <SelectTrigger className="h-8 flex-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('allChannels')}</SelectItem>
                {channels.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={range} onValueChange={(v) => { setRange(v); setVisibleCount(PAGE_SIZE); }}>
              <SelectTrigger className="h-8 flex-1 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATE_RANGES.map((r) => (
                  <SelectItem key={r} value={r}>{t(`range_${r}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex flex-shrink-0 items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={hideQueued}
                onChange={(e) => { setHideQueued(e.target.checked); setVisibleCount(PAGE_SIZE); }}
                className="accent-[var(--color-primary)]"
              />
              {t('hideQueued')}
            </label>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex flex-1 items-center justify-center text-muted">
          <Loader2 size={18} className="mr-2 animate-spin" /> {t('loading')}
        </div>
      )}
      {error && <div className="p-6 text-sm text-error">{error}</div>}

      {!loading && !error && videos?.length === 0 && (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted">{t('empty')}</div>
      )}

      {!loading && videos?.length > 0 && filtered.length === 0 && (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted">{t('noMatches')}</div>
      )}

      {!loading && visible.length > 0 && (
        <div className="flex-1 divide-y divide-border overflow-y-auto">
          {visible.map((v) => (
            <div key={v.videoId} className="flex gap-3 px-6 py-3">
              <button onClick={() => onPreview(v)} className="flex-shrink-0 rounded-lg transition-opacity hover:opacity-80">
                <img
                  src={v.thumbnail || `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`}
                  alt=""
                  width={120}
                  height={68}
                  className="h-[68px] w-[120px] rounded-lg border border-border object-cover"
                />
              </button>
              <div className="min-w-0 flex-1">
                <button onClick={() => onPreview(v)} className="block w-full truncate text-left text-sm font-medium text-text hover:text-muted">
                  {v.title}
                </button>
                <p className="mt-0.5 truncate text-xs text-muted">{v.channelTitle}</p>
                <button
                  onClick={() => enqueue(v.url, v.videoId)}
                  disabled={isQueued(v.videoId)}
                  className="mt-1.5 flex items-center gap-1 text-sm text-muted hover:text-text disabled:text-success"
                >
                  <Send size={12} />
                  {isQueued(v.videoId) ? t('enqueued') : t('enqueue')}
                </button>
              </div>
            </div>
          ))}
          {visibleCount < filtered.length && (
            <div className="flex justify-center p-4">
              <button
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                className="rounded-lg border border-border px-4 py-1.5 text-sm text-muted transition-colors hover:bg-accent hover:text-text"
              >
                {t('loadMore', { count: filtered.length - visibleCount })}
              </button>
            </div>
          )}
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
