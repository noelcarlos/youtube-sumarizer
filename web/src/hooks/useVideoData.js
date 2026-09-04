import { useEffect, useState } from 'react';

/** Carga los datos de un video para el drawer de lectura en una sola llamada — /api/videos/:id/data
 * ya trae resumen, transcripcion completa, el email enviado y el .md crudo juntos, para no hacer
 * 4 peticiones (una por pestaña) ni depender de HTML pre-renderizado en el servidor. */
export function useVideoData(videoId) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!videoId) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/videos/${videoId}/data`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      })
      .then((json) => { if (!cancelled) setData(json); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [videoId]);

  return { data, error, loading };
}
