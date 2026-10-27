import type { HubEvent } from '@agflow/core';
import { type DependencyList, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribe } from './live';
import { type Route, parseRoute } from './route';

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

/** The current time, refreshed every `intervalMs` so relative times stay right. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export interface Loaded<T> {
  data: T | undefined;
  error: Error | null;
  reload: () => void;
}

export interface LoadOptions {
  /** Reload when a live event passes this test. Without it, live events are ignored. */
  relevant?: (event: HubEvent) => boolean;
  /** Also reload on a timer, for values that change with time alone. */
  refreshMs?: number;
}

const RELOAD_DELAY_MS = 250;

/**
 * Loads data when `deps` change, then reloads it after relevant live events (a burst of events
 * causes one reload) and on the optional timer. Stale data stays visible while reloading.
 */
export function useData<T>(load: () => Promise<T>, deps: DependencyList, options: LoadOptions = {}): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const relevantRef = useRef(options.relevant);
  relevantRef.current = options.relevant;

  useEffect(() => {
    setData(undefined);
    setError(null);
  }, deps);

  useEffect(() => {
    let cancelled = false;
    loadRef.current().then(
      (value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
      },
      (caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught : new Error(String(caught)));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [...deps, tick]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe((event) => {
      if (!relevantRef.current?.(event)) return;
      clearTimeout(timer);
      timer = setTimeout(() => setTick((n) => n + 1), RELOAD_DELAY_MS);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!options.refreshMs) return;
    const timer = setInterval(() => setTick((n) => n + 1), options.refreshMs);
    return () => clearInterval(timer);
  }, [options.refreshMs]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return useMemo(() => ({ data, error, reload }), [data, error, reload]);
}

export interface Action {
  busy: boolean;
  error: string | null;
  /** Runs a hub call, keeping its error for display. Resolves to null when it failed. */
  run<T>(fn: () => Promise<T>): Promise<T | null>;
  clearError(): void;
}

export function useAction(): Action {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return useMemo(() => ({ busy, error, run, clearError }), [busy, error, run, clearError]);
}
