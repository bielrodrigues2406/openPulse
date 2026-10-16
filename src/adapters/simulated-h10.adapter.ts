import { SensorBase } from './listeners';

/**
 * Deterministic physiological simulator: same seed, same stream.
 * RR follows a 15 min ramp test (see RampRrModel);
 * ECG is a sum of Gaussian P/QRS/T waves placed on those beats; occasional ectopic beats
 * exercise the artifact gate.
 */

const ECG_HZ = 130;
const ECG_FRAME = 73; // samples per notification, matches real H10 frames
const ACC_HZ = 200;
const ACC_FRAME = 36;
const TICK_MS = 50;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimulatedH10Adapter extends SensorBase {
  readonly label = 'Simulador';
  private timer: ReturnType<typeof setInterval> | null = null;
  private random = mulberry32(1);
  private rrModel = new RampRrModel();
  private simMs = 0;
  private nextBeatMs = 0;
  private beatTimes: number[] = [];
  private pendingRr: number[] = [];
  private lastHrEmitMs = 0;
  private ecgIndex = 0;
  private accIndex = 0;
  private ecgBuffer: number[] = [];
  private accBuffer: number[] = [];

  constructor(private readonly seed = 1) {
    super();
  }

  async connect(): Promise<void> {
    if (this.timer) return;
    this.reset();
    this.setStatus({ state: 'streaming', deviceName: 'Simulador H10' });
    this.timer = setInterval(() => this.advance(TICK_MS), TICK_MS);
  }

  disconnect(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setStatus({ state: 'idle' });
  }

  private reset(): void {
    this.random = mulberry32(this.seed);
    this.rrModel = new RampRrModel();
    this.simMs = 0;
    this.nextBeatMs = 600;
    this.beatTimes = [];
    this.pendingRr = [];
    this.lastHrEmitMs = 0;
    this.ecgIndex = 0;
    this.accIndex = 0;
    this.ecgBuffer = [];
    this.accBuffer = [];
  }

  private rrAt(tMs: number): number {
    return this.rrModel.next(tMs, this.random);
  }

  private advance(dtMs: number): void {
    const end = this.simMs + dtMs;
    while (this.nextBeatMs <= end) {
      const rr = this.rrAt(this.nextBeatMs);
      this.beatTimes.push(this.nextBeatMs);
      this.pendingRr.push(rr);
      this.nextBeatMs += rr;
    }
    this.beatTimes = this.beatTimes.filter((b) => b > end - 3000);

    while ((this.ecgIndex * 1000) / ECG_HZ < end) {
      this.ecgBuffer.push(this.ecgSample((this.ecgIndex * 1000) / ECG_HZ));
      this.ecgIndex++;
    }
    while ((this.accIndex * 1000) / ACC_HZ < end) {
      const t = this.accIndex / ACC_HZ;
      const breath = Math.sin(2 * Math.PI * 0.25 * t);
      const pedal = Math.sin(2 * Math.PI * 1.5 * t);
      this.accBuffer.push(
        Math.round(-20 + 25 * pedal + (this.random() - 0.5) * 8),
        Math.round(-980 + 15 * pedal + (this.random() - 0.5) * 8),
        Math.round(60 + 30 * breath + (this.random() - 0.5) * 8),
      );
      this.accIndex++;
    }
    this.simMs = end;

    const now = performance.now();
    while (this.ecgBuffer.length >= ECG_FRAME) {
      this.emit({ kind: 'ecg', samplesUv: Int32Array.from(this.ecgBuffer.splice(0, ECG_FRAME)), receivedAt: now });
    }
    while (this.accBuffer.length >= ACC_FRAME * 3) {
      this.emit({ kind: 'acc', samplesMg: Int16Array.from(this.accBuffer.splice(0, ACC_FRAME * 3)), receivedAt: now });
    }
    if (end - this.lastHrEmitMs >= 1000) {
      this.lastHrEmitMs = end;
      const rr = this.pendingRr.splice(0);
      const mean = rr.length ? rr.reduce((a, b) => a + b, 0) / rr.length : 800;
      this.emit({ kind: 'hr', bpm: Math.round(60000 / mean), rrMs: rr, contact: true, receivedAt: now });
    }
  }

  private ecgSample(tMs: number): number {
    let v = 0;
    for (const beat of this.beatTimes) {
      const d = (tMs - beat) / 1000;
      v += 120 * gauss(d, -0.16, 0.025) - 90 * gauss(d, -0.035, 0.01) + 1100 * gauss(d, 0, 0.011)
        - 220 * gauss(d, 0.03, 0.012) + 260 * gauss(d, 0.25, 0.045);
    }
    return Math.round(v + 25 * Math.sin((2 * Math.PI * tMs) / 4000) + (this.random() - 0.5) * 18);
  }
}

function gauss(x: number, mu: number, sigma: number): number {
  const z = (x - mu) / sigma;
  return Math.exp(-0.5 * z * z);
}

/**
 * RR during a ramp: intensity rises linearly from 0 to 1 over 15 min, then holds.
 * HR 70 → 165 bpm. Fractal correlation (AR(1), φ=0.95) and RSA fade with intensity while
 * uncorrelated noise remains, so DFA α1 falls from ~1.2 toward ~0.5 — crossing 0.75 near
 * minute ~12, like a real test. 1% of beats are premature (ectopic).
 */
export class RampRrModel {
  static readonly RAMP_MS = 15 * 60_000;
  private ar = 0;

  next(tMs: number, random: () => number): number {
    const p = Math.min(tMs / RampRrModel.RAMP_MS, 1);
    const base = 60000 / (70 + 95 * p);
    const gauss = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    this.ar = 0.95 * this.ar + gauss;
    const correlated = (1 - p) ** 1.5 * 15 * this.ar;
    const rsa = 8 * (1 - p) ** 2 * Math.sin((2 * Math.PI * tMs) / 4000);
    const white = (6 + 4 * p) * (random() - 0.5) * 3.4;
    const rr = base + correlated + rsa + white;
    return random() < 0.01 ? rr * 0.65 : rr;
  }
}
