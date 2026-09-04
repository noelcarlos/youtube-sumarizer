import { useEffect, useRef, useState } from 'react';

/** Sondea /api/state cada `intervalMs`. El estado real vive en las carpetas del pipeline
 * (server.js lo deriva en vivo); este hook solo lo refleja, no inventa nada.
 *
 * `loading` es solo true antes del PRIMER fetch que resuelve — no se vuelve a poner a true en
 * los sondeos siguientes, para que la lista no parpadee a un skeleton cada 1.5s. */
export function useQueueState(intervalMs = 1500) {
  const [videos, setVideos] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const timer = useRef(null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      try {
        const res = await fetch('/api/state');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setVideos(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    tick();
    timer.current = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer.current);
    };
  }, [intervalMs]);

  return { videos, error, loading };
}
