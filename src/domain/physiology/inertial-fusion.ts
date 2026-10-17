import type { RrBeat } from './rr-quality';

/**
 * Respiration, cadence and trunk sway from the H10 chest accelerometer (200 Hz, mG),
 * plus respiratory sinus arrhythmia from R-R. All of it is an *estimate*:
 * - chest motion while pedalling overlaps the breathing band at low cadence;
 * - RSA fades above VT1, exactly where breathing rate matters most;
 * - strap orientation varies, so no axis is assumed to be lateral/vertical.
 *
 * Cadence: seated pedalling shakes the trunk once per crank revolution sideways and twice
 * vertically (one per pedal stroke). The strongest peak can therefore be either; a matching
 * peak at half or double the frequency on any axis resolves which.
 */

export const ACC_HZ = 200;
const DECIMATE = 8;
const FS = ACC_HZ / DECIMATE; // 25 Hz working rate
const STEP_MS = 5000;
const CADENCE_WINDOW_S = 10;
const RESP_WINDOW_S = 32;
const RESP_DECIMATE = 5; // 25 → 5 Hz for the breathing band
const RSA_WINDOW_MS = 60_000;
const RSA_FS = 4;

const CRANK_MIN_HZ = 0.6;
const CRANK_MAX_HZ = 2.2;
const SPECTRUM_MAX_HZ = 4.5;
const BREATH_MIN_HZ = 0.1;
const BREATH_MAX_HZ = 1.0;
/**
 * Peak power / median power. For white noise the largest of a few hundred bins sits near
 * 8× the median, so real rhythms must clear that comfortably.
 */
const MIN_PROMINENCE = 15;

export interface InertialPoint {
  readonly tS: number;
  readonly breathsPerMin: number | null;
  readonly breathSource: 'acc' | 'rsa' | 'both' | null;
  /** 0..1, from spectral peak prominence. */
  readonly breathConfidence: number;
  readonly rpm: number | null;
  readonly rpmConfidence: number;
  /** RMS of the lateral axis (the one carrying the crank fundamental), mG. */
  readonly swayMg: number | null;
}

interface Spectrum {
  readonly freqs: Float64Array;
  readonly power: Float64Array;
  readonly median: number;
}

/** Power on a frequency grid via direct DFT of the detrended, Hann-windowed signal. */
export function spectrum(signal: ArrayLike<number>, fs: number, fMin: number, fMax: number, step: number): Spectrum {
  const n = signal.length;
  const x = detrend(signal);
  for (let i = 0; i < n; i++) x[i] = x[i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  const bins = Math.floor((fMax - fMin) / step) + 1;
  const freqs = new Float64Array(bins);
  const power = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const f = fMin + k * step;
    const w = (2 * Math.PI * f) / fs;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      re += x[i]! * Math.cos(w * i);
      im -= x[i]! * Math.sin(w * i);
    }
    freqs[k] = f;
    power[k] = re * re + im * im;
  }
  const sorted = Float64Array.from(power).sort();
  return { freqs, power, median: sorted[sorted.length >> 1] ?? 0 };
}

export interface Peak {
  readonly freq: number;
  readonly prominence: number;
}

export function peakOf(s: Spectrum, fMin = -Infinity, fMax = Infinity, exclude: (f: number) => boolean = () => false): Peak | null {
  let best = -1;
  for (let k = 0; k < s.freqs.length; k++) {
    const f = s.freqs[k]!;
    if (f < fMin || f > fMax || exclude(f)) continue;
    if (best < 0 || s.power[k]! > s.power[best]!) best = k;
  }
  if (best < 0 || s.median <= 0) return null;
  return { freq: s.freqs[best]!, prominence: s.power[best]! / s.median };
}

/** Prominence of the strongest bin within ±tol of f. */
function prominenceNear(s: Spectrum, f: number, tol: number): number {
  const p = peakOf(s, f - tol, f + tol);
  return p?.prominence ?? 0;
}

/**
 * A real rhythm at f: prominent, and a local maximum — at least twice the power found a
 * little further out on both sides. Without the second test, leakage from a strong nearby
 * component (deep breathing at 0.4 Hz) passes for a peak at 0.75 Hz.
 */
function hasPeakAt(s: Spectrum, f: number): boolean {
  const centre = peakOf(s, f - 0.04, f + 0.04);
  if (!centre || centre.prominence < MIN_PROMINENCE) return false;
  const left = peakOf(s, f - 0.2, f - 0.12)?.prominence ?? 0;
  const right = peakOf(s, f + 0.12, f + 0.2)?.prominence ?? 0;
  return centre.prominence >= 2 * left && centre.prominence >= 2 * right;
}

/** Maps prominence 15 → 0 and ≥300 → 1 on a log scale. */
function confidence(prominence: number): number {
  return Math.max(0, Math.min(1, (Math.log10(prominence) - 1.18) / 1.3));
}

export interface CadenceEstimate {
  readonly crankHz: number;
  readonly confidence: number;
  readonly lateralAxis: number;
}

/** axes: three equally long signals at fs. */
export function estimateCadence(axes: readonly ArrayLike<number>[], fs: number): CadenceEstimate | null {
  const spectra = axes.map((a) => spectrum(a, fs, CRANK_MIN_HZ * 0.9, SPECTRUM_MAX_HZ, 0.01));
  let strongest: { axis: number; peak: Peak } | null = null;
  spectra.forEach((s, axis) => {
    const p = peakOf(s, CRANK_MIN_HZ, SPECTRUM_MAX_HZ);
    if (p && (!strongest || p.prominence > strongest.peak.prominence)) strongest = { axis, peak: p };
  });
  const top = strongest as { axis: number; peak: Peak } | null;
  if (!top || top.peak.prominence < MIN_PROMINENCE) return null;
  const F = top.peak.freq;
  const present = (f: number) => f >= CRANK_MIN_HZ && f <= SPECTRUM_MAX_HZ && spectra.some((s) => hasPeakAt(s, f));

  let crank: number;
  let conf: number;
  if (present(F / 2)) {
    crank = F / 2;
    conf = 0.9;
  } else if (present(F * 2)) {
    crank = F;
    conf = 0.9;
  } else {
    crank = F <= CRANK_MAX_HZ ? F : F / 2;
    conf = 0.5;
  }
  if (crank < CRANK_MIN_HZ || crank > CRANK_MAX_HZ) return null;
  conf *= confidence(top.peak.prominence) > 0.5 ? 1 : 0.7;
  // Lateral axis: most power at the crank fundamental.
  let lateralAxis = 0;
  spectra.forEach((s, i) => {
    if (prominenceNear(s, crank, 0.04) > prominenceNear(spectra[lateralAxis]!, crank, 0.04)) lateralAxis = i;
  });
  return { crankHz: crank, confidence: conf, lateralAxis };
}

export function estimateBreathingFromAcc(axes: readonly ArrayLike<number>[], fs: number, crankHz: number | null): Peak | null {
  const exclude = (f: number) => crankHz !== null && (Math.abs(f - crankHz) < 0.06 || Math.abs(f - crankHz / 2) < 0.04);
  let best: Peak | null = null;
  for (const a of axes) {
    const p = peakOf(spectrum(a, fs, BREATH_MIN_HZ * 0.8, BREATH_MAX_HZ, 0.005), BREATH_MIN_HZ, BREATH_MAX_HZ, exclude);
    if (p && (!best || p.prominence > best.prominence)) best = p;
  }
  return best;
}

/** RSA: dominant oscillation of the R-R tachogram, resampled at 4 Hz. */
export function estimateBreathingFromRr(beats: readonly RrBeat[]): Peak | null {
  const ok = beats.filter((b) => b.accepted);
  if (ok.length < 40) return null;
  const t0 = ok[0]!.tMs;
  const t1 = ok.at(-1)!.tMs;
  const n = Math.floor(((t1 - t0) / 1000) * RSA_FS);
  if (n < RSA_FS * 30) return null;
  const series = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + (i * 1000) / RSA_FS;
    while (j + 1 < ok.length && ok[j + 1]!.tMs < t) j++;
    const a = ok[j]!;
    const b = ok[j + 1] ?? a;
    const u = b.tMs === a.tMs ? 0 : (t - a.tMs) / (b.tMs - a.tMs);
    series[i] = a.rrMs + u * (b.rrMs - a.rrMs);
  }
  // A beat series cannot carry oscillations faster than half the beat rate.
  const meanBeatHz = 1000 / (ok.reduce((s, b) => s + b.rrMs, 0) / ok.length);
  const fMax = Math.min(BREATH_MAX_HZ, 0.45 * meanBeatHz);
  if (fMax <= BREATH_MIN_HZ) return null;
  return peakOf(spectrum(series, RSA_FS, BREATH_MIN_HZ * 0.8, fMax, 0.005), BREATH_MIN_HZ, fMax);
}

export function fuseBreathing(acc: Peak | null, rsa: Peak | null): Pick<InertialPoint, 'breathsPerMin' | 'breathSource' | 'breathConfidence'> {
  const a = acc && acc.prominence >= MIN_PROMINENCE ? acc : null;
  const r = rsa && rsa.prominence >= MIN_PROMINENCE ? rsa : null;
  if (a && r && Math.abs(a.freq - r.freq) <= 0.04) {
    const f = (a.freq * a.prominence + r.freq * r.prominence) / (a.prominence + r.prominence);
    return { breathsPerMin: f * 60, breathSource: 'both', breathConfidence: Math.min(1, confidence(Math.max(a.prominence, r.prominence)) + 0.2) };
  }
  const best = a && r ? (a.prominence >= r.prominence ? a : r) : (a ?? r);
  if (!best) return { breathsPerMin: null, breathSource: null, breathConfidence: 0 };
  // Disagreeing sources lower trust.
  const penalty = a && r ? 0.6 : 1;
  return { breathsPerMin: best.freq * 60, breathSource: best === a ? 'acc' : 'rsa', breathConfidence: confidence(best.prominence) * penalty };
}

/**
 * Streaming tracker: feed raw ACC frames and R-R beats; emits one point per 5 s of ACC
 * time once 10 s of motion exist. Pure, so it runs the same in the Worker and in tests.
 */
export class InertialTracker {
  private readonly axes: [number[], number[], number[]] = [[], [], []];
  private block: [number, number, number] = [0, 0, 0];
  private blockCount = 0;
  private rawSamples = 0;
  private nextAtMs: number;
  private beats: RrBeat[] = [];

  constructor(private readonly fromMs = 0) {
    this.nextAtMs = fromMs + CADENCE_WINDOW_S * 1000;
  }

  pushBeats(beats: readonly RrBeat[]): void {
    for (const b of beats) if (b.tMs > this.fromMs) this.beats.push(b);
    const last = this.beats.at(-1)?.tMs ?? 0;
    let drop = 0;
    while (drop < this.beats.length && this.beats[drop]!.tMs < last - RSA_WINDOW_MS) drop++;
    if (drop) this.beats.splice(0, drop);
  }

  /** Interleaved x,y,z in mG at 200 Hz. */
  pushAcc(xyz: ArrayLike<number>): InertialPoint[] {
    const out: InertialPoint[] = [];
    const keep = RESP_WINDOW_S * FS;
    for (let i = 0; i + 2 < xyz.length; i += 3) {
      this.block[0] += xyz[i]!;
      this.block[1] += xyz[i + 1]!;
      this.block[2] += xyz[i + 2]!;
      this.rawSamples++;
      if (++this.blockCount === DECIMATE) {
        for (let a = 0; a < 3; a++) {
          const axis = this.axes[a]!;
          axis.push(this.block[a]! / DECIMATE);
          if (axis.length > keep) axis.shift();
        }
        this.block = [0, 0, 0];
        this.blockCount = 0;
      }
      const nowMs = this.fromMs + (this.rawSamples * 1000) / ACC_HZ;
      if (nowMs >= this.nextAtMs) {
        out.push(this.evaluate(this.nextAtMs));
        this.nextAtMs += STEP_MS;
      }
    }
    return out;
  }

  private evaluate(atMs: number): InertialPoint {
    const nCad = CADENCE_WINDOW_S * FS;
    const cadAxes = this.axes.map((a) => a.slice(-nCad));
    const cadence = cadAxes[0]!.length >= nCad ? estimateCadence(cadAxes, FS) : null;

    let accBreath: Peak | null = null;
    if (this.axes[0].length >= RESP_WINDOW_S * FS) {
      const slow = this.axes.map((a) => blockMean(a, RESP_DECIMATE));
      accBreath = estimateBreathingFromAcc(slow, FS / RESP_DECIMATE, cadence?.crankHz ?? null);
    }
    const breath = fuseBreathing(accBreath, estimateBreathingFromRr(this.beats));

    let swayMg: number | null = null;
    if (cadence) {
      const lateral = detrend(cadAxes[cadence.lateralAxis]!);
      swayMg = Math.sqrt(lateral.reduce((s, v) => s + v * v, 0) / lateral.length);
    }
    return {
      tS: atMs / 1000,
      ...breath,
      rpm: cadence ? cadence.crankHz * 60 : null,
      rpmConfidence: cadence?.confidence ?? 0,
      swayMg,
    };
  }
}

function blockMean(xs: readonly number[], k: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + k <= xs.length; i += k) {
    let s = 0;
    for (let j = 0; j < k; j++) s += xs[i + j]!;
    out.push(s / k);
  }
  return out;
}

/** Removes the least-squares line. */
function detrend(signal: ArrayLike<number>): Float64Array {
  const n = signal.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const mx = (n - 1) / 2;
  let my = 0;
  for (let i = 0; i < n; i++) my += signal[i]!;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (signal[i]! - my);
    sxx += (i - mx) ** 2;
  }
  const k = sxx ? sxy / sxx : 0;
  for (let i = 0; i < n; i++) out[i] = signal[i]! - (my + k * (i - mx));
  return out;
}
