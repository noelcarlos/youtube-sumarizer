import { useState } from 'react';
import { Clipboard, Send } from 'lucide-react';

export function EnqueueForm({ onEnqueued }) {
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState(null);

  async function enqueueUrls(urls) {
    if (urls.length === 0) return;
    setPending(true);
    setNotice(null);
    try {
      const res = await fetch('/api/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      if (!res.ok) throw new Error(await res.text());
      setValue('');
      onEnqueued?.();
    } catch (err) {
      setNotice(`No se pudo encolar: ${err.message}`);
    } finally {
      setPending(false);
    }
  }

  async function submit(ev) {
    ev.preventDefault();
    const urls = value.split(',').map((u) => u.trim()).filter(Boolean);
    await enqueueUrls(urls);
  }

  // Un solo click: lee el portapapeles Y encola directamente, sin pasar por el input ni por un
  // segundo click en "Encolar" — eso es lo que se pidio ("solo un click").
  async function pasteAndEnqueue() {
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // El navegador puede negar el permiso de lectura del portapapeles fuera de un gesto de
      // usuario reciente — esto SI lo es (un click), pero por si el permiso esta bloqueado a mano.
      setNotice('No se pudo leer el portapapeles — revisa el permiso del navegador para este sitio.');
      return;
    }
    const urls = (text || '').split(',').map((u) => u.trim()).filter(Boolean);
    if (urls.length === 0) {
      setNotice('El portapapeles no tiene ninguna URL.');
      return;
    }
    await enqueueUrls(urls);
  }

  return (
    <div className="mb-8">
      <form
        onSubmit={submit}
        className="flex flex-col gap-1.5 rounded-2xl border border-border bg-card p-1.5 shadow-[var(--shadow-soft)] transition-shadow focus-within:shadow-[var(--shadow-hover)] sm:flex-row sm:items-center"
      >
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="pega una URL de YouTube (o varias separadas por coma)"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm text-text placeholder:text-muted focus:outline-none"
        />
        <div className="flex gap-1.5">
          <button
            type="submit"
            disabled={pending}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-60 sm:flex-none"
          >
            <Send size={14} />
            {pending ? 'Encolando…' : 'Encolar'}
          </button>
          <button
            type="button"
            onClick={pasteAndEnqueue}
            disabled={pending}
            title="Encolar del portapapeles (un click)"
            aria-label="Encolar del portapapeles"
            className="flex flex-1 items-center justify-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium text-muted transition-colors hover:bg-zinc-100 hover:text-text disabled:opacity-60 sm:flex-none"
          >
            <Clipboard size={16} />
            <span className="hidden sm:inline">Encolar portapapeles</span>
            <span className="sm:hidden">Portapapeles</span>
          </button>
        </div>
      </form>
      {notice && (
        <p className="mt-2 rounded-lg border border-error/20 bg-error-bg px-2.5 py-1.5 text-sm text-error">{notice}</p>
      )}
    </div>
  );
}
