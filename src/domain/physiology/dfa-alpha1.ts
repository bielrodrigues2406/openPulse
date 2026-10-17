import type { RrBeat } from './rr-quality';

/**
 * Short-term detrended fluctuation analysis (Peng et al. 1995), scales 4..16 beats.
 * Thresholds 0.75 / 0.50 (Rogers et al. 2021) are population estimates of VT1 / VT2,
 * not individual thresholds; the UI must say so.
 */

export const DFA_MIN_SCALE = 4;
export const DFA_MAX_SCALE = 16;
export const DFA_WINDOW_MS = 120_000;
export const DFA_STEP_MS = 5_000;
/** Above this artifact rate alpha1 is biased (Rogers 2021: >~5% shifts it noticeably). */
export const DFA_MAX_ARTIFACT_RATE = 0.05;
/** At least 4 boxes at the largest scale. */
export const DFA_MIN_BEATS = DFA_MAX_SCALE * 4;

export const VT1_ALPHA1 = 0.75;
export const VT2_ALPHA1 = 0.5;

/** alpha1 of an evenly indexed series. Throws if the series is too short to fit the largest scale. */
export function dfaAlpha1(rr: readonly number[]): number {
  if (rr.length < DFA_MIN_BEATS) throw new RangeError(`DFA needs ≥${DFA_MIN_BEATS} beats, got ${rr.length}`);
  const mean = rr.reduce((a, b) => a + b, 0) / rr.length;
  const profile = new Float64Array(rr.length);
  let acc = 0;
  for (let i = 0; i < rr.length; i++) profile[i] = acc += rr[i]! - mean;

  const logN: number[] = [];
  const logF: number[] = [];
  for (let n = DFA_MIN_SCALE; n <= DFA_MAX_SCALE; n++) {
    const f = fluctuation(profile, n);
    if (f <= 0) continue; // perfectly linear profile at this scale carries no information
    logN.push(Math.log(n));
    logF.push(Math.log(f));
  }
  if (logN.length < 2) throw new RangeError('DFA undefined: series has no fluctuation');
  return slope(logN, logF);
}

/** RMS of residuals after least-squares linear detrend in non-overlapping boxes of size n. */
function fluctuation(profile: Float64Array, n: number): number {
  const boxes = Math.floor(profile.length / n);
  // x = 0..n-1 is identical for every box; precompute its moments.
  const xMean = (n - 1) / 2;
  let sxx = 0;
  for (let x = 0; x < n; x++) sxx += (x - xMean) ** 2;

  let sumSq = 0;
  for (let b = 0; b < boxes; b++) {
    const off = b * n;
    let yMean = 0;
    for (let x = 0; x < n; x++) yMean += profile[off + x]!;
    yMean /= n;
    let sxy = 0;
    for (let x = 0; x < n; x++) sxy += (x - xMean) * (profile[off + x]! - yMean);
    const k = sxy / sxx;
    for (let x = 0; x < n; x++) {
      const r = profile[off + x]! - (yMean + k * (x - xMean));
      sumSq += r * r;
    }
  }
  return Math.sqrt(sumSq / (boxes * n));
}

function slope(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return num / den;
}

/**
 * Replaces rejected beats by linear interpolation between the nearest accepted neighbours
 * (by beat index). Leading/trailing rejected beats take the nearest accepted value.
 * Returns null if no beat is accepted.
 */
export function correctedRr(beats: readonly RrBeat[]): number[] | null {
  const ok = beats.flatMap((b, i) => (b.accepted ? [i] : []));
  if (ok.length === 0) return null;
  const out = new Array<number>(beats.length);
  let k = 0;
  for (let i = 0; i < beats.length; i++) {
    while (k + 1 < ok.length && ok[k + 1]! <= i) k++;
    const lo = ok[k]!;
    if (beats[i]!.accepted || i <= lo) {
      out[i] = beats[beats[i]!.accepted ? i : lo]!.rrMs;
      continue;
    }
    const hi = ok[k + 1];
    if (hi === undefined) {
      out[i] = beats[lo]!.rrMs;
      continue;
    }
    const t = (i - lo) / (hi - lo);
    out[i] = beats[lo]!.rrMs + t * (beats[hi]!.rrMs - beats[lo]!.rrMs);
  }
  return out;
}

export type DfaPoint =
  | { readonly tS: number; readonly alpha1: number; readonly artifactPct: number; readonly beats: number }
  | { readonly tS: number; readonly alpha1: null; readonly reason: 'artifacts' | 'too-few-beats' | 'no-variability'; readonly artifactPct: number; readonly beats: number };

/**
 * Sliding-window tracker: feed beats in order; emits one point per 5 s of beat time
 * once 120 s of beats exist. Pure and synchronous, so it runs identically in a Worker or a test.
 */
export class DfaTracker {
  private readonly beats: RrBeat[] = [];
  private nextAtMs: number;

  /** fromMs: start of a recording segment; windows never reach back across it. */
  constructor(private readonly fromMs = 0) {
    this.nextAtMs = fromMs + DFA_WINDOW_MS;
  }

  push(newBeats: readonly RrBeat[]): DfaPoint[] {
    const out: DfaPoint[] = [];
    for (const beat of newBeats) {
      if (beat.tMs <= this.fromMs) continue;
      this.beats.push(beat);
      while (beat.tMs >= this.nextAtMs) {
        out.push(this.evaluate(this.nextAtMs));
        this.nextAtMs += DFA_STEP_MS;
      }
    }
    // Keep only what the next window can still need.
    const keepFrom = this.nextAtMs - DFA_WINDOW_MS;
    let drop = 0;
    while (drop < this.beats.length && this.beats[drop]!.tMs <= keepFrom) drop++;
    if (drop) this.beats.splice(0, drop);
    return out;
  }

  private evaluate(endMs: number): DfaPoint {
    const win = this.beats.filter((b) => b.tMs > endMs - DFA_WINDOW_MS && b.tMs <= endMs);
    const rejected = win.filter((b) => !b.accepted).length;
    const artifactPct = win.length ? (rejected / win.length) * 100 : 0;
    const base = { tS: endMs / 1000, artifactPct, beats: win.length };
    if (win.length < DFA_MIN_BEATS) return { ...base, alpha1: null, reason: 'too-few-beats' };
    if (rejected / win.length > DFA_MAX_ARTIFACT_RATE) return { ...base, alpha1: null, reason: 'artifacts' };
    const rr = correctedRr(win);
    if (!rr) return { ...base, alpha1: null, reason: 'artifacts' };
    try {
      return { ...base, alpha1: dfaAlpha1(rr) };
    } catch {
      // A perfectly regular series (paced beats, a stuck sensor) has no fractal structure.
      return { ...base, alpha1: null, reason: 'no-variability' };
    }
  }
}
