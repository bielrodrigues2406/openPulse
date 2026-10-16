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

  async connect(): Promise<void> {
    const bluetooth = navigator.bluetooth;
    if (!bluetooth) {
      this.setStatus({ state: 'error', message: 'Web Bluetooth indisponível. Use Chrome ou Edge no desktop/Android.' });
      return;
    }
    this.setStatus({ state: 'connecting' });
    try {
      const device = await bluetooth.requestDevice({
        filters: [{ namePrefix: 'Polar H10' }],
        optionalServices: [HR_SERVICE, PMD_SERVICE],
      });
      this.device = device;
      device.addEventListener('gattserverdisconnected', this.handleDisconnect);
      const server = await device.gatt?.connect();
      if (!server) throw new Error('Dispositivo sem servidor GATT');

      const hrChar = await (await server.getPrimaryService(HR_SERVICE)).getCharacteristic(HR_MEASUREMENT);
      hrChar.addEventListener('characteristicvaluechanged', this.handleHr);
      await hrChar.startNotifications();

      const pmd = await server.getPrimaryService(PMD_SERVICE);
      const control = await pmd.getCharacteristic(PMD_CONTROL);
      const data = await pmd.getCharacteristic(PMD_DATA);
      // Control-point responses arrive as indications; they must be enabled before writing.
      await control.startNotifications();
      data.addEventListener('characteristicvaluechanged', this.handlePmd);
      await data.startNotifications();
      await control.writeValueWithResponse(PMD_START_ECG);
      await control.writeValueWithResponse(PMD_START_ACC);

      this.setStatus({ state: 'streaming', deviceName: device.name ?? 'Polar H10' });
    } catch (err) {
      this.device?.gatt?.disconnect();
      this.device = null;
      const message = err instanceof Error ? err.message : String(err);
      // User closing the chooser is not an error worth shouting about.
      if (err instanceof DOMException && err.name === 'NotFoundError') this.setStatus({ state: 'idle' });
      else this.setStatus({ state: 'error', message });
    }
  }

  disconnect(): void {
    this.device?.gatt?.disconnect();
  }

  private readonly handleDisconnect = (): void => {
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
