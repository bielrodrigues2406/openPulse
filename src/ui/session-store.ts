import type { PolarSensor, SensorEvent, SensorStatus } from '../domain/ports/polar-sensor.port';
import { RrSeries, artifactRate, rmssd } from '../domain/physiology/rr-quality';
import { SESSION_SCHEMA_VERSION, type HrPoint, type SessionRecord } from '../domain/session/recorded-session';

export const ECG_HZ = 130;
const ECG_DISPLAY_CAPACITY = ECG_HZ * 10;
const HRV_WINDOW_MS = 60_000;
const CHECKPOINT_MS = 30_000;

export type SaveState =
  | { readonly state: 'none' }
  | { readonly state: 'saved'; readonly at: number }
  | { readonly state: 'error'; readonly message: string };

export interface Readout {
  readonly status: SensorStatus;
  readonly bpm: number | null;
  readonly lastRrMs: number | null;
  readonly rmssdMs: number | null;
  readonly artifactPct: number | null;
  readonly contact: boolean | null;
  readonly elapsedS: number;
  readonly save: SaveState;
}

export type Persist = (record: SessionRecord, ecgUv: Int32Array) => Promise<void>;

/** Append-only ECG for the whole session, grown by doubling. */
class EcgRecording {
  private buf = new Int32Array(ECG_HZ * 600);
  length = 0;

  push(samples: Int32Array): void {
    if (this.length + samples.length > this.buf.length) {
      const next = new Int32Array(Math.max(this.buf.length * 2, this.length + samples.length));
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
    }
    this.buf.set(samples, this.length);
    this.length += samples.length;
  }

  view(): Int32Array {
    return this.buf.subarray(0, this.length);
  }
}

interface Recording {
  readonly id: string;
  readonly startedAtIso: string;
  readonly startedPerf: number;
  readonly deviceName: string;
  readonly ecg: EcgRecording;
}

/**
 * Owns the live session. High-rate data (ECG) lives in typed buffers read by canvases
 * on each animation frame; React only subscribes to the ~1 Hz readout.
 * While streaming, the session is checkpointed every 30 s and once more on disconnect,
 * so a closed tab loses at most 30 s.
 */
export class SessionStore {
  readonly ecg = new Float32Array(ECG_DISPLAY_CAPACITY);
  ecgWritten = 0; // total samples ever written; display index = ecgWritten % capacity
  readonly hr: HrPoint[] = [];
  rr = new RrSeries();

  private recording: Recording | null = null;
  private source: SessionRecord['source'] = 'sim';
  private checkpoint: ReturnType<typeof setInterval> | null = null;
  private readout: Readout = emptyReadout({ state: 'idle' });
  private readonly listeners = new Set<() => void>();
  private detach: (() => void) | null = null;

  constructor(private readonly persist: Persist) {}

  attach(sensor: PolarSensor, source: SessionRecord['source']): void {
    this.detach?.();
    this.source = source;
    const offEvent = sensor.onEvent(this.handleEvent);
    const offStatus = sensor.onStatus((status) => {
      if (status.state === 'streaming') this.begin(status.deviceName);
      else this.end();
      this.update({ status });
    });
    this.detach = () => {
      offEvent();
      offStatus();
      this.end();
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getReadout = (): Readout => this.readout;

  private begin(deviceName: string): void {
    this.ecg.fill(0);
    this.ecgWritten = 0;
    this.hr.length = 0;
    this.rr = new RrSeries();
    this.recording = {
      id: crypto.randomUUID(),
      startedAtIso: new Date().toISOString(),
      startedPerf: performance.now(),
      deviceName,
      ecg: new EcgRecording(),
    };
    this.readout = emptyReadout(this.readout.status);
    this.checkpoint = setInterval(() => void this.save(), CHECKPOINT_MS);
  }

  private end(): void {
    if (this.checkpoint) clearInterval(this.checkpoint);
    this.checkpoint = null;
    if (this.recording) void this.save();
    this.recording = null;
  }

  private async save(): Promise<void> {
    const rec = this.recording;
    if (!rec || this.rr.all().length === 0) return; // nothing worth keeping yet
    const ecg = rec.ecg.view();
    const record: SessionRecord = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id: rec.id,
      startedAtIso: rec.startedAtIso,
      durationS: (performance.now() - rec.startedPerf) / 1000,
      source: this.source,
      deviceName: rec.deviceName,
      ecgHz: ECG_HZ,
      ecgSampleCount: ecg.length,
      hr: [...this.hr],
      rr: [...this.rr.all()],
    };
    try {
      await this.persist(record, ecg);
      this.update({ save: { state: 'saved', at: Date.now() } });
    } catch (err) {
      this.update({ save: { state: 'error', message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private readonly handleEvent = (e: SensorEvent): void => {
    switch (e.kind) {
      case 'ecg':
        this.recording?.ecg.push(e.samplesUv);
        for (const s of e.samplesUv) this.ecg[this.ecgWritten++ % ECG_DISPLAY_CAPACITY] = s;
        return;
      case 'acc':
        return; // stored once respiration/cadence lands; streamed now to validate the link
      case 'hr': {
        let last: number | null = this.readout.lastRrMs;
        for (const rr of e.rrMs) last = this.rr.push(rr).rrMs;
        const elapsedS = this.recording ? (e.receivedAt - this.recording.startedPerf) / 1000 : 0;
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
  return { status, bpm: null, lastRrMs: null, rmssdMs: null, artifactPct: null, contact: null, elapsedS: 0, save: { state: 'none' } };
}
