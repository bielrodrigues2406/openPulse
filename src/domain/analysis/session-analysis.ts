import { activeToWallMs } from '../session/fit-encoder';
import type { HrPoint, SessionRecord } from '../session/recorded-session';

/**
 * HR drift of a steady block: mean HR of the second half vs the first, in %.
 * Without power it mixes fatigue, heat and dehydration; useful as a trend on repeated
 * endurance sessions. Needs ≥ 20 min.
 */
export function hrDriftPct(hr: readonly HrPoint[], fromS: number, toS: number): number | null {
  if (toS - fromS < 20 * 60) return null;
  const mid = (fromS + toS) / 2;
  const first = meanBpm(hr, fromS, mid);
  const second = meanBpm(hr, mid, toS);
  return first === null || second === null ? null : ((second - first) / first) * 100;
}

/** Steadiest block to judge drift on: the longest phase, or the whole session when free. */
export function driftWindow(s: Pick<SessionRecord, 'workout' | 'segments'>): { fromS: number; toS: number } | null {
  const phases = s.workout?.phases ?? [];
  if (phases.length === 0) {
    const end = s.segments.at(-1)?.endMs ?? 0;
    return { fromS: 10 * 60, toS: end / 1000 }; // skip a 10 min warm-up
  }
  let best = -1;
  phases.forEach((p, i) => {
    if (best < 0 || p.durationS > phases[best]!.durationS) best = i;
  });
  const startActive = phases.slice(0, best).reduce((a, p) => a + p.durationS, 0);
  const from = activeToWallMs(s.segments, startActive);
  const to = activeToWallMs(s.segments, startActive + phases[best]!.durationS);
  if (from === null) return null;
  return { fromS: from / 1000, toS: (to ?? s.segments.at(-1)!.endMs) / 1000 };
}

export interface HrRecovery {
  readonly afterPhase: string;
  readonly atS: number;
  readonly dropBpm: number;
}

/**
 * HR drop 60 s after each hard phase (zone 2/3 target) hands over to an easy one.
 * Faster drops over weeks indicate better parasympathetic reactivation.
 */
export function hrRecoveries(s: Pick<SessionRecord, 'workout' | 'segments' | 'hr'>): HrRecovery[] {
  const phases = s.workout?.phases ?? [];
  const out: HrRecovery[] = [];
  let acc = 0;
  for (let i = 0; i + 1 < phases.length; i++) {
    const p = phases[i]!;
    const next = phases[i + 1]!;
    acc += p.durationS;
    const hard = p.target.kind === 'zone' && p.target.zone >= 2;
    const easy = next.target.kind === 'zone' && next.target.zone === 1;
    if (!hard || !easy) continue;
    const wall = activeToWallMs(s.segments, acc);
    if (wall === null) continue;
    const t = wall / 1000;
    const atEnd = meanBpm(s.hr, t - 5, t);
    const after = meanBpm(s.hr, t + 57, t + 63);
    if (atEnd !== null && after !== null) out.push({ afterPhase: p.name, atS: t, dropBpm: atEnd - after });
  }
  return out;
}

function meanBpm(hr: readonly HrPoint[], fromS: number, toS: number): number | null {
  let sum = 0;
  let n = 0;
  for (const p of hr) {
    if (p.tS >= fromS && p.tS < toS) {
      sum += p.bpm;
      n++;
    }
  }
  return n ? sum / n : null;
}

export interface Lap {
  readonly name: string;
  readonly fromS: number; // wall-clock, from session start
  readonly toS: number;
  readonly activeS: number;
  readonly meanBpm: number | null;
  readonly maxBpm: number | null;
  readonly meanAlpha1: number | null;
}

/** Laps = workout phases, further split by manual markers. */
export function laps(s: Pick<SessionRecord, 'workout' | 'segments' | 'markers' | 'hr' | 'dfa'>): Lap[] {
  const end = (s.segments.at(-1)?.endMs ?? 0) / 1000;
  const cuts: { t: number; name: string }[] = [];
  const phases = s.workout?.phases ?? [];
  let acc = 0;
  for (const p of phases) {
    const w = activeToWallMs(s.segments, acc);
    if (w === null) break;
    cuts.push({ t: w / 1000, name: p.name });
    acc += p.durationS;
  }
  if (!cuts.length || cuts[0]!.t > 0) cuts.unshift({ t: 0, name: phases.length ? 'Antes do plano' : 'Início' });
  for (const m of s.markers) cuts.push({ t: m.tMs / 1000, name: m.label });
  cuts.sort((a, b) => a.t - b.t);
  const out: Lap[] = [];
  for (let i = 0; i < cuts.length; i++) {
    const from = cuts[i]!.t;
    const to = cuts[i + 1]?.t ?? end;
    if (to - from < 1) continue;
    const hr = s.hr.filter((p) => p.tS >= from && p.tS < to).map((p) => p.bpm);
    const alpha = s.dfa.flatMap((p) => (p.alpha1 !== null && p.tS >= from && p.tS < to ? [p.alpha1] : []));
    const activeS = s.segments.reduce((sum, g) => sum + Math.max(0, Math.min(to * 1000, g.endMs) - Math.max(from * 1000, g.startMs)), 0) / 1000;
    out.push({
      name: cuts[i]!.name,
      fromS: from,
      toS: to,
      activeS,
      meanBpm: hr.length ? hr.reduce((a, b) => a + b, 0) / hr.length : null,
      maxBpm: hr.length ? Math.max(...hr) : null,
      meanAlpha1: alpha.length ? alpha.reduce((a, b) => a + b, 0) / alpha.length : null,
    });
  }
  return out;
}
