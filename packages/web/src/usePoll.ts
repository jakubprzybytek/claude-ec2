import { useCallback, useEffect, useRef, useState } from "react";

export interface Polled<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Loads `load()` now and again every `intervalMs` while the page is visible (0 or undefined: only on reload()).
 * `enabled` false clears nothing but stops loading.
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs: number | undefined, enabled = true): Polled<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loadRef.current());
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    if (!intervalMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, intervalMs);
    const onVisible = () => document.visibilityState === "visible" && void reload();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, intervalMs, reload]);

  return { data, error, loading, reload };
}
