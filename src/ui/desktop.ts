/**
 * Bridge to the Electron shell (see electron/preload.cts). Absent in the browser/PWA,
 * so every use is optional.
 */
export interface DesktopBridge {
  /** Tells the shell the UI is ready; with autoConnect it calls the registered handler with a user gesture. */
  ready(autoConnect: boolean): void;
  onFileSaved(cb: (path: string) => void): void;
  showFile(path: string): void;
  /** Forget the remembered strap so the next connect picks again. */
  forgetDevice(): void;
  /** Windows only: removes and redoes the strap's Bluetooth pairing, then reconnects. */
  repairPairing(): Promise<{ ok: boolean; lines: string[] }>;
}

declare global {
  interface Window {
    openPulseDesktop?: DesktopBridge;
    __openPulseAutoConnect?: () => void;
  }
}

export const desktopBridge: DesktopBridge | undefined = typeof window !== 'undefined' ? window.openPulseDesktop : undefined;

/**
 * Web Bluetooth only connects inside a user gesture. The shell runs this handler through
 * executeJavaScript(…, userGesture = true), which counts as one.
 */
export function registerAutoConnect(cb: () => void): void {
  window.__openPulseAutoConnect = cb;
}
