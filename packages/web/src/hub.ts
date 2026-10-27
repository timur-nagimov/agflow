import type { HubStatus, Task } from '@agflow/core';
import { createContext, useContext } from 'react';
import type { Me } from './api';
import type { Loaded } from './hooks';

/** What every signed-in view can use: who is signed in, the hub status and all tasks. */
export interface Hub {
  me: Me;
  status: Loaded<HubStatus>;
  tasks: Loaded<Task[]>;
  /** The newest message to people that this browser has shown. */
  peopleSeen: number;
  markPeopleSeen: (id: number) => void;
}

export const HubContext = createContext<Hub | null>(null);

export function useHub(): Hub {
  const hub = useContext(HubContext);
  if (!hub) throw new Error('useHub is only available inside the signed-in app');
  return hub;
}
