import { parseHeartRateMeasurement } from '../domain/physiology/ble-hr-parser';
import { PMD_START_ACC, PMD_START_ECG, parsePmdFrame } from '../domain/physiology/pmd-stream-parser';
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
      const server = await connectGatt(device);

      const hrChar = await (await server.getPrimaryService(HR_SERVICE)).getCharacteristic(HR_MEASUREMENT);
      hrChar.addEventListener('characteristicvaluechanged', this.handleHr);
      await hrChar.startNotifications();

      // HR + R-R alone are enough to train with; a PMD failure downgrades instead of aborting.
      let note = '';
      try {
        await this.startPmd(server);
      } catch (err) {
        console.warn('PMD (ECG/ACC) unavailable:', err);
        note = ' · sem ECG';
      }
      this.setStatus({ state: 'streaming', deviceName: (device.name ?? 'Polar H10') + note });
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

  private async startPmd(server: BluetoothRemoteGATTServer): Promise<void> {
    const pmd = await server.getPrimaryService(PMD_SERVICE);
    const control = await pmd.getCharacteristic(PMD_CONTROL);
    const data = await pmd.getCharacteristic(PMD_DATA);
    // Control-point responses arrive as indications; they must be enabled before writing.
    await control.startNotifications();
    data.addEventListener('characteristicvaluechanged', this.handlePmd);
    await data.startNotifications();
    await control.writeValueWithResponse(PMD_START_ECG);
    await control.writeValueWithResponse(PMD_START_ACC);
  }

  disconnect(): void {
    this.device?.gatt?.disconnect();
  }

  private readonly handleDisconnect = (): void => {
    if (this.connecting) return; // a failed attempt inside connectGatt; the retry loop owns state
    this.device = null;
    this.setStatus({ state: 'idle' });
  };

  private readonly handleHr = (e: Event): void => {
    const view = (e.target as BluetoothRemoteGATTCharacteristic).value;
    if (!view) return;
    const m = parseHeartRateMeasurement(view);
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
  if (name === 'NetworkError') return 'Conexão Bluetooth perdida. Aproxime a cinta do computador e tente de novo.';
  if (name === 'SecurityError') return 'O navegador bloqueou o Bluetooth. Abra pelo endereço localhost ou https.';
  return msg;
}
