import { parseHeartRateMeasurement } from '../domain/physiology/ble-hr-parser';
import { PMD_START_ACC, PMD_START_ECG, PMD_STOP_ACC, PMD_STOP_ECG, parsePmdFrame } from '../domain/physiology/pmd-stream-parser';
import { PMD_ALREADY_IN_STATE, PMD_SUCCESS, parsePmdControlResponse, pmdErrorText, type PmdControlResponse } from '../domain/physiology/pmd-control';
import { SensorBase } from './listeners';

const HR_SERVICE = 0x180d;
const HR_MEASUREMENT = 0x2a37;
const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
const PMD_CONTROL = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
const PMD_DATA = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && navigator.bluetooth !== undefined;
}

export class WebBluetoothH10Adapter extends SensorBase {
  readonly label = 'Polar H10';
  private device: BluetoothDevice | null = null;
  private connecting = false;
  private server: BluetoothRemoteGATTServer | null = null;
  private pmd: 'off' | 'starting' | 'on' = 'off';
  private pmdRetries = 0;
  private pmdLastTry = 0;
  private pmdControl: BluetoothRemoteGATTCharacteristic | null = null;
  private pendingResponse: ((r: PmdControlResponse) => void) | null = null;

  async connect(): Promise<void> {
    const bluetooth = navigator.bluetooth;
    if (!bluetooth) {
      this.setStatus({ state: 'error', message: 'Web Bluetooth indisponível. Use Chrome ou Edge no desktop/Android.' });
      return;
    }
    if (this.connecting) return; // a second click must not start a parallel GATT connect
    this.connecting = true;
    this.setStatus({ state: 'connecting' });
    try {
      const device = await bluetooth.requestDevice({
        filters: [{ namePrefix: 'Polar H10' }],
        optionalServices: [HR_SERVICE, PMD_SERVICE],
      });
      this.device = device;
      device.removeEventListener('gattserverdisconnected', this.handleDisconnect);
      device.addEventListener('gattserverdisconnected', this.handleDisconnect);
      // On Windows the link often drops during service discovery right after connect
      // ("GATT Server is disconnected"); the whole connect + subscribe step is retried.
      const server = await retryOnNetworkError(async () => {
        const srv = await connectGatt(device);
        const hrChar = await (await srv.getPrimaryService(HR_SERVICE)).getCharacteristic(HR_MEASUREMENT);
        hrChar.removeEventListener('characteristicvaluechanged', this.handleHr);
        hrChar.addEventListener('characteristicvaluechanged', this.handleHr);
        await hrChar.startNotifications();
        return srv;
      });

      this.server = server;
      this.deviceName = device.name ?? 'Polar H10';
      // HR + R-R alone are enough to train with; a PMD failure downgrades instead of aborting
      // and is retried once the strap reports skin contact.
      this.pmd = 'off';
      this.pmdRetries = 0;
      await this.tryStartPmd();
    } catch (err) {
      this.device?.gatt?.disconnect();
      this.device = null;
      // User closing the chooser is not an error worth shouting about.
      if (err instanceof DOMException && err.name === 'NotFoundError') this.setStatus({ state: 'idle' });
      else this.setStatus({ state: 'error', message: describeBleError(err) });
    } finally {
      this.connecting = false;
    }
  }

  private deviceName = 'Polar H10';

  private async tryStartPmd(): Promise<void> {
    if (!this.server || this.pmd !== 'off') return;
    this.pmd = 'starting';
    this.pmdLastTry = performance.now();
    try {
      await this.startPmd(this.server);
      this.pmd = 'on';
      this.setStatus({ state: 'streaming', deviceName: this.deviceName });
    } catch (err) {
      this.pmd = 'off';
      const reason = err instanceof Error ? err.message : String(err);
      console.warn('PMD (ECG/ACC) failed:', err);
      this.setStatus({ state: 'streaming', deviceName: `${this.deviceName} · sem ECG (${reason})` });
    }
  }

  private async startPmd(server: BluetoothRemoteGATTServer): Promise<void> {
    const pmd = await server.getPrimaryService(PMD_SERVICE);
    const control = await pmd.getCharacteristic(PMD_CONTROL);
    const data = await pmd.getCharacteristic(PMD_DATA);
    if (this.pmdControl !== control) {
      control.addEventListener('characteristicvaluechanged', this.handleControl);
      data.addEventListener('characteristicvaluechanged', this.handlePmd);
      // Control-point responses arrive as indications; they must be enabled before writing.
      await control.startNotifications();
      await data.startNotifications();
      this.pmdControl = control;
    }
    await this.command(control, PMD_START_ECG, 'ECG');
    // ACC is optional for now; ECG alone is worth keeping.
    await this.command(control, PMD_START_ACC, 'ACC').catch((err: unknown) => console.warn('ACC not started:', err));
  }

  /** Writes a command and waits for its indication; "already running" counts as success. */
  private async command(control: BluetoothRemoteGATTCharacteristic, cmd: Uint8Array, label: string): Promise<void> {
    const response = new Promise<PmdControlResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponse = null;
        reject(new Error(`${label}: cinta não respondeu`));
      }, 3000);
      this.pendingResponse = (r) => {
        clearTimeout(timer);
        this.pendingResponse = null;
        resolve(r);
      };
    });
    await control.writeValueWithResponse(cmd);
    const r = await response;
    if (r.errorCode !== PMD_SUCCESS && r.errorCode !== PMD_ALREADY_IN_STATE) {
      throw new Error(`${label}: ${pmdErrorText(r.errorCode)}`);
    }
  }

  private readonly handleControl = (e: Event): void => {
    const view = (e.target as BluetoothRemoteGATTCharacteristic).value;
    if (!view) return;
    const r = parsePmdControlResponse(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    if (r) this.pendingResponse?.(r);
  };

  disconnect(): void {
    const control = this.pmdControl;
    if (control && this.device?.gatt?.connected) {
      // Stop streams so the next session does not find them running; best effort.
      void control.writeValueWithResponse(PMD_STOP_ECG)
        .then(() => control.writeValueWithResponse(PMD_STOP_ACC))
        .catch(() => undefined)
        .finally(() => this.device?.gatt?.disconnect());
      return;
    }
    this.device?.gatt?.disconnect();
  }

  private readonly handleDisconnect = (): void => {
    if (this.connecting) return; // a failed attempt inside connectGatt; the retry loop owns state
    this.device = null;
    this.server = null;
    this.pmdControl = null;
    this.pmd = 'off';
    this.setStatus({ state: 'idle' });
  };

  private readonly handleHr = (e: Event): void => {
    const view = (e.target as BluetoothRemoteGATTCharacteristic).value;
    if (!view) return;
    const m = parseHeartRateMeasurement(view);
    // ECG refuses to start without skin contact; retry once contact appears, at most every 10 s.
    if (this.pmd === 'off' && m.contact !== false && this.pmdRetries < 5 && performance.now() - this.pmdLastTry > 10_000) {
      this.pmdRetries++;
      void this.tryStartPmd();
    }
    this.emit({ kind: 'hr', bpm: m.bpm, rrMs: m.rrMs, contact: m.contact, receivedAt: performance.now() });
  };

  private readonly handlePmd = (e: Event): void => {
    const view = (e.target as BluetoothRemoteGATTCharacteristic).value;
    if (!view) return;
    try {
      const frame = parsePmdFrame(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      const receivedAt = performance.now();
      if (frame.kind === 'ecg') this.emit({ kind: 'ecg', samplesUv: frame.samplesUv, receivedAt });
      else this.emit({ kind: 'acc', samplesMg: frame.samplesMg, receivedAt });
    } catch (err) {
      // One malformed frame must not kill the session; surface it for debugging only.
      console.warn('PMD frame dropped:', err);
    }
  };
}

const CONNECT_ATTEMPTS = 3;
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Chrome rejects gatt.connect() with "Connection already in progress" when a previous attempt
 * on the same device is still pending (e.g. a stalled earlier try, or the strap waking up).
 * Each attempt is bounded; between attempts the pending one is cancelled with disconnect().
 */
export async function connectGatt(
  device: BluetoothDevice,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<BluetoothRemoteGATTServer> {
  const gatt = device.gatt;
  if (!gatt) throw new Error('Dispositivo sem servidor GATT');
  if (gatt.connected) return gatt;
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    try {
      return await withTimeout(gatt.connect(), CONNECT_TIMEOUT_MS, wait);
    } catch (err) {
      lastError = err;
      gatt.disconnect();
      if (attempt < CONNECT_ATTEMPTS) await wait(600 * attempt);
    }
  }
  throw lastError;
}

async function withTimeout<T>(p: Promise<T>, ms: number, wait: (ms: number) => Promise<void>): Promise<T> {
  return Promise.race([
    p,
    wait(ms).then((): never => {
      throw new DOMException('Tempo esgotado ao conectar', 'TimeoutError');
    }),
  ]);
}

/** Human message for the status line; raw text stays in the console. */
export function describeBleError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  if (/already in progress/i.test(msg)) {
    return 'A cinta ainda está presa numa conexão anterior. Tire e recoloque a cinta (ou feche o app Polar no celular) e tente de novo.';
  }
  if (name === 'TimeoutError' || /timed? ?out/i.test(msg)) {
    return 'A cinta não respondeu. Umedeça os eletrodos, encaixe o sensor e tente de novo.';
  }
  if (name === 'NetworkError') {
    return 'Conexão Bluetooth caiu. Se a cinta aparece como "Conectado" nas configurações de Bluetooth do sistema, remova o pareamento lá e tente de novo.';
  }
  if (name === 'SecurityError') return 'O navegador bloqueou o Bluetooth. Abra pelo endereço localhost ou https.';
  return msg;
}

/** Retries a GATT setup step when the link drops mid-way (NetworkError), up to 3 times. */
export async function retryOnNetworkError<T>(
  step: () => Promise<T>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (err) {
      const network = err instanceof DOMException && err.name === 'NetworkError';
      if (!network || attempt >= 3) throw err;
      await wait(800 * attempt);
    }
  }
}
