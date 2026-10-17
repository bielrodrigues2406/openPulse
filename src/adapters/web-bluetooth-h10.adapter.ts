import { parseHeartRateMeasurement } from '../domain/physiology/ble-hr-parser';
import { PMD_START_ACC, PMD_START_ECG, PMD_STOP_ACC, PMD_STOP_ECG, parsePmdFrame } from '../domain/physiology/pmd-stream-parser';
import { PMD_ALREADY_IN_STATE, PMD_SUCCESS, parsePmdControlResponse, pmdErrorText, type PmdControlResponse } from '../domain/physiology/pmd-control';
import type { DiagnosticsSource } from '../domain/ports/polar-sensor.port';
import { SensorBase } from './listeners';

const HR_SERVICE = 0x180d;
const BATTERY_SERVICE = 0x180f;
const BATTERY_LEVEL = 0x2a19;
const HR_MEASUREMENT = 0x2a37;
const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
const PMD_CONTROL = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
const PMD_DATA = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && navigator.bluetooth !== undefined;
}

/** Window after a PMD request in which a link drop is blamed on PMD. */
const PMD_BLAME_MS = 2000;
const MAX_AUTO_RECONNECTS = 3;
/**
 * Pauses before each reconnect attempt after a drop. Windows often needs several seconds before
 * the strap is connectable again; giving up after a few quick tries lost whole workouts.
 */
const RECONNECT_DELAYS_MS = [0, 2000, 4000, 8000, 15_000, 15_000, 15_000];

/**
 * Connection strategy, driven by field logs from Windows:
 * 1. Connect and subscribe to HR only. HR + R-R are the core of the app.
 * 2. Start ECG/ACC only after the first HR packet, so a PMD problem can never block HR.
 * 3. If the link drops right after a PMD request, PMD is disabled for this session and the
 *    adapter reconnects HR-only on its own. Other unexpected drops also auto-reconnect.
 */
export class WebBluetoothH10Adapter extends SensorBase implements DiagnosticsSource {
  readonly label = 'Polar H10';
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private deviceName = 'Polar H10';
  /** True while connect() or an auto-reconnect owns the link; disconnect events are deferred. */
  private connecting = false;
  private linkLostWhileConnecting = false;
  private userDisconnect = false;
  private reconnectsInARow = 0;
  private gotHr = false;

  private pmd: 'off' | 'starting' | 'on' = 'off';
  private pmdBreaksLink = false;
  private pmdRequestedAt = -Infinity;
  private pmdRetries = 0;
  private pmdControl: BluetoothRemoteGATTCharacteristic | null = null;
  private pendingResponse: ((r: PmdControlResponse) => void) | null = null;

  private readonly log: string[] = [];
  private logStart = 0;

  constructor(private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    super();
  }

  diagnostics(): readonly string[] {
    return [navigator.userAgent, ...this.log];
  }

  private step(text: string): void {
    const line = `+${Math.round(performance.now() - this.logStart)} ms  ${text}`;
    this.log.push(line);
    if (this.log.length > 300) this.log.shift();
    console.info('[openPulse BLE]', line);
  }

  async connect(): Promise<void> {
    const bluetooth = navigator.bluetooth;
    if (!bluetooth) {
      this.setStatus({ state: 'error', message: 'Web Bluetooth indisponível. Use Chrome ou Edge no desktop/Android.' });
      return;
    }
    if (this.connecting) return; // a second click must not start a parallel GATT connect
    this.connecting = true;
    this.userDisconnect = false;
    this.pmdBreaksLink = false;
    this.pmdRetries = 0;
    this.pmdRequestedAt = -Infinity;
    this.reconnectsInARow = 0;
    this.log.length = 0;
    this.logStart = performance.now();
    this.step('requestDevice');
    this.setStatus({ state: 'connecting' });
    try {
      const device = await bluetooth.requestDevice({
        filters: [{ namePrefix: 'Polar H10' }],
        optionalServices: [HR_SERVICE, PMD_SERVICE, BATTERY_SERVICE],
      });
      this.step(`escolhido: ${device.name ?? '?'}`);
      this.device = device;
      this.deviceName = device.name ?? 'Polar H10';
      device.removeEventListener('gattserverdisconnected', this.handleDisconnect);
      device.addEventListener('gattserverdisconnected', this.handleDisconnect);
      await this.openHrLink(device);
      this.step('pronto (FC); ECG começa após o primeiro batimento');
      void this.readBattery();
      this.setStatus({ state: 'streaming', deviceName: this.statusName() });
    } catch (err) {
      this.step(`falhou: ${errText(err)}`);
      this.device?.gatt?.disconnect();
      this.device = null;
      // User closing the chooser is not an error worth shouting about; other NotFoundErrors are.
      if (err instanceof DOMException && err.name === 'NotFoundError' && /cancel/i.test(err.message)) this.setStatus({ state: 'idle' });
      else this.setStatus({ state: 'error', message: describeBleError(err) });
    } finally {
      this.connecting = false;
    }
  }

  /** Connects and subscribes to HR. On Windows the link often drops during discovery; retried. */
  private async openHrLink(device: BluetoothDevice): Promise<void> {
    this.gotHr = false;
    this.server = await retryOnNetworkError(async () => {
      this.linkLostWhileConnecting = false;
      this.step('gatt.connect');
      const srv = await connectGatt(device, this.wait, (m) => this.step(m));
      this.step('conectado; serviço FC');
      const hrChar = await (await srv.getPrimaryService(HR_SERVICE)).getCharacteristic(HR_MEASUREMENT);
      this.step('notificações FC');
      hrChar.removeEventListener('characteristicvaluechanged', this.handleHr);
      hrChar.addEventListener('characteristicvaluechanged', this.handleHr);
      await hrChar.startNotifications();
      if (this.linkLostWhileConnecting || !srv.connected) {
        throw new DOMException('Link caiu durante a assinatura da FC', 'NetworkError');
      }
      this.step('FC assinada');
      return srv;
    }, this.wait);
    this.pmd = 'off';
    this.pmdControl = null; // characteristics from a previous link need fresh subscriptions
  }

  /** Optional and best effort: some stacks refuse it; the session does not depend on it. */
  private async readBattery(): Promise<void> {
    try {
      const ch = await (await this.server!.getPrimaryService(BATTERY_SERVICE)).getCharacteristic(BATTERY_LEVEL);
      const v = await ch.readValue();
      this.emit({ kind: 'battery', percent: v.getUint8(0) });
      this.step(`bateria ${v.getUint8(0)}%`);
    } catch (err) {
      this.step(`bateria indisponível: ${errText(err)}`);
    }
  }

  private statusName(): string {
    if (this.pmdBreaksLink) return `${this.deviceName} · só FC (ECG derruba a conexão neste PC)`;
    return this.deviceName;
  }

  private async tryStartPmd(): Promise<void> {
    if (!this.server || this.pmd !== 'off' || this.pmdBreaksLink) return;
    this.pmd = 'starting';
    this.pmdRequestedAt = performance.now();
    this.step('iniciando ECG/ACC');
    try {
      await this.startPmd(this.server);
      this.pmd = 'on';
      this.step('ECG/ACC ativos');
      this.setStatus({ state: 'streaming', deviceName: this.statusName() });
    } catch (err) {
      this.pmd = 'off';
      this.step(`ECG/ACC falhou: ${errText(err)}`);
      // If the link is going down because of this request, handleDisconnect sets the status.
      if (this.server?.connected) {
        const reason = err instanceof Error ? err.message : String(err);
        this.setStatus({ state: 'streaming', deviceName: `${this.deviceName} · sem ECG (${reason})` });
      }
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
    await this.command(control, PMD_START_ACC, 'ACC').catch((err: unknown) => this.step(`ACC não iniciou: ${errText(err)}`));
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
    this.userDisconnect = true;
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
    this.step('gattserverdisconnected');
    if (this.connecting) {
      this.linkLostWhileConnecting = true; // the connect/reconnect loop decides what to do
      return;
    }
    this.server = null;
    this.pmdControl = null;
    this.pmd = 'off';
    if (this.userDisconnect || !this.device) {
      this.device = null;
      this.setStatus({ state: 'idle' });
      return;
    }
    if (performance.now() - this.pmdRequestedAt < PMD_BLAME_MS && !this.pmdBreaksLink) {
      this.pmdBreaksLink = true;
      this.step('ECG/ACC derrubou a conexão; seguindo só com FC');
    }
    void this.autoReconnect(this.device);
  };

  /** Keeps the session alive across drops: status stays 'streaming' so recording continues. */
  private async autoReconnect(device: BluetoothDevice): Promise<void> {
    if (this.reconnectsInARow >= MAX_AUTO_RECONNECTS) {
      this.step('desistindo após reconexões seguidas sem dados');
      this.device = null;
      this.setStatus({ state: 'error', message: 'A cinta caiu várias vezes seguidas. Clique em Conectar para tentar de novo.' });
      return;
    }
    this.reconnectsInARow++;
    this.connecting = true;
    this.setStatus({ state: 'streaming', deviceName: `${this.deviceName} · reconectando…` });
    let lastError: unknown = null;
    try {
      for (const [i, delay] of RECONNECT_DELAYS_MS.entries()) {
        if (delay) await this.wait(delay);
        if (this.userDisconnect) return;
        try {
          await this.openHrLink(device);
          this.step(`reconectado (${this.reconnectsInARow}, tentativa ${i + 1})`);
          this.setStatus({ state: 'streaming', deviceName: this.statusName() });
          return;
        } catch (err) {
          lastError = err;
          this.step(`reconexão ${i + 1}/${RECONNECT_DELAYS_MS.length} falhou: ${errText(err)}`);
          device.gatt?.disconnect();
        }
      }
      this.device = null;
      this.setStatus({ state: 'error', message: describeBleError(lastError) });
    } finally {
      this.connecting = false;
      if (this.userDisconnect && this.device) {
        this.device = null;
        this.setStatus({ state: 'idle' });
      }
    }
  }

  private readonly handleHr = (e: Event): void => {
    const view = (e.target as BluetoothRemoteGATTCharacteristic).value;
    if (!view) return;
    const m = parseHeartRateMeasurement(view);
    if (!this.gotHr) {
      this.gotHr = true;
      this.reconnectsInARow = 0;
      this.step(`primeiro pacote FC: ${m.bpm} bpm, ${m.rrMs.length} R-R, contato=${m.contact}`);
    }
    // ECG needs skin contact; try after the first HR packet, then at most every 10 s, 5 times.
    if (this.pmd === 'off' && !this.pmdBreaksLink && m.contact !== false && this.pmdRetries < 5
      && performance.now() - this.pmdRequestedAt > 10_000) {
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

function errText(err: unknown): string {
  return `${err instanceof DOMException ? err.name + ': ' : ''}${err instanceof Error ? err.message : String(err)}`;
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
  log: (msg: string) => void = () => undefined,
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
      log(`tentativa ${attempt} falhou: ${err instanceof Error ? err.message : String(err)}`);
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
