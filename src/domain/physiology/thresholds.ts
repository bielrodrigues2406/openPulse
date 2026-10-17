import { DFA_WINDOW_MS, VT1_ALPHA1, VT2_ALPHA1, type DfaPoint } from './dfa-alpha1';

/**
 * HRVT1/HRVT2 from a ramp (Rogers et al. 2021): regress α1 on the HR of the same 2-min
 * window over the falling part of the curve, then solve for α1 = 0.75 and 0.50.
 */

export interface ThresholdEstimate {
  readonly hrvt1: number | null;
  readonly hrvt2: number | null;
  readonly slope: number; // α1 per bpm, negative
  readonly intercept: number;
  readonly r2: number;
  readonly points: number;
  readonly alphaMax: number;
  readonly alphaMin: number;
  readonly hrMin: number;
  readonly hrMax: number;
  /** Why a threshold is missing, in Portuguese, for the UI. */
  readonly notes: readonly string[];
}

export interface HrSample {
  readonly tS: number;
  readonly bpm: number;
}

const MIN_POINTS = 8;
const MIN_R2 = 0.4;
/** Fitted HR may sit this far outside the observed HR range before it counts as extrapolation. */
const EXTRAPOLATION_BPM = 5;

export function estimateThresholds(dfa: readonly DfaPoint[], hr: readonly HrSample[]): ThresholdEstimate | null {
  const pairs: { hr: number; a: number }[] = [];
  for (const p of dfa) {
    if (p.alpha1 === null) continue;
    const meanHr = meanHrIn(hr, p.tS - DFA_WINDOW_MS / 1000, p.tS);
    if (meanHr !== null) pairs.push({ hr: meanHr, a: p.alpha1 });
  }
  if (pairs.length < MIN_POINTS) return null;

  // Start where the (median-smoothed) curve leaves its peak: the plateau before it is warm-up
  // and would flatten the slope.
  const smooth = pairs.map((_, i) => median3(pairs[i - 1]?.a, pairs[i]!.a, pairs[i + 1]?.a));
  const top = Math.max(...smooth);
  let peak = 0;
  for (let i = 0; i < smooth.length; i++) if (smooth[i]! >= top - 0.03) peak = i;
  const falling = pairs.slice(peak).filter((p) => p.a >= 0.2 && p.a <= 1.4);
  if (falling.length < MIN_POINTS) return null;

  const { slope, intercept, r2 } = linearFit(falling.map((p) => p.hr), falling.map((p) => p.a));
  const alphaMax = Math.max(...falling.map((p) => p.a));
  const alphaMin = Math.min(...falling.map((p) => p.a));
  const hrMin = Math.min(...falling.map((p) => p.hr));
  const hrMax = Math.max(...falling.map((p) => p.hr));
  const notes: string[] = [];

  const solve = (alpha: number): number | null => {
    if (!(slope < 0) || r2 < MIN_R2) return null;
    const x = (alpha - intercept) / slope;
    return x >= hrMin - EXTRAPOLATION_BPM && x <= hrMax + EXTRAPOLATION_BPM ? Math.round(x) : null;
  };

  if (!(slope < 0)) notes.push('O α1 não caiu com a FC; a rampa não foi suficiente.');
  else if (r2 < MIN_R2) notes.push(`Relação α1 × FC fraca (R² ${r2.toFixed(2)}). Repita com mais controle de carga.`);

  let hrvt1 = alphaMax >= VT1_ALPHA1 && alphaMin <= VT1_ALPHA1 + 0.05 ? solve(VT1_ALPHA1) : null;
  if (hrvt1 === null && notes.length === 0) notes.push('O α1 não cruzou 0,75 durante o teste.');
  const reached = alphaMin <= VT2_ALPHA1 + 0.05;
  let hrvt2 = reached ? solve(VT2_ALPHA1) : null;
  if (hrvt2 === null && notes.length === 0) {
    notes.push(
      reached
        ? 'O α1 chegou a 0,50, mas a reta α1 × FC só o alcança fora da faixa de FC do teste; HRVT2 não estimado.'
        : 'O α1 não chegou perto de 0,50; HRVT2 não estimado. Vá mais longe na próxima rampa.',
    );
  }
  if (hrvt1 !== null && hrvt2 !== null && hrvt2 <= hrvt1) {
    hrvt1 = null;
    hrvt2 = null;
    notes.push('Limiares incoerentes; repita o teste.');
  }
  return { hrvt1, hrvt2, slope, intercept, r2, points: falling.length, alphaMax, alphaMin, hrMin, hrMax, notes };
}

function meanHrIn(hr: readonly HrSample[], fromS: number, toS: number): number | null {
  let sum = 0;
  let n = 0;
  for (const p of hr) {
    if (p.tS > fromS && p.tS <= toS) {
      sum += p.bpm;
      n++;
    }
  }
  return n >= 10 ? sum / n : null;
}

function median3(a: number | undefined, b: number, c: number | undefined): number {
  if (a === undefined || c === undefined) return b;
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

export function linearFit(xs: readonly number[], ys: readonly number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept: my - slope * mx, r2 };
}
