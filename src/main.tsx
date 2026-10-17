import { StrictMode, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/greek-400.css';
import '@fontsource/ibm-plex-sans/greek-500.css';
import '@fontsource/ibm-plex-sans/greek-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import './ui/theme.css';
import { Cues } from './app/cues';
import { LiveSession, type DspChannel } from './app/live-session';
import { MorningTest } from './app/morning-test';
import { SensorHub, type SourceKind } from './app/sensor-hub';
import { LibraryRepository, MorningRepository, SessionRepository, openDb } from './adapters/storage';
import { SimulatedH10Adapter } from './adapters/simulated-h10.adapter';
import { WebBluetoothH10Adapter, isWebBluetoothAvailable } from './adapters/web-bluetooth-h10.adapter';
import { NativeH10Adapter } from './adapters/native-h10.adapter';
import { zoneBounds } from './domain/athlete/profile';
import type { DspRequest, DspResponse, Tagged } from './workers/dsp.protocol';
import { AppData } from './ui/app-data';
import { App, useToast } from './ui/App';
import { ServicesContext, type Services } from './ui/services';
import { desktopBridge, registerAutoConnect } from './ui/desktop';

function createDsp(): DspChannel {
  const worker = new Worker(new URL('./workers/dsp.worker.ts', import.meta.url), { type: 'module' });
  return {
    post: (msg) => worker.postMessage(msg satisfies Tagged<DspRequest>),
    onMessage: (listener) => worker.addEventListener('message', (e: MessageEvent<Tagged<DspResponse>>) => listener(e.data)),
  };
}

function build(): Services {
  const db = openDb();
  const data = new AppData(new SessionRepository(db), new LibraryRepository(db), new MorningRepository(db));
  const cues = new Cues();
  const live = new LiveSession(data.sessionsRepo, createDsp(), cues);
  // Desktop on Windows talks to the strap through Windows' own Bluetooth; one instance, since it
  // listens on the shell's IPC channels for its whole life.
  const nativeBle = desktopBridge?.ble;
  const native = nativeBle ? new NativeH10Adapter(nativeBle) : null;
  const strapAvailable = native !== null || isWebBluetoothAvailable();
  const initial: SourceKind = strapAvailable ? 'h10' : 'sim';
  const hub = new SensorHub(initial, (k) => (k === 'sim' ? new SimulatedH10Adapter() : native ?? new WebBluetoothH10Adapter()));
  live.attach(hub.current(), hub.getSnapshot().source);
  hub.onSwap((s) => live.attach(s, hub.getSnapshot().source));
  const morning = new MorningTest((r) => data.addMorning(r), cues);

  let lastProfile = data.getSnapshot().profile;
  data.subscribe(() => {
    const d = data.getSnapshot();
    cues.configure(d.settings);
    if (d.profile !== lastProfile) {
      lastProfile = d.profile;
      live.setBounds(zoneBounds(d.profile));
    }
  });
  void data.load().then(() => {
    const d = data.getSnapshot();
    live.setBounds(zoneBounds(d.profile));
    const wanted = d.settings.source === 'h10' && !strapAvailable ? 'sim' : d.settings.source;
    hub.setSource(wanted);
    desktopBridge?.ready(d.settings.autoConnect && wanted === 'h10');
  });
  // Best-effort save when the window goes away; checkpoints every 10 s cover the rest.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void live.checkpoint();
  });
  registerAutoConnect(() => {
    cues.unlock();
    void hub.connect();
  });
  return { live, morning, hub, data, cues, toast: () => {} };
}

const services = build();

if (!desktopBridge && import.meta.env.PROD && 'serviceWorker' in navigator) {
  // Installable/offline web app. The desktop shell serves files itself and skips this.
  window.addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => undefined));
}

function Root() {
  const [toastText, toast] = useToast();
  const value = useMemo(() => ({ ...services, toast }), [toast]);
  useEffect(() => desktopBridge?.onFileSaved((file) => toast(`Salvo em ${file}`)), [toast]);
  return (
    <ServicesContext.Provider value={value}>
      <App toastText={toastText} />
    </ServicesContext.Provider>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
