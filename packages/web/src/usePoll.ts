import { useCallback, useEffect, useRef, useState } from "react";

export interface Polled<T> {
  data: T | undefined;
  error: string | undefined;
  /** A request is under way (also while older data is shown). */
  loading: boolean;
  /** When `data` was loaded (epoch ms); from the cache until the first answer of this page. */
  fetchedAt: number | undefined;
  /** `data` comes from the cache of an earlier visit and has not been refreshed yet. */
  stale: boolean;
  reload: () => Promise<void>;
  /** Replaces `data` now, e.g. with what an action answered, before the next load confirms it. */
  set: (data: T) => void;
}

const CACHE_PREFIX = "claude-ec2:cache:";

export interface Cached<T> {
  data: T;
  at: number;
}

// The cache is a convenience (the page shows the last known state at once, then refreshes it): storage may be off.
function readCache<T>(key: string | undefined): Cached<T> | undefined {
  if (!key) return undefined;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as Cached<T>) : undefined;
  } catch {
    return undefined;
  }
}

function writeCache<T>(key: string | undefined, data: T, at: number) {
  if (!key) return;
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data, at }));
  } catch {
    /* full or off */
  }
}

/** Forgets every cached answer (on sign-out). */
export function clearCache() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
  } catch {
    /* off */
  }
}

/**
 * Loads `load()` now and again every `intervalMs` while the page is visible (0 or undefined: only on reload()).
 * `enabled` false clears nothing but stops loading. With `cacheKey`, the last answer is kept in localStorage and shown
 * at once on the next visit (`stale` until refreshed). With `fresh`, a cached answer it accepts is used as is: the first
 * load is skipped (reload() still asks).
 */
export function usePoll<T>(
  load: () => Promise<T>,
  intervalMs: number | undefined,
  enabled = true,
  cacheKey?: string,
  fresh?: (cached: Cached<T>, now: number) => boolean,
): Polled<T> {
  const [initial] = useState(() => readCache<T>(cacheKey));
  const [initialFresh] = useState(() => !!(initial && fresh?.(initial, Date.now())));
  const [data, setData] = useState<T | undefined>(initial?.data);
  const [fetchedAt, setFetchedAt] = useState<number | undefined>(initial?.at);
  const [stale, setStale] = useState(initial !== undefined && !initialFresh);
  // The first load is skipped once, when the cached answer is fresh.
  const skipFirst = useRef(initialFresh);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  // Only the newest request may set the result (an older, slower one must not overwrite it).
  const seq = useRef(0);

  const set = useCallback(
    (d: T) => {
      const at = Date.now();
      setData(d);
      setFetchedAt(at);
      setStale(false);
      writeCache(cacheKey, d, at);
    },
    [cacheKey],
  );

  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await loadRef.current();
      if (n !== seq.current) return;
      set(d);
      setError(undefined);
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [set]);

  useEffect(() => {
    if (!enabled) return;
    if (skipFirst.current) skipFirst.current = false;
    else void reload();
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

  return { data, error, loading, fetchedAt, stale, reload, set };
}

/** Re-renders every `ms`, for countdowns and "ago" texts between loads. */
export function useTick(ms: number) {
  const [, setNow] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
}
