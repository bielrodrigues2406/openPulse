/**
 * RR interval artifact gate and time-domain HRV.
 * A beat is rejected if outside [250, 2000] ms or deviating >20% from the median of the
 * last 5 accepted beats. Rejected beats are kept (flagged) so artifact rate is observable.
 */

export interface RrBeat {
  readonly tMs: number; // cumulative time of the beat, ms since session start
  readonly rrMs: number;
  readonly accepted: boolean;
  /** First beat after a recording gap: its RR is not comparable with the previous beat. */
  readonly gapBefore?: true;
}

export const RR_MIN_MS = 250;
export const RR_MAX_MS = 2000;
export const RR_MAX_RELATIVE_DEVIATION = 0.2;
const MEDIAN_WINDOW = 5;
/** Consecutive, mutually consistent rejections that mean "HR really changed", not artifacts. */
const NEW_LEVEL_RUN = 5;

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
  private pendingGap = false;
  private rejectedRun: number[] = [];

  /** Rebuilds a series from stored beats (resuming a session). */
  static from(beats: readonly RrBeat[]): RrSeries {
    const s = new RrSeries();
    s.beats.push(...beats);
    s.clockMs = beats.at(-1)?.tMs ?? 0;
    for (const b of beats) {
      if (b.gapBefore) s.acceptedTail.length = 0;
      if (b.accepted) s.acceptedTail.push(b.rrMs);
      if (s.acceptedTail.length > MEDIAN_WINDOW) s.acceptedTail.shift();
    }
    return s;
  }

  /**
   * Starts a new recording segment at wall-clock offset tMs. The next beat is flagged
   * gapBefore and the artifact median restarts, since the strap may have moved.
   */
  resumeAt(tMs: number): void {
    this.clockMs = Math.max(this.clockMs, tMs);
    this.acceptedTail.length = 0;
    this.pendingGap = this.beats.length > 0;
  }

  push(rrMs: number): RrBeat {
    let accepted = classifyRr(rrMs, this.acceptedTail);
    if (!accepted && rrMs >= RR_MIN_MS && rrMs <= RR_MAX_MS) {
      // A sustained step (standing up, a sprint) would otherwise lock every new beat out.
      this.rejectedRun.push(rrMs);
      if (this.rejectedRun.length > NEW_LEVEL_RUN) this.rejectedRun.shift();
      const ref = median(this.rejectedRun);
      if (this.rejectedRun.length === NEW_LEVEL_RUN && this.rejectedRun.every((v) => Math.abs(v - ref) / ref <= RR_MAX_RELATIVE_DEVIATION)) {
        this.acceptedTail.length = 0;
        this.acceptedTail.push(...this.rejectedRun.slice(0, -1));
        accepted = true;
      }
    }
    if (accepted) this.rejectedRun = [];
    this.clockMs += rrMs;
    const beat: RrBeat = this.pendingGap ? { tMs: this.clockMs, rrMs, accepted, gapBefore: true } : { tMs: this.clockMs, rrMs, accepted };
    this.pendingGap = false;
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
    if (!a.accepted || !b.accepted || b.gapBefore) continue;
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
