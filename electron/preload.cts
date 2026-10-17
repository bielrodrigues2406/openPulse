import { contextBridge, ipcRenderer } from 'electron';

// The only surface the web app sees from the desktop shell (window.openPulseDesktop).
contextBridge.exposeInMainWorld('openPulseDesktop', {
  ready: (autoConnect: boolean) => ipcRenderer.send('ui-ready', autoConnect),
  onFileSaved: (cb: (path: string) => void) => {
    ipcRenderer.on('file-saved', (_e, p: string) => cb(p));
  },
  showFile: (p: string) => ipcRenderer.send('show-file', p),
  forgetDevice: () => ipcRenderer.send('forget-device'),
});
