import type { HubEvent } from '@agflow/core';
import { type DependencyList, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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

const CLOCK_MS = 30_000;
const clock: { now: number; listeners: Set<() => void>; timer: ReturnType<typeof setInterval> | undefined } = {
  now: Date.now(),
  listeners: new Set(),
  timer: undefined,
};

function subscribeClock(listener: () => void): () => void {
  clock.listeners.add(listener);
  if (clock.timer === undefined) {
    clock.now = Date.now();
    clock.timer = setInterval(() => {
      clock.now = Date.now();
      for (const notify of clock.listeners) notify();
    }, CLOCK_MS);
  }
  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size === 0) {
      clearInterval(clock.timer);
      clock.timer = undefined;
    }
  };
}

/** The current time, from one clock shared by every component and refreshed every 30 seconds. */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, () => clock.now);
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
  /** Keep showing the previous data while new inputs load, instead of starting empty. */
  keep?: boolean;
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
  const keepRef = useRef(options.keep);
  keepRef.current = options.keep;

  useEffect(() => {
    if (keepRef.current) return;
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

export type Outcome<T> = { ok: true; value: T } | { ok: false };

export interface Action {
  busy: boolean;
  error: string | null;
  /** Runs a hub call and keeps its error for display. */
  run<T>(fn: () => Promise<T>): Promise<Outcome<T>>;
  clearError(): void;
}

export function useAction(): Action {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<Outcome<T>> => {
    setBusy(true);
    setError(null);
    try {
      return { ok: true, value: await fn() };
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return { ok: false };
    } finally {
      setBusy(false);
    }
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return useMemo(() => ({ busy, error, run, clearError }), [busy, error, run, clearError]);
}
