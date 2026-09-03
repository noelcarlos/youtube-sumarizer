import { useState } from 'react';
import { Clipboard, Send } from 'lucide-react';

export function EnqueueForm({ onEnqueued }) {
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState(null);

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setValue(text.trim());
    } catch {
      // El navegador puede negar el permiso de lectura del portapapeles fuera de un gesto de
      // usuario reciente — esto SI lo es (un click), pero por si el permiso esta bloqueado a mano.
      setNotice('No se pudo leer el portapapeles — revisa el permiso del navegador para este sitio.');
    }
  }

  async function submit(ev) {
    ev.preventDefault();
    const urls = value.split(',').map((u) => u.trim()).filter(Boolean);
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

  return (
    <div className="mb-8">
      <form onSubmit={submit} className="flex border border-ink bg-paper-card">
        <button
          type="button"
          onClick={pasteFromClipboard}
          title="Pegar del portapapeles"
          aria-label="Pegar del portapapeles"
          className="flex items-center border-r border-ink px-3 text-ink-dim hover:bg-paper hover:text-ink"
        >
          <Clipboard size={16} />
        </button>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="pega una URL de YouTube (o varias separadas por coma)"
          autoComplete="off"
          className="flex-1 bg-transparent px-3 py-3 font-mono text-sm text-ink placeholder:text-ink-dim focus:outline-none focus:bg-white"
        />
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-2 border-l border-ink bg-red px-5 font-serif text-sm font-semibold text-[#fff5ee] hover:bg-red-dark disabled:opacity-60"
        >
          <Send size={14} />
          {pending ? 'Encolando…' : 'Encolar'}
        </button>
      </form>
      {notice && <p className="mt-2 border-l-2 border-red pl-2 text-sm text-red">{notice}</p>}
    </div>
  );
}
