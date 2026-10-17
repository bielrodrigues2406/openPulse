import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type CharKey = 'hr' | 'battery' | 'pmdControl' | 'pmdData';

/** Subscribes to a main-process event; returns the unsubscribe function. */
function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// Native Windows Bluetooth (see electron/native-ble.cts); absent when it could not load.
const ble = ipcRenderer.sendSync('ble:available') === true
  ? {
      open: () => ipcRenderer.invoke('ble:open'),
      subscribe: (key: CharKey) => ipcRenderer.invoke('ble:subscribe', key),
      write: (key: CharKey, bytes: Uint8Array) => ipcRenderer.invoke('ble:write', key, bytes),
      read: (key: CharKey) => ipcRenderer.invoke('ble:read', key),
      pair: () => ipcRenderer.invoke('ble:pair'),
      repair: () => ipcRenderer.invoke('ble:repair'),
      close: () => ipcRenderer.invoke('ble:close'),
      onData: (cb: (key: CharKey, bytes: Uint8Array) => void) => listen('ble:data', cb),
      onDisconnected: (cb: (reason: string) => void) => listen('ble:disconnected', cb),
      onLog: (cb: (line: string) => void) => listen('ble:log', cb),
    }
  : undefined;

// The only surface the web app sees from the desktop shell (window.openPulseDesktop).
contextBridge.exposeInMainWorld('openPulseDesktop', {
  ready: (autoConnect: boolean) => ipcRenderer.send('ui-ready', autoConnect),
  onFileSaved: (cb: (path: string) => void) => {
    ipcRenderer.on('file-saved', (_e, p: string) => cb(p));
  },
  showFile: (p: string) => ipcRenderer.send('show-file', p),
  forgetDevice: () => ipcRenderer.send('forget-device'),
  repairPairing: () => ipcRenderer.invoke('repair-pairing') as Promise<{ ok: boolean; lines: string[] }>,
  ...(ble ? { ble } : {}),
});
