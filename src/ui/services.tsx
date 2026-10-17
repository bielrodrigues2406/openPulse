import { createContext, useContext, useSyncExternalStore } from 'react';
import type { Cues } from '../app/cues';
import type { LiveSession } from '../app/live-session';
import type { MorningTest } from '../app/morning-test';
import type { SensorHub } from '../app/sensor-hub';
import type { AppData } from './app-data';

export interface Services {
  readonly live: LiveSession;
  readonly morning: MorningTest;
  readonly hub: SensorHub;
  readonly data: AppData;
  readonly cues: Cues;
  readonly toast: (text: string) => void;
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesContext missing');
  return s;
}

export function useLive() {
  const { live } = useServices();
  return useSyncExternalStore(live.subscribe, live.getSnapshot);
}

export function useData() {
  const { data } = useServices();
  return useSyncExternalStore(data.subscribe, data.getSnapshot);
}

export function useHub() {
  const { hub } = useServices();
  return useSyncExternalStore(hub.subscribe, hub.getSnapshot);
}

export function useMorning() {
  const { morning } = useServices();
  return useSyncExternalStore(morning.subscribe, morning.getState);
}
