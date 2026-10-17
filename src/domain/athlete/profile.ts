import type { Zone } from '../workouts/workout';

export type Sex = 'male' | 'female';

export interface AthleteProfile {
  readonly name: string;
  readonly birthYear: number | null;
  readonly sex: Sex | null;
  readonly weightKg: number | null;
  readonly heightCm: number | null;
  readonly restHr: number | null;
  /** Measured max HR. When null, an age-based estimate is used and labelled as such. */
  readonly maxHr: number | null;
  /** HR at ventilatory thresholds, usually from a DFA ramp. */
  readonly hrvt1: number | null;
  readonly hrvt2: number | null;
  /** Where hrvt1/hrvt2 came from; null when typed in by hand. */
  readonly thresholdsFrom: { readonly sessionId: string; readonly dateIso: string } | null;
}

export const EMPTY_PROFILE: AthleteProfile = {
  name: '',
  birthYear: null,
  sex: null,
  weightKg: null,
  heightCm: null,
  restHr: null,
  maxHr: null,
  hrvt1: null,
  hrvt2: null,
  thresholdsFrom: null,
};

export function ageOf(p: AthleteProfile, now = new Date()): number | null {
  return p.birthYear === null ? null : now.getFullYear() - p.birthYear;
}

/** Tanaka et al. 2001: 208 − 0.7 × age. ±10 bpm for an individual; a fallback only. */
export function estimatedMaxHr(age: number): number {
  return Math.round(208 - 0.7 * age);
}

export function effectiveMaxHr(p: AthleteProfile, now = new Date()): { readonly bpm: number; readonly estimated: boolean } | null {
  if (p.maxHr !== null) return { bpm: p.maxHr, estimated: false };
  const age = ageOf(p, now);
  return age === null ? null : { bpm: estimatedMaxHr(age), estimated: true };
}

export interface ZoneBounds {
  readonly vt1: number;
  readonly vt2: number;
  /** True when either bound comes from max HR instead of a threshold test. */
  readonly estimated: boolean;
}

/** Population ratios (Seiler): VT1 ≈ 77% and VT2 ≈ 89% of max HR. Only a fallback. */
const VT1_OF_MAX = 0.77;
const VT2_OF_MAX = 0.89;

export function zoneBounds(p: AthleteProfile, now = new Date()): ZoneBounds | null {
  if (p.hrvt1 !== null && p.hrvt2 !== null && p.hrvt1 < p.hrvt2) return { vt1: p.hrvt1, vt2: p.hrvt2, estimated: false };
  const max = effectiveMaxHr(p, now);
  if (!max) return null;
  const vt1 = p.hrvt1 ?? Math.round(max.bpm * VT1_OF_MAX);
  const vt2 = p.hrvt2 !== null && p.hrvt2 > vt1 ? p.hrvt2 : Math.round(max.bpm * VT2_OF_MAX);
  return { vt1, vt2, estimated: p.hrvt1 === null || p.hrvt2 === null };
}

export function zoneOf(hr: number, b: ZoneBounds): Zone {
  return hr < b.vt1 ? 1 : hr < b.vt2 ? 2 : 3;
}

export const ZONE_NAMES: Record<Zone, string> = {
  1: 'Zona 1 · leve',
  2: 'Zona 2 · moderada',
  3: 'Zona 3 · intensa',
};

export interface TimedHr {
  readonly tS: number;
  readonly bpm: number;
}

/**
 * Seconds in each zone. Each sample counts until the next one, capped at maxGapS so a
 * recording gap is not attributed to the zone before it.
 */
export function timeInZones(hr: readonly TimedHr[], b: ZoneBounds, maxGapS = 5): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < hr.length; i++) {
    const p = hr[i]!;
    const next = hr[i + 1];
    const dt = next ? Math.min(Math.max(next.tS - p.tS, 0), maxGapS) : 1;
    const z = zoneOf(p.bpm, b);
    out[z - 1] = out[z - 1]! + dt;
  }
  return out;
}

/** Lucia TRIMP: minutes in zone 1/2/3 weighted 1/2/3 (Lucia et al. 2003). */
export function luciaTrimp(secondsInZones: readonly [number, number, number]): number {
  return (secondsInZones[0] * 1 + secondsInZones[1] * 2 + secondsInZones[2] * 3) / 60;
}

/**
 * Energy from HR (Keytel et al. 2005), kcal. Needs sex, age and weight; null otherwise.
 * Typical error ±15–20%; shown as an estimate.
 */
export function caloriesFromHr(hr: readonly TimedHr[], p: AthleteProfile, now = new Date(), maxGapS = 5): number | null {
  const age = ageOf(p, now);
  if (p.sex === null || age === null || p.weightKg === null) return null;
  const w = p.weightKg;
  const perMin = (bpm: number) =>
    p.sex === 'male'
      ? (-55.0969 + 0.6309 * bpm + 0.1988 * w + 0.2017 * age) / 4.184
      : (-20.4022 + 0.4472 * bpm - 0.1263 * w + 0.074 * age) / 4.184;
  let kcal = 0;
  for (let i = 0; i < hr.length; i++) {
    const next = hr[i + 1];
    const dt = next ? Math.min(Math.max(next.tS - hr[i]!.tS, 0), maxGapS) : 1;
    kcal += (Math.max(0, perMin(hr[i]!.bpm)) * dt) / 60;
  }
  return kcal;
}

/** Profile fields the user typed, clamped to plausible ranges; out-of-range becomes null. */
export function sanitizeProfile(p: AthleteProfile): AthleteProfile {
  const inRange = (v: number | null, lo: number, hi: number) => (v !== null && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
  const year = new Date().getFullYear();
  return {
    ...p,
    name: p.name.trim().slice(0, 60),
    birthYear: inRange(p.birthYear, year - 100, year - 10),
    weightKg: inRange(p.weightKg, 25, 250),
    heightCm: inRange(p.heightCm, 100, 230),
    restHr: inRange(p.restHr, 25, 120),
    maxHr: inRange(p.maxHr, 120, 230),
    hrvt1: inRange(p.hrvt1, 70, 220),
    hrvt2: inRange(p.hrvt2, 80, 225),
  };
}
