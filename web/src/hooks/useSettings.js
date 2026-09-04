'use client';

import { useCallback, useEffect, useState } from 'react';

/** A diferencia de useQueueState, esto NO sondea — settings solo cambia cuando el propio
 * usuario guarda algo desde este mismo drawer, así que un fetch al abrir es suficiente. */
export function useSettings() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSettings(await res.json());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const save = useCallback(async (patch) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    setSettings(body);
    return body;
  }, []);

  return { settings, error, loading, save, reload };
}
