import type { HubEvent } from '@agflow/core';
import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';
import { api } from './api';

type Listener = (event: HubEvent) => void;

const listeners = new Set<Listener>();

/** Runs `listener` for every live event until the returned function is called. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type Connection = 'connecting' | 'live' | 'reconnecting';

const ConnectionContext = createContext<Connection>('connecting');
const RecentContext = createContext<HubEvent[]>([]);

export const RECONNECT_MS = 3000;
const KEEP_RECENT = 500;

/**
 * Keeps one Server-Sent Events connection to the hub. It starts after the newest stored event, so
 * nothing is replayed when the page opens, and it reconnects from the last event it saw.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection>('connecting');
  const [recent, setRecent] = useState<HubEvent[]>([]);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastId = 0;
    let stopped = false;

    const open = () => {
      if (stopped) return;
      source = new EventSource(`/api/events/stream?after=${lastId}`);
      source.onopen = () => setConnection('live');
      source.addEventListener('hub', (message) => {
        const event = JSON.parse((message as MessageEvent<string>).data) as HubEvent;
        if (event.id <= lastId) return;
        lastId = event.id;
        setRecent((list) => [event, ...list].slice(0, KEEP_RECENT));
        for (const listener of listeners) listener(event);
      });
      source.onerror = () => {
        source?.close();
        setConnection('reconnecting');
        retry = setTimeout(open, RECONNECT_MS);
      };
    };

    // Find the newest stored event first, so the stream replays nothing. If that fails, try again
    // later rather than streaming from the beginning.
    const start = () => {
      if (stopped) return;
      api.events({ latest: true, limit: 1 }).then(
        (events) => {
          lastId = events[0]?.id ?? 0;
          open();
        },
        () => {
          setConnection('reconnecting');
          retry = setTimeout(start, RECONNECT_MS);
        },
      );
    };
    start();

    return () => {
      stopped = true;
      clearTimeout(retry);
      source?.close();
    };
  }, []);

  return (
    <ConnectionContext.Provider value={connection}>
      <RecentContext.Provider value={recent}>{children}</RecentContext.Provider>
    </ConnectionContext.Provider>
  );
}

/** The state of the live connection to the hub. */
export function useConnection(): Connection {
  return useContext(ConnectionContext);
}

/** Events that arrived since the page opened, newest first. */
export function useRecentEvents(): HubEvent[] {
  return useContext(RecentContext);
}
