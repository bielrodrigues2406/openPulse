import type { PolarSensor, SensorEvent, SensorStatus } from '../domain/ports/polar-sensor.port';
import { RrSeries, artifactRate, rmssd, type RrBeat } from '../domain/physiology/rr-quality';

export const ECG_HZ = 130;
const ECG_CAPACITY = ECG_HZ * 10;
const HRV_WINDOW_MS = 60_000;

export interface Readout {
  readonly status: SensorStatus;
  readonly bpm: number | null;
  readonly lastRrMs: number | null;
  readonly rmssdMs: number | null;
  readonly artifactPct: number | null;
  readonly contact: boolean | null;
  readonly elapsedS: number;
}

export interface HrPoint {
  readonly tS: number;
  readonly bpm: number;
}

/**
 * Owns the live session. High-rate data (ECG) lives in typed ring buffers read by canvases
 * on each animation frame; React only subscribes to the 1 Hz readout.
 */
export class SessionStore {
  readonly ecg = new Float32Array(ECG_CAPACITY);
  ecgWritten = 0; // total samples ever written; index = ecgWritten % capacity
  readonly hr: HrPoint[] = [];
  rr = new RrSeries();

  private startedAt: number | null = null;
  private readout: Readout = emptyReadout({ state: 'idle' });
  private readonly listeners = new Set<() => void>();
  private detach: (() => void) | null = null;

  attach(sensor: PolarSensor): void {
    this.detach?.();
    const offEvent = sensor.onEvent(this.handleEvent);
    const offStatus = sensor.onStatus((status) => {
      if (status.state === 'streaming') this.resetData();
      this.update({ status });
    });
    this.detach = () => {
      offEvent();
      offStatus();
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getReadout = (): Readout => this.readout;

  rrBeats(): readonly RrBeat[] {
    return this.rr.all();
  }

  private resetData(): void {
    this.ecg.fill(0);
    this.ecgWritten = 0;
    this.hr.length = 0;
    this.rr = new RrSeries();
    this.startedAt = performance.now();
    this.readout = emptyReadout(this.readout.status);
  }

  private readonly handleEvent = (e: SensorEvent): void => {
    switch (e.kind) {
      case 'ecg':
        for (const s of e.samplesUv) this.ecg[this.ecgWritten++ % ECG_CAPACITY] = s;
        return;
      case 'acc':
        return; // stored once respiration/cadence lands; streamed now to validate the link
      case 'hr': {
        let last: number | null = this.readout.lastRrMs;
        for (const rr of e.rrMs) last = this.rr.push(rr).rrMs;
        const elapsedS = this.startedAt === null ? 0 : (e.receivedAt - this.startedAt) / 1000;
        if (e.bpm > 0) this.hr.push({ tS: elapsedS, bpm: e.bpm });
        const win = this.rr.window(HRV_WINDOW_MS);
        const rate = artifactRate(win);
        this.update({
          bpm: e.bpm > 0 ? e.bpm : null,
          lastRrMs: last,
          rmssdMs: rmssd(win),
          artifactPct: rate === null ? null : rate * 100,
          contact: e.contact,
          elapsedS,
        });
        return;
      }
    }
  };

  private update(patch: Partial<Readout>): void {
    this.readout = { ...this.readout, ...patch };
    for (const l of this.listeners) l();
  }
}

function emptyReadout(status: SensorStatus): Readout {
  return { status, bpm: null, lastRrMs: null, rmssdMs: null, artifactPct: null, contact: null, elapsedS: 0 };
}
