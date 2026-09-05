'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Columns2, Copy, Loader2, Maximize2, Minimize2, RotateCcw, Send } from 'lucide-react';
import { Sheet, SheetContent } from './ui/sheet.jsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.jsx';
import { YouTubePlayer } from './YouTubePlayer.jsx';
import { useVideoData } from '../hooks/useVideoData.js';
import { formatRelativeTime } from '../lib/relativeTime.js';

/** 3 anchos, no 2: 'half' es la lectura normal (50vw escritorio, 100% movil), 'full' es modo foco
 * (100vw, solo texto, para leer sin distracciones), y 'split' tambien va a 100vw pero reparte el
 * ancho con el reproductor de YouTube a la izquierda — ese SI necesita el ancho completo, 'half'
 * lo dejaria demasiado estrecho para ser util. */
const WIDTH_CLASS = {
  half: 'w-full sm:max-w-none sm:w-[50vw]',
  full: 'w-full sm:max-w-none sm:w-screen',
  split: 'w-full sm:max-w-none sm:w-screen',
};

export function ReaderDrawer({ videoId, onClose }) {
  const t = useTranslations('ReaderDrawer');
  const [mode, setMode] = useState('half');
  const { data, error, loading } = useVideoData(videoId);
  const open = Boolean(videoId);

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className={`flex flex-col gap-0 p-0 ${WIDTH_CLASS[mode]}`}>
        <DrawerHeader videoId={videoId} data={data} mode={mode} onModeChange={setMode} t={t} />

        {loading && (
          <div className="flex flex-1 items-center justify-center text-muted">
            <Loader2 size={18} className="mr-2 animate-spin" /> {t('loading')}
          </div>
        )}
        {error && <div className="p-6 text-sm text-error">{t('loadFailed', { error })}</div>}

        {data && (
          mode === 'split' ? (
            <div className="grid flex-1 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-2">
              <div className="border-b border-border p-6 lg:border-b-0 lg:border-r">
                <YouTubePlayer videoId={videoId} />
              </div>
              <div className="overflow-y-auto p-6">
                <Prose>{data.summaryBody}</Prose>
              </div>
            </div>
          ) : (
            <DrawerTabs data={data} t={t} />
          )
        )}

        {data && <ActionBar videoId={videoId} data={data} t={t} />}
      </SheetContent>
    </Sheet>
  );
}

function DrawerHeader({ videoId, data, mode, onModeChange, t }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
      <div className="min-w-0">
        <h2 className="truncate text-lg font-semibold tracking-tight text-text">
          {data?.title || t('loading')}
        </h2>
        {videoId && (
          <a
            href={`https://www.youtube.com/watch?v=${videoId}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-muted hover:text-text"
          >
            {t('watchOnYoutube')}
          </a>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1 pr-8">
        <button
          onClick={() => onModeChange(mode === 'split' ? 'half' : 'split')}
          title={t('splitViewTitle')}
          className={`rounded-lg p-2 transition-colors ${mode === 'split' ? 'bg-accent text-text' : 'text-muted hover:bg-accent hover:text-text'}`}
        >
          <Columns2 size={16} />
        </button>
        <button
          onClick={() => onModeChange(mode === 'full' ? 'half' : 'full')}
          title={mode === 'full' ? t('backToHalf') : t('fullscreen')}
          className={`rounded-lg p-2 transition-colors ${mode === 'full' ? 'bg-accent text-text' : 'text-muted hover:bg-accent hover:text-text'}`}
        >
          {mode === 'full' ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
    </div>
  );
}

function DrawerTabs({ data, t }) {
  return (
    // "email" primero y por defecto: es la vista que mejor queda (el diseño 2026 que se hizo
    // para la plantilla de email), asi que es lo primero que se ve al abrir el drawer.
    <Tabs defaultValue="email" className="flex flex-1 flex-col overflow-hidden">
      <TabsList className="mx-6 mt-3 w-fit bg-secondary text-muted">
        <TabsTrigger value="email">{t('tabEmail')}</TabsTrigger>
        <TabsTrigger value="resumen">{t('tabSummary')}</TabsTrigger>
        <TabsTrigger value="md">{t('tabMarkdown')}</TabsTrigger>
        <TabsTrigger value="transcripcion">{t('tabTranscript')}</TabsTrigger>
      </TabsList>

      <TabsContent value="email" className="flex flex-1 flex-col overflow-hidden p-6">
        {data.emailHtml ? (
          <>
            {/* El email en si SIEMPRE es fondo claro/texto oscuro, a proposito — asi llega a
                cualquier bandeja de entrada sin importar el tema del sistema del destinatario.
                Lo que cambia con el modo oscuro de la app es solo este marco alrededor: sin el,
                el iframe blanco se ve como un hueco roto flotando en medio de un panel oscuro. */}
            <p className="mb-2 flex-shrink-0 text-xs text-muted">{t('emailPreviewNote')}</p>
            <div className="min-h-0 flex-1 rounded-xl border border-border bg-card p-3 shadow-[var(--shadow-soft)]">
              <iframe title="Email preview" srcDoc={data.emailHtml} className="h-full w-full rounded-lg" />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">{t('noEmailYet')}</p>
        )}
      </TabsContent>

      <TabsContent value="resumen" className="flex-1 overflow-y-auto p-6">
        <Prose>{data.summaryBody}</Prose>
      </TabsContent>

      <TabsContent value="md" className="flex-1 overflow-y-auto p-6">
        <pre className="whitespace-pre-wrap rounded-xl bg-secondary p-4 font-mono text-xs text-text">{data.markdown}</pre>
      </TabsContent>

      <TabsContent value="transcripcion" className="flex-1 overflow-y-auto p-6">
        <Prose>{data.fullContent}</Prose>
      </TabsContent>
    </Tabs>
  );
}

/** Tipografia editorial: max 75ch centrado, igual que se pidio, reusando react-markdown en vez
 * de HTML pre-renderizado en el servidor — asi las 4 pestañas viven en el mismo componente. */
function Prose({ children }) {
  return (
    <div className="mx-auto max-w-[75ch] text-[15px] leading-7 text-text [&_h1]:mb-2 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h2]:mb-3 [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-semibold [&_li]:mb-1 [&_li]:leading-7 [&_p]:mb-4 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children || ''}</ReactMarkdown>
    </div>
  );
}

function ActionBar({ videoId, data, t }) {
  const locale = useLocale();
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [requeuing, setRequeuing] = useState(false);
  const [notice, setNotice] = useState(null);
  // Estado local optimista, igual que en VideoCard.jsx — data.readAt viene de useVideoData(),
  // que no se vuelve a pedir sola tras el toggle.
  const [readAt, setReadAt] = useState(data.readAt);
  const [togglingRead, setTogglingRead] = useState(false);

  async function toggleRead() {
    setTogglingRead(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/read`, { method: readAt ? 'DELETE' : 'POST' });
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json();
      setReadAt(body.readAt);
    } catch (err) {
      setNotice(t('markReadFailed', { error: err.message }));
    } finally {
      setTogglingRead(false);
    }
  }

  async function sendEmail() {
    setSending(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/resend`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      setNotice(t('emailResent'));
    } catch (err) {
      setNotice(t('sendFailed', { error: err.message }));
    } finally {
      setSending(false);
    }
  }

  async function copyMd() {
    await navigator.clipboard.writeText(data.markdown || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function reprocess() {
    setRequeuing(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/requeue`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      setNotice(t('requeuedNotice'));
    } catch (err) {
      setNotice(t('reprocessFailed', { error: err.message }));
    } finally {
      setRequeuing(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border bg-card px-6 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <button
          onClick={toggleRead}
          disabled={togglingRead}
          role="checkbox"
          aria-checked={Boolean(readAt)}
          title={readAt ? formatRelativeTime(new Date(readAt).getTime(), locale) : t('markRead')}
          className="flex flex-shrink-0 items-center gap-1.5 text-sm text-muted transition-colors hover:text-text disabled:opacity-60"
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
        <span className="truncate text-sm text-muted">{notice}</span>
      </div>
      <div className="flex flex-shrink-0 gap-2">
        <button
          onClick={reprocess}
          disabled={requeuing}
          className="flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:bg-accent hover:text-text disabled:opacity-60"
        >
          <RotateCcw size={14} /> {t('reprocess')}
        </button>
        <button
          onClick={copyMd}
          className="flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:bg-accent hover:text-text"
        >
          <Copy size={14} /> {copied ? t('copied') : t('copyMd')}
        </button>
        <button
          onClick={sendEmail}
          disabled={sending}
          className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          <Send size={14} /> {sending ? t('sending') : t('sendEmail')}
        </button>
      </div>
    </div>
  );
}
