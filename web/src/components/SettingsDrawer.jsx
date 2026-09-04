'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, RotateCcw, Settings as SettingsIcon } from 'lucide-react';
import { Sheet, SheetContent } from './ui/sheet.jsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs.jsx';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.jsx';
import { Switch } from './ui/switch.jsx';
import { useSettings } from '../hooks/useSettings.js';

const PROVIDERS = ['lmstudio', 'nvidia', 'gemini', 'deepseek'];

// Cada etapa pausable, junto con la clave de traduccion de su nombre — mismo orden que el
// pipeline avanza (descarga -> resumen IA -> interpretar -> email).
const QUEUE_STAGES = [
  { key: 'DOWNLOAD', labelKey: 'queueDownload' },
  { key: 'AI_SUMMARIZE', labelKey: 'queueAiSummarize' },
  { key: 'INTERPRET_SUMMARY', labelKey: 'queueInterpretSummary' },
  { key: 'EMAIL', labelKey: 'queueEmail' },
];

export function SettingsDrawer() {
  const t = useTranslations('SettingsDrawer');
  const [open, setOpen] = useState(false);
  const { settings, error, loading, save } = useSettings();

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={t('openTitle')}
        aria-label={t('openTitle')}
        className="flex flex-shrink-0 items-center justify-center rounded-full p-1.5 text-muted transition-colors hover:bg-accent hover:text-text"
      >
        <SettingsIcon size={16} />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-none sm:w-[420px]">
          <div className="border-b border-border px-6 py-4">
            <h2 className="text-lg font-semibold tracking-tight text-text">{t('title')}</h2>
          </div>

          {loading && (
            <div className="flex flex-1 items-center justify-center text-muted">
              <Loader2 size={18} className="mr-2 animate-spin" /> {t('loading')}
            </div>
          )}
          {error && <div className="p-6 text-sm text-error">{t('loadFailed', { error })}</div>}

          {settings && (
            <Tabs defaultValue="llm" className="flex flex-1 flex-col overflow-hidden">
              <TabsList className="mx-6 mt-3 w-fit bg-secondary text-muted">
                <TabsTrigger value="llm">{t('tabLlm')}</TabsTrigger>
                <TabsTrigger value="queues">{t('tabQueues')}</TabsTrigger>
                <TabsTrigger value="email">{t('tabEmail')}</TabsTrigger>
              </TabsList>

              <TabsContent value="llm" className="flex-1 overflow-y-auto p-6">
                <LlmTab settings={settings} save={save} t={t} />
              </TabsContent>
              <TabsContent value="queues" className="flex-1 overflow-y-auto p-6">
                <QueuesTab settings={settings} save={save} t={t} />
              </TabsContent>
              <TabsContent value="email" className="flex-1 overflow-y-auto p-6">
                <EmailTab settings={settings} save={save} t={t} />
              </TabsContent>
            </Tabs>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function useSaveStatus() {
  const [status, setStatus] = useState(null); // null | 'saving' | 'saved' | { error }
  async function run(fn) {
    setStatus('saving');
    try {
      await fn();
      setStatus('saved');
      setTimeout(() => setStatus(null), 1500);
    } catch (err) {
      setStatus({ error: err.message });
    }
  }
  return [status, run];
}

function LlmTab({ settings, save, t }) {
  const [provider, setProvider] = useState(settings.llm.provider);
  const [drafts, setDrafts] = useState(() => {
    const initial = {};
    for (const prov of PROVIDERS) {
      const p = settings.llm.providers[prov];
      initial[prov] = { model: p.model || '', baseUrl: p.baseUrl || '', apiKey: '', hasKey: p.hasKey };
    }
    return initial;
  });
  // Cache por proveedor: {status: 'idle'|'loading'|'ready'|'error', models, error} — no se
  // vuelve a pedir cada vez que se cambia de pestaña y se vuelve, solo al cambiar de proveedor
  // (la primera vez) o al pulsar el boton de refrescar.
  const [modelLists, setModelLists] = useState({});
  const [status, run] = useSaveStatus();

  const draft = drafts[provider];
  const modelList = modelLists[provider];

  function patchDraft(field, value) {
    setDrafts((d) => ({ ...d, [provider]: { ...d[provider], [field]: value } }));
  }

  async function fetchModels() {
    setModelLists((m) => ({ ...m, [provider]: { status: 'loading' } }));
    try {
      const res = await fetch('/api/settings/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey: draft.apiKey || undefined, baseUrl: draft.baseUrl || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setModelLists((m) => ({ ...m, [provider]: { status: 'ready', models: body.models } }));
    } catch (err) {
      setModelLists((m) => ({ ...m, [provider]: { status: 'error', error: err.message } }));
    }
  }

  // Se pide la lista sola la primera vez que se entra a cada proveedor — asi el combo ya
  // viene poblado sin que haga falta acordarse de pulsar "refrescar".
  useEffect(() => {
    if (!modelLists[provider]) fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  function onSave() {
    run(async () => {
      const overridePatch = { model: draft.model, baseUrl: draft.baseUrl };
      if (draft.apiKey) overridePatch.apiKey = draft.apiKey;
      const view = await save({ llm: { provider, overrides: { [provider]: overridePatch } } });
      // La key nunca vuelve del servidor: limpiamos el campo pero recordamos que YA hay una.
      setDrafts((d) => ({ ...d, [provider]: { ...d[provider], apiKey: '', hasKey: view.llm.providers[provider].hasKey } }));
    });
  }

  // El modelo actual siempre aparece en el combo aunque el catalogo devuelto no lo incluya
  // (por ejemplo, uno ya guardado que el proveedor retiro) — si no, se veria un combo vacio
  // encima de un modelo que sigue configurado.
  const options = modelList?.status === 'ready'
    ? [...new Set([draft.model, ...modelList.models].filter(Boolean))]
    : [];

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text">{t('llmProvider')}</span>
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((prov) => (
              <SelectItem key={prov} value={prov}>{prov}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text">{t('llmModel')}</span>
        <div className="flex gap-1.5">
          {modelList?.status === 'ready' && options.length > 0 ? (
            <Select value={draft.model} onValueChange={(v) => patchDraft('model', v)}>
              <SelectTrigger className="flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((m) => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <input
              value={draft.model}
              onChange={(e) => patchDraft('model', e.target.value)}
              placeholder={modelList?.status === 'loading' ? t('llmModelsLoading') : t('llmModelsFreeText')}
              className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-text placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
            />
          )}
          <button
            type="button"
            onClick={fetchModels}
            disabled={modelList?.status === 'loading'}
            title={t('llmModelsRefresh')}
            aria-label={t('llmModelsRefresh')}
            className="flex items-center justify-center rounded-lg border border-border px-2.5 text-muted transition-colors hover:bg-accent hover:text-text disabled:opacity-60"
          >
            <RotateCcw size={14} className={modelList?.status === 'loading' ? 'animate-spin' : ''} />
          </button>
        </div>
        {modelList?.status === 'error' && (
          <span className="text-xs text-error">{t('llmModelsFailed', { error: modelList.error })}</span>
        )}
      </label>

      {provider !== 'gemini' && (
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text">{t('llmBaseUrl')}</span>
          <input
            value={draft.baseUrl}
            onChange={(e) => patchDraft('baseUrl', e.target.value)}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
      )}

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text">{t('llmApiKey')}</span>
        <input
          type="password"
          value={draft.apiKey}
          onChange={(e) => patchDraft('apiKey', e.target.value)}
          placeholder={draft.hasKey ? t('llmApiKeyPlaceholderSet') : t('llmApiKeyPlaceholderUnset')}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <span className="text-xs text-muted">{t('llmApiKeyHint')}</span>
        {!draft.hasKey && <span className="text-xs text-warn">{t('llmNoKeyWarning')}</span>}
      </label>

      <SaveButton status={status} onSave={onSave} t={t} />
    </div>
  );
}

function QueuesTab({ settings, save, t }) {
  const [paused, setPaused] = useState(settings.paused);
  const [pending, setPending] = useState(null); // stage key currently toggling

  async function toggle(stageKey, value) {
    setPending(stageKey);
    try {
      const view = await save({ paused: { [stageKey]: value } });
      setPaused(view.paused);
    } catch {
      // el switch vuelve a su valor real en el proximo render porque `paused` no se tocó
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t('queuesIntro')}</p>
      <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
        {QUEUE_STAGES.map(({ key, labelKey }) => (
          <div key={key} className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-text">{t(labelKey)}</div>
              <div className="text-xs text-muted">{paused[key] ? t('queuePaused') : t('queueRunning')}</div>
            </div>
            <Switch
              checked={paused[key]}
              disabled={pending === key}
              onCheckedChange={(value) => toggle(key, value)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function EmailTab({ settings, save, t }) {
  const [to, setTo] = useState(settings.email.to);
  const [bcc, setBcc] = useState(settings.email.bcc);
  const [status, run] = useSaveStatus();

  function onSave() {
    run(() => save({ email: { to, bcc } }));
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text">{t('emailTo')}</span>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text">{t('emailBcc')}</span>
        <input
          value={bcc}
          onChange={(e) => setBcc(e.target.value)}
          placeholder={t('emailBccPlaceholder')}
          className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-text placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <p className="text-xs text-muted">{t('emailSenderNote')}</p>
      <SaveButton status={status} onSave={onSave} t={t} />
    </div>
  );
}

function SaveButton({ status, onSave, t }) {
  return (
    <div className="flex items-center gap-3">
      <button
        onClick={onSave}
        disabled={status === 'saving'}
        className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
      >
        {status === 'saving' ? t('saving') : t('save')}
      </button>
      {status === 'saved' && <span className="text-sm text-success">{t('saved')}</span>}
      {status?.error && <span className="text-sm text-error">{t('saveFailed', { error: status.error })}</span>}
    </div>
  );
}
