'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import { useLocale, useTranslations } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Columns2, Copy, FastForward, Loader2, Maximize2, Minimize2, RotateCcw, Send } from 'lucide-react';
import { Sheet, SheetContent } from './ui/sheet.jsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.jsx';
import { YouTubePlayer } from './YouTubePlayer.jsx';
import { useVideoData } from '../hooks/useVideoData.js';
import { formatRelativeTime } from '../lib/relativeTime.js';
import { useConfirmDialog } from './ConfirmDialog.jsx';

/** El .html que de verdad se manda por correo tiene que quedarse SIEMPRE claro (ver EmailStage en
 * resumir_video.js) — eso no se toca aqui. Esto es solo para la COPIA que se muestra en el iframe
 * de este drawer: se inserta un <style> extra justo antes de </head>, con las mismas reglas que
 * ya trae el email (mismos selectores, mismo !important) pero en oscuro — al ir DESPUES en el
 * documento, gana el empate de especificidad+importancia contra los estilos originales, sin
 * tener que tocar ni una linea del email real. */
const EMAIL_PREVIEW_DARK_OVERRIDE = `
<style>
  body { background: #14141f !important; color: #ededf5 !important; }
  .container { background: #1c1c2b !important; border-color: #2e2e42 !important; }
  .container-full { background: #262636 !important; border: 1px solid #40405a !important; }
  .transcript-note { color: #9494ac !important; }
  .yt-link { color: #a296ff !important; }
  .yt-link:hover { color: #cbc4ff !important; }
  h1, h2, strong { color: #ededf5 !important; }
  a { color: #a296ff !important; }
  p, li { color: #cbcbdd !important; }
  hr { border-top-color: #2e2e42 !important; }
  .content img { background: #1c1c2b !important; border-color: #40405a !important; }
  .footer { color: #9494ac !important; border-top-color: #40405a !important; }
  .footer-tag { background: #1c1c2b !important; border-color: #40405a !important; color: #a296ff !important; }
</style>
`;

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
      <div className="flex min-w-0 items-center gap-3">
        {/* La miniatura no depende de ninguna etapa del pipeline (la URL de YouTube es
            predecible desde el propio videoId) — no habia ninguna razon para que faltara aqui
            solo porque el resto del drawer si depende de Resumen/Rewrite/Fusion. */}
        {videoId && (
          <img
            src={`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`}
            alt=""
            width={80}
            height={45}
            className="h-[45px] w-[80px] flex-shrink-0 rounded-sm border border-border object-cover"
            onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
          />
        )}
        <div className="min-w-0">
          <h2 className="truncate font-serif text-lg font-medium tracking-tight text-text">
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
      </div>
      <div className="flex flex-shrink-0 items-center gap-1 pr-8">
        <button
          onClick={() => onModeChange(mode === 'split' ? 'half' : 'split')}
          title={t('splitViewTitle')}
          className={`rounded-sm p-2 transition-colors ${mode === 'split' ? 'bg-accent text-text' : 'text-muted hover:bg-accent hover:text-text'}`}
        >
          <Columns2 size={16} />
        </button>
        <button
          onClick={() => onModeChange(mode === 'full' ? 'half' : 'full')}
          title={mode === 'full' ? t('backToHalf') : t('fullscreen')}
          className={`rounded-sm p-2 transition-colors ${mode === 'full' ? 'bg-accent text-text' : 'text-muted hover:bg-accent hover:text-text'}`}
        >
          {mode === 'full' ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      </div>
    </div>
  );
}

function DrawerTabs({ data, t }) {
  const { resolvedTheme } = useTheme();
  // El iframe es un documento aparte — no hereda la clase .dark del resto de la app, asi que
  // hay que decidir aqui mismo si le hace falta el override, e inyectarlo a mano.
  const emailPreviewHtml = useMemo(() => {
    if (!data.emailHtml) return null;
    if (resolvedTheme !== 'dark') return data.emailHtml;
    return data.emailHtml.includes('</head>')
      ? data.emailHtml.replace('</head>', `${EMAIL_PREVIEW_DARK_OVERRIDE}</head>`)
      : EMAIL_PREVIEW_DARK_OVERRIDE + data.emailHtml;
  }, [data.emailHtml, resolvedTheme]);

  // "email" siempre por defecto, sea preview o no — ahora que la vista previa del email se
  // calcula con lo que ya hay (ver buildEmailHtml en server.js), esa pestaña ya tiene contenido
  // de verdad incluso mientras Rewrite/Fusion siguen trabajando, asi que no hace falta abrir en
  // otra pestaña distinta a la primera.
  return (
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
            {/* El .html que de verdad se manda por correo SIEMPRE es claro, a proposito — asi
                llega igual a cualquier bandeja de entrada sin importar el tema del destinatario
                (ver EmailStage en resumir_video.js, eso no se toca). emailPreviewHtml es una
                COPIA con un override oscuro inyectado solo para esta vista previa — el marco de
                alrededor (este div) tambien ayuda a que no se vea como un hueco roto. */}
            <p className="mb-2 flex-shrink-0 text-xs text-muted">
              {data.emailIsPreview ? t('emailComputedPreviewNote') : t('emailPreviewNote')}
            </p>
            <div className="min-h-0 flex-1 rounded-sm border border-border bg-card p-3 shadow-[var(--shadow-soft)]">
              <iframe title="Email preview" srcDoc={emailPreviewHtml} className="h-full w-full rounded-sm" />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">{data.fullContentIsPreview ? t('notReadyYet') : t('noEmailYet')}</p>
        )}
      </TabsContent>

      <TabsContent value="resumen" className="flex-1 overflow-y-auto p-6">
        <Prose>{data.summaryBody}</Prose>
      </TabsContent>

      <TabsContent value="md" className="flex-1 overflow-y-auto p-6">
        {data.markdown ? (
          <pre className="whitespace-pre-wrap rounded-sm bg-secondary p-4 font-mono text-xs text-text">{data.markdown}</pre>
        ) : (
          <p className="text-sm text-muted">{t('notReadyYet')}</p>
        )}
      </TabsContent>

      <TabsContent value="transcripcion" className="flex-1 overflow-y-auto p-6">
        {data.fullContentIsPreview && <PreviewNotice t={t} />}
        <Prose>{data.fullContent}</Prose>
      </TabsContent>
    </Tabs>
  );
}

/** Aviso en la pestaña de transcripcion cuando lo que se ve es el transcript CRUDO (sin pasar
 * por Rewrite todavia) — para que no se confunda con la reescritura/traduccion fiel final, que
 * puede tener un idioma, formato o nivel de detalle distinto. */
function PreviewNotice({ t }) {
  return (
    <div className="mx-auto mb-4 flex max-w-[70ch] items-center gap-2 rounded-sm border border-warn/30 bg-warn-bg px-3 py-2 text-sm text-warn">
      <Loader2 size={14} className="flex-shrink-0 animate-spin" />
      {t('transcriptPreviewNotice')}
    </div>
  );
}

/** Tipografia editorial: max 75ch centrado, igual que se pidio, reusando react-markdown en vez
 * de HTML pre-renderizado en el servidor — asi las 4 pestañas viven en el mismo componente. */
function Prose({ children }) {
  return (
    <div className="mx-auto max-w-[70ch] font-serif text-[16px] leading-[1.75] text-text [&_h1]:mb-2 [&_h1]:font-serif [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h2]:mb-3 [&_h2]:mt-8 [&_h2]:font-serif [&_h2]:text-xl [&_h2]:font-semibold [&_li]:mb-1 [&_li]:leading-[1.75] [&_p]:mb-4 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children || ''}</ReactMarkdown>
    </div>
  );
}

function ActionBar({ videoId, data, t }) {
  const locale = useLocale();
  const { confirm: confirmDialog, ConfirmDialog } = useConfirmDialog();
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [requeuing, setRequeuing] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [notice, setNotice] = useState(null);
  // Estado local optimista, igual que en VideoCard.jsx — data.readAt viene de useVideoData(),
  // que no se vuelve a pedir sola tras el toggle. El useEffect sincroniza si data.readAt cambia
  // por fuera (por ejemplo, si esta misma tarjeta ya se habia marcado desde la grilla antes de
  // abrir el drawer).
  const [readAt, setReadAt] = useState(data.readAt);
  useEffect(() => { setReadAt(data.readAt); }, [data.readAt]);
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

  // Aqui, a diferencia de la tarjeta en la grilla, ya se ha LEIDO el resumen y el transcript sin
  // pulir antes de decidir — es la version informada del mismo boton, por eso el usuario la pidio
  // aqui como la version que de verdad importa (en la tarjeta no se sabe si el contenido merece
  // la pena esperar la reescritura o no).
  async function skipRewrite() {
    if (!(await confirmDialog(t('confirmSkipRewrite')))) return;
    setSkipping(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/skip-rewrite`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      setSkipped(true);
    } catch (err) {
      setNotice(t('skipRewriteFailed', { error: err.message }));
    } finally {
      setSkipping(false);
    }
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
      {ConfirmDialog}
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
      {/* Reprocesar/copiar .md/reenviar email no tienen nada real que hacer todavia mientras
          fullContentIsPreview — no hay email que reenviar ni .md final que copiar, y el video no
          esta en error (asi que /requeue devolveria un 409 confuso). En su lugar va el boton que
          si tiene sentido aqui: "usar sin pulir" — mas importante en el lector que en la tarjeta,
          porque aqui ya se ha visto el contenido antes de decidir si merece la pena esperar. */}
      {data.fullContentIsPreview ? (
        skipped ? (
          <span className="flex-shrink-0 text-sm text-success">{t('skipRewriteNotice')}</span>
        ) : (
          <div className="flex flex-shrink-0 items-center gap-3">
            <span className="text-xs text-muted">{t('previewActionsHint')}</span>
            <button
              onClick={skipRewrite}
              disabled={skipping}
              className="flex items-center gap-1.5 rounded-sm bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
            >
              <FastForward size={14} /> {skipping ? t('skippingRewrite') : t('skipRewrite')}
            </button>
          </div>
        )
      ) : (
        <div className="flex flex-shrink-0 gap-2">
          <button
            onClick={reprocess}
            disabled={requeuing}
            className="flex items-center gap-1.5 rounded-sm px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:bg-accent hover:text-text disabled:opacity-60"
          >
            <RotateCcw size={14} /> {t('reprocess')}
          </button>
          <button
            onClick={copyMd}
            className="flex items-center gap-1.5 rounded-sm px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:bg-accent hover:text-text"
          >
            <Copy size={14} /> {copied ? t('copied') : t('copyMd')}
          </button>
          <button
            onClick={sendEmail}
            disabled={sending}
            className="flex items-center gap-1.5 rounded-sm bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            <Send size={14} /> {sending ? t('sending') : t('sendEmail')}
          </button>
        </div>
      )}
    </div>
  );
}
