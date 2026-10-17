import { parseHeartRateMeasurement } from '../domain/physiology/ble-hr-parser';
import { PMD_START_ACC, PMD_START_ECG, PMD_STOP_ACC, PMD_STOP_ECG, parsePmdFrame } from '../domain/physiology/pmd-stream-parser';
import { PMD_ALREADY_IN_STATE, PMD_SUCCESS, parsePmdControlResponse, pmdErrorText, type PmdControlResponse } from '../domain/physiology/pmd-control';
import type { DiagnosticsSource, RepairableSensor } from '../domain/ports/polar-sensor.port';
import { SensorBase } from './listeners';

export type NativeCharKey = 'hr' | 'battery' | 'pmdControl' | 'pmdData';

/** The desktop shell's native Windows Bluetooth (electron/native-ble.cts), seen through IPC. */
export interface NativeBleTransport {
  open(): Promise<{ name: string; address: string }>;
  subscribe(key: NativeCharKey): Promise<void>;
  write(key: NativeCharKey, bytes: Uint8Array): Promise<void>;
  read(key: NativeCharKey): Promise<Uint8Array>;
  /** Pairs in code; resolves at once when already paired. */
  pair(): Promise<void>;
  /** Removes Windows' pairing record, reconnects and pairs again. */
  repair(): Promise<{ name: string; address: string }>;
  close(): Promise<void>;
  onData(cb: (key: NativeCharKey, bytes: Uint8Array) => void): () => void;
  onDisconnected(cb: (reason: string) => void): () => void;
  onLog(cb: (line: string) => void): () => void;
}

/** Thrown when the strap answers a PMD command with an error code (not a link problem). */
class PmdRefused extends Error {}

const PMD_BLAME_MS = 2000;
const MAX_DROPS_WITHOUT_DATA = 3;
const RECONNECT_DELAYS_MS = [0, 2000, 4000, 8000, 15_000, 15_000, 15_000];

/**
 * Polar H10 over Windows' own Bluetooth stack. Same order as the Web Bluetooth adapter (HR
 * first, ECG/ACC only after the first beat), plus what that path cannot do:
 * - opens a strap Windows is already connected to (no scan needed);
 * - pairs on its own when ECG needs it;
 * - when the pairing is stale (ECG refused, or the link dies right after connecting), removes
 *   it and pairs again once per connection, without the user touching Windows settings.
 */
export class NativeH10Adapter extends SensorBase implements DiagnosticsSource, RepairableSensor {
  readonly label = 'Polar H10';
  private deviceName = 'Polar H10';
  private linked = false;
  private connecting = false;
  private userDisconnect = false;
  private gotHr = false;
  private dropsWithoutData = 0;
  private repaired = false;
  private repairing = false;

  private pmd: 'off' | 'starting' | 'on' = 'off';
  private pmdDisabled: string | null = null;
  private pmdRequestedAt = -Infinity;
  private pmdRetries = 0;
  private pendingResponse: ((r: PmdControlResponse) => void) | null = null;

  private readonly log: string[] = [];
  private logStart = 0;

  constructor(
    private readonly t: NativeBleTransport,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    super();
    t.onData(this.handleData);
    t.onDisconnected(this.handleDisconnect);
    t.onLog((line) => {
      this.step(line);
      // "[etapa] …" lines are progress worth showing while the first connection is being made.
      if (line.startsWith('[etapa] ') && this.connecting && !this.linked && !this.repairing) {
        this.setStatus({ state: 'connecting', detail: capitalize(line.slice(8)) });
      }
    });
  }

  diagnostics(): readonly string[] {
    return [`${navigator.userAgent} · Bluetooth nativo do Windows`, ...this.log];
  }

  private step(text: string): void {
    const line = `+${Math.round(performance.now() - this.logStart)} ms  ${text}`;
    this.log.push(line);
    if (this.log.length > 300) this.log.shift();
    console.info('[openPulse BLE]', line);
  }

  async connect(): Promise<void> {
    if (this.connecting || this.linked) return;
    this.connecting = true;
    this.userDisconnect = false;
    this.repaired = false;
    this.pmdDisabled = null;
    this.pmdRetries = 0;
    this.pmdRequestedAt = -Infinity;
    this.dropsWithoutData = 0;
    this.log.length = 0;
    this.logStart = performance.now();
    this.step('abrindo pelo Bluetooth do Windows');
    this.setStatus({ state: 'connecting' });
    try {
      await this.link(() => this.t.open());
      this.setStatus({ state: 'streaming', deviceName: this.statusName() });
      void this.readBattery();
    } catch (err) {
      this.step(`falhou: ${errText(err)}`);
      if (this.userDisconnect) this.setStatus({ state: 'idle' }); // cancelled
      else this.setStatus({ state: 'error', message: describeNativeError(err) });
    } finally {
      this.connecting = false;
    }
  }

  /** Opens (or re-opens) the link and subscribes to HR. */
  private async link(open: () => Promise<{ name: string }>): Promise<void> {
    this.linked = false;
    this.gotHr = false;
    this.pmd = 'off';
    const info = await open();
    this.deviceName = info.name || 'Polar H10';
    await this.t.subscribe('hr');
    this.linked = true;
    this.step(`FC assinada (${this.deviceName})`);
  }

  private async readBattery(): Promise<void> {
    try {
      const v = await this.t.read('battery');
      const percent = v[0];
      if (percent !== undefined) {
        this.emit({ kind: 'battery', percent });
        this.step(`bateria ${percent}%`);
      }
    } catch (err) {
      this.step(`bateria indisponível: ${errText(err)}`);
    }
  }

  private statusName(): string {
    return this.pmdDisabled ? `${this.deviceName} · sem ECG (${this.pmdDisabled})` : this.deviceName;
  }

  disconnect(): void {
    this.userDisconnect = true;
    const stop = this.pmd === 'on'
      ? this.t.write('pmdControl', PMD_STOP_ECG).then(() => this.t.write('pmdControl', PMD_STOP_ACC)).catch(() => undefined)
      : Promise.resolve();
    this.pmd = 'off';
    this.linked = false;
    void stop.finally(() => this.t.close().catch(() => undefined));
    this.setStatus({ state: 'idle' });
  }

  /** User-initiated: drop the pairing, pair again, carry on. */
  async repairPairing(): Promise<void> {
    if (this.connecting) return;
    if (!this.linked) {
      this.log.length = 0;
      this.logStart = performance.now();
    }
    this.userDisconnect = false;
    await this.repair('pedido pelo usuário');
  }

  private async repair(reason: string): Promise<boolean> {
    this.repaired = true;
    this.repairing = true;
    this.connecting = true;
    this.pmdDisabled = null;
    this.pmdRetries = 0;
    this.pmdRequestedAt = -Infinity; // ECG is retried on the first beat after the new pairing
    this.step(`refazendo o pareamento (${reason})`);
    this.setStatus({ state: 'streaming', deviceName: `${this.deviceName} · refazendo pareamento…` });
    try {
      await this.link(() => this.t.repair());
      this.step('pareamento refeito');
      this.setStatus({ state: 'streaming', deviceName: this.statusName() });
      return true;
    } catch (err) {
      this.step(`pareamento não refeito: ${errText(err)}`);
      if (this.userDisconnect) this.setStatus({ state: 'idle' });
      else this.setStatus({ state: 'error', message: `Não deu para refazer o pareamento: ${describeNativeError(err)}` });
      return false;
    } finally {
      this.connecting = false;
      this.repairing = false;
    }
  }

  private async startPmd(): Promise<void> {
    if (this.pmd !== 'off' || this.pmdDisabled || this.connecting) return;
    this.pmd = 'starting';
    this.pmdRequestedAt = performance.now();
    this.step('iniciando ECG/ACC (pareando se preciso)');
    try {
      await this.t.pair();
      await this.t.subscribe('pmdControl');
      await this.t.subscribe('pmdData');
      await this.command(PMD_START_ECG, 'ECG');
      await this.command(PMD_START_ACC, 'ACC').catch((err: unknown) => this.step(`ACC não iniciou: ${errText(err)}`));
      this.pmd = 'on';
      this.step('ECG/ACC ativos');
      this.setStatus({ state: 'streaming', deviceName: this.statusName() });
    } catch (err) {
      this.pmd = 'off';
      this.step(`ECG/ACC falhou: ${errText(err)}`);
      if (!this.linked) return; // the link is going down; handleDisconnect decides
      if (err instanceof PmdRefused) {
        // The strap answered: usually no skin contact yet. Retried on later beats.
        this.setStatus({ state: 'streaming', deviceName: `${this.deviceName} · sem ECG (${err.message})` });
        return;
      }
      // A healthy pairing never refuses ECG at the link level: the stored keys are stale.
      if (!this.repaired) {
        await this.repair('ECG recusado pelo Windows');
        return;
      }
      this.pmdDisabled = cleanMessage(err);
      this.setStatus({ state: 'streaming', deviceName: this.statusName() });
    }
  }

  private async command(cmd: Uint8Array, label: string): Promise<void> {
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
    await this.t.write('pmdControl', cmd);
    const r = await response;
    if (r.errorCode !== PMD_SUCCESS && r.errorCode !== PMD_ALREADY_IN_STATE) {
      throw new PmdRefused(`${label}: ${pmdErrorText(r.errorCode)}`);
    }
  }

  private readonly handleData = (key: NativeCharKey, bytes: Uint8Array): void => {
    if (key === 'hr') this.onHr(bytes);
    else if (key === 'pmdControl') {
      const r = parsePmdControlResponse(bytes);
      if (r) this.pendingResponse?.(r);
    } else if (key === 'pmdData') {
      try {
        const frame = parsePmdFrame(bytes);
        const receivedAt = performance.now();
        if (frame.kind === 'ecg') this.emit({ kind: 'ecg', samplesUv: frame.samplesUv, receivedAt });
        else this.emit({ kind: 'acc', samplesMg: frame.samplesMg, receivedAt });
      } catch (err) {
        console.warn('PMD frame dropped:', err);
      }
    }
  };

  private onHr(bytes: Uint8Array): void {
    let m;
    try {
      m = parseHeartRateMeasurement(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    } catch (err) {
      console.warn('HR packet dropped:', err);
      return;
    }
    if (!this.gotHr) {
      this.gotHr = true;
      this.dropsWithoutData = 0;
      this.step(`primeiro pacote FC: ${m.bpm} bpm, ${m.rrMs.length} R-R, contato=${m.contact}`);
    }
    if (this.pmd === 'off' && !this.pmdDisabled && m.contact !== false && this.pmdRetries < 5
      && performance.now() - this.pmdRequestedAt > 10_000) {
      this.pmdRetries++;
      void this.startPmd();
    }
    this.emit({ kind: 'hr', bpm: m.bpm, rrMs: m.rrMs, contact: m.contact, receivedAt: performance.now() });
  }

  private readonly handleDisconnect = (reason: string): void => {
    this.step(`link caiu: ${reason}`);
    const wasLinked = this.linked;
    this.linked = false;
    this.pmd = 'off';
    if (this.connecting || this.userDisconnect || !wasLinked) return;
    if (!this.gotHr) this.dropsWithoutData++;
    const pmdBlamed = performance.now() - this.pmdRequestedAt < PMD_BLAME_MS;
    // Both signatures of a stale pairing: ECG kills the link, or the link dies before any data.
    if (!this.repaired && (pmdBlamed || this.dropsWithoutData >= 2)) {
      void this.repair(pmdBlamed ? 'link caiu ao iniciar o ECG' : 'link cai logo após conectar');
      return;
    }
    if (pmdBlamed) this.pmdDisabled = 'derruba a conexão neste PC';
    void this.autoReconnect();
  };

  /** Keeps the session alive across drops: status stays 'streaming' so recording continues. */
  private async autoReconnect(): Promise<void> {
    if (this.dropsWithoutData >= MAX_DROPS_WITHOUT_DATA) {
      this.step('desistindo após quedas seguidas sem dados');
      this.setStatus({ state: 'error', message: 'A cinta caiu várias vezes seguidas. Clique em Conectar para tentar de novo.' });
      return;
    }
    this.connecting = true;
    this.setStatus({ state: 'streaming', deviceName: `${this.deviceName} · reconectando…` });
    let last: unknown = null;
    try {
      for (const [i, delay] of RECONNECT_DELAYS_MS.entries()) {
        if (delay) await this.wait(delay);
        if (this.userDisconnect) return;
        try {
          await this.link(() => this.t.open());
          this.step(`reconectado (tentativa ${i + 1})`);
          this.setStatus({ state: 'streaming', deviceName: this.statusName() });
          return;
        } catch (err) {
          last = err;
          this.step(`reconexão ${i + 1}/${RECONNECT_DELAYS_MS.length} falhou: ${errText(err)}`);
        }
      }
      this.setStatus({ state: 'error', message: describeNativeError(last) });
    } finally {
      this.connecting = false;
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** ipcRenderer.invoke wraps main-process errors as "Error invoking remote method 'x': Error: msg". */
function cleanMessage(err: unknown): string {
  return errText(err).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}

export function describeNativeError(err: unknown): string {
  const msg = cleanMessage(err);
  if (/desligado|indisponível/i.test(msg)) return 'O Bluetooth do Windows está desligado. Ligue-o e tente de novo.';
  // Raw WinRT/noble text ("Disconnected unknown", "could not connect to device") is English and
  // says little; the diagnostics keep it verbatim.
  if (/disconnect/i.test(msg)) return 'A cinta desconectou durante a conexão. Confira se ela está no peito, com os eletrodos úmidos, e tente de novo.';
  if (/could not connect|unreachable/i.test(msg)) return 'A cinta não está ao alcance. Vista a cinta e tente de novo.';
  return msg || 'Falha desconhecida no Bluetooth';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1) + '…';
}
