import { artifactRate, rmssd, type RrBeat } from './rr-quality';

/**
 * Morning orthostatic test: 90 s lying still, then stand up and stay still 90 s.
 * Lying: RMSSD/HR over 30–90 s (the first 30 s settle). Standing: peak HR in the first
 * 30 s (orthostatic response), RMSSD/HR over 30–90 s.
 * ln RMSSD lying, compared with the athlete's own recent baseline, is the readiness signal.
 */

export const ORTHO_LYING_S = 90;
export const ORTHO_STANDING_S = 90;
const SETTLE_S = 30;
const MAX_ARTIFACT_RATE = 0.1;

export interface OrthostaticResult {
  readonly id: string;
  readonly dateIso: string;
  readonly lyingHr: number;
  readonly lyingRmssd: number;
  readonly lnRmssd: number;
  readonly standingHr: number;
  readonly standingRmssd: number;
  readonly peakHr: number;
  readonly artifactPct: number;
}

export type OrthostaticOutcome =
  | { readonly ok: true; readonly result: Omit<OrthostaticResult, 'id' | 'dateIso'> }
  | { readonly ok: false; readonly reason: string };

/** beats: tMs relative to the start of the test; standUpMs: when the athlete stood. */
export function analyzeOrthostatic(beats: readonly RrBeat[], standUpMs: number): OrthostaticOutcome {
  const lying = beats.filter((b) => b.tMs > SETTLE_S * 1000 && b.tMs <= standUpMs);
  const early = beats.filter((b) => b.tMs > standUpMs && b.tMs <= standUpMs + SETTLE_S * 1000);
  const standing = beats.filter((b) => b.tMs > standUpMs + SETTLE_S * 1000 && b.tMs <= standUpMs + ORTHO_STANDING_S * 1000);
  if (lying.length < 30 || standing.length < 30) return { ok: false, reason: 'Poucos batimentos. Refaça o teste até o fim, parado.' };

  const all = [...lying, ...early, ...standing];
  const rate = artifactRate(all) ?? 1;
  if (rate > MAX_ARTIFACT_RATE) {
    return { ok: false, reason: `Muitos artefatos (${(rate * 100).toFixed(0)}%). Ajuste a cinta e fique imóvel.` };
  }
  const lyingRmssd = rmssd(lying);
  const standingRmssd = rmssd(standing);
  if (lyingRmssd === null || standingRmssd === null) return { ok: false, reason: 'Sinal insuficiente para calcular a VFC.' };
  const hrOf = (bs: readonly RrBeat[]) => 60000 / (bs.filter((b) => b.accepted).reduce((s, b) => s + b.rrMs, 0) / bs.filter((b) => b.accepted).length);
  const okEarly = early.filter((b) => b.accepted);
  const peakHr = okEarly.length ? 60000 / Math.min(...okEarly.map((b) => b.rrMs)) : hrOf(standing);
  return {
    ok: true,
    result: {
      lyingHr: hrOf(lying),
      lyingRmssd,
      lnRmssd: Math.log(lyingRmssd),
      standingHr: hrOf(standing),
      standingRmssd,
      peakHr,
      artifactPct: rate * 100,
    },
  };
}

export type Readiness =
  | { readonly state: 'calibrating'; readonly needed: number }
  | { readonly state: 'low' | 'normal' | 'high'; readonly mean: number; readonly sd: number; readonly z: number };

const BASELINE_DAYS = 7;
const MIN_BASELINE = 3;

/**
 * Today's ln RMSSD against the mean ± SD of the previous 7 days (not including today).
 * Outside ±1 SD is flagged. This is guidance, not a medical verdict.
 */
export function readiness(today: OrthostaticResult, history: readonly OrthostaticResult[]): Readiness {
  const t = new Date(today.dateIso).getTime();
  const from = t - BASELINE_DAYS * 86_400_000;
  const prior = history.filter((h) => h.id !== today.id).filter((h) => {
    const ht = new Date(h.dateIso).getTime();
    return ht < t && ht >= from;
  });
  if (prior.length < MIN_BASELINE) return { state: 'calibrating', needed: MIN_BASELINE - prior.length };
  const xs = prior.map((h) => h.lnRmssd);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) || 0.05;
  const z = (today.lnRmssd - mean) / sd;
  return { state: z < -1 ? 'low' : z > 1 ? 'high' : 'normal', mean, sd, z };
}
