/**
 * RR interval artifact gate and time-domain HRV.
 * A beat is rejected if outside [250, 2000] ms or deviating >20% from the median of the
 * last 5 accepted beats. Rejected beats are kept (flagged) so artifact rate is observable.
 */

export interface RrBeat {
  readonly tMs: number; // cumulative time of the beat, ms since session start
  readonly rrMs: number;
  readonly accepted: boolean;
}

export const RR_MIN_MS = 250;
export const RR_MAX_MS = 2000;
export const RR_MAX_RELATIVE_DEVIATION = 0.2;
const MEDIAN_WINDOW = 5;

export function classifyRr(rrMs: number, recentAccepted: readonly number[]): boolean {
  if (!(rrMs >= RR_MIN_MS && rrMs <= RR_MAX_MS)) return false;
  if (recentAccepted.length < MEDIAN_WINDOW) return true;
  const ref = median(recentAccepted.slice(-MEDIAN_WINDOW));
  return Math.abs(rrMs - ref) / ref <= RR_MAX_RELATIVE_DEVIATION;
}

export class RrSeries {
  private readonly beats: RrBeat[] = [];
  private readonly acceptedTail: number[] = [];
  private clockMs = 0;

  push(rrMs: number): RrBeat {
    const accepted = classifyRr(rrMs, this.acceptedTail);
    this.clockMs += rrMs;
    const beat: RrBeat = { tMs: this.clockMs, rrMs, accepted };
    this.beats.push(beat);
    if (accepted) {
      this.acceptedTail.push(rrMs);
      if (this.acceptedTail.length > MEDIAN_WINDOW) this.acceptedTail.shift();
    }
    return beat;
  }

  all(): readonly RrBeat[] {
    return this.beats;
  }

  window(durationMs: number): readonly RrBeat[] {
    const from = this.clockMs - durationMs;
    let i = this.beats.length;
    while (i > 0 && this.beats[i - 1]!.tMs > from) i--;
    return this.beats.slice(i);
  }
}

/** RMSSD over successive pairs where both beats were accepted. null if <2 valid pairs. */
export function rmssd(beats: readonly RrBeat[]): number | null {
  let sum = 0;
  let n = 0;
  for (let i = 1; i < beats.length; i++) {
    const a = beats[i - 1]!;
    const b = beats[i]!;
    if (!a.accepted || !b.accepted) continue;
    const d = b.rrMs - a.rrMs;
    sum += d * d;
    n++;
  }
  return n < 2 ? null : Math.sqrt(sum / n);
}

/** Fraction of rejected beats, 0..1. null for an empty window. */
export function artifactRate(beats: readonly RrBeat[]): number | null {
  if (beats.length === 0) return null;
  return beats.filter((b) => !b.accepted).length / beats.length;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
