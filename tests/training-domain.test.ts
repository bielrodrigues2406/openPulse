import { describe, expect, it } from 'vitest';
import { driftWindow, hrDriftPct, hrRecoveries } from '../src/domain/analysis/session-analysis';
import { fitnessSeries, thresholdHistory, weeklyLoads } from '../src/domain/analysis/trends';
import {
  EMPTY_PROFILE,
  caloriesFromHr,
  effectiveMaxHr,
  luciaTrimp,
  sanitizeProfile,
  timeInZones,
  zoneBounds,
  zoneOf,
} from '../src/domain/athlete/profile';
import type { DfaPoint } from '../src/domain/physiology/dfa-alpha1';
import { analyzeOrthostatic, readiness, type OrthostaticResult } from '../src/domain/physiology/orthostatic';
import { RrSeries } from '../src/domain/physiology/rr-quality';
import { estimateThresholds } from '../src/domain/physiology/thresholds';
import { POLARIZED_WEEK, mondayOf, resolveWeek } from '../src/domain/workouts/week-plan';
import {
  BUILT_IN_WORKOUTS,
  describeTarget,
  evaluateTarget,
  phase,
  phaseAt,
  repeat,
  totalDurationS,
  validateTemplate,
} from '../src/domain/workouts/workout';
import { makeRecord } from './session-storage.test';

describe('workouts', () => {
  const phases = [phase('A', 1), ...repeat(2, [phase('Tiro', 0.5), phase('Rec', 0.5)])];

  it('repeat numbers the blocks and the timeline walks through them', () => {
    expect(phases.map((p) => p.name)).toEqual(['A', 'Tiro 1/2', 'Rec 1/2', 'Tiro 2/2', 'Rec 2/2']);
    expect(totalDurationS(phases)).toBe(180);
    expect(phaseAt(phases, 0)).toMatchObject({ index: 0, phaseElapsedS: 0, phaseRemainingS: 60 });
    expect(phaseAt(phases, 75)).toMatchObject({ index: 1, phaseElapsedS: 15, phaseRemainingS: 15, next: { name: 'Rec 1/2' } });
    expect(phaseAt(phases, 179)!.index).toBe(4);
    expect(phaseAt(phases, 180)).toBeNull();
    expect(phaseAt([], 10)).toBeNull();
  });

  it('target state is about intensity: α1 below its band means working too hard', () => {
    const t = { kind: 'alpha1', min: 0.75, max: null } as const;
    expect(evaluateTarget(t, { hr: null, alpha1: 0.6 }, null)).toBe('above');
    expect(evaluateTarget(t, { hr: null, alpha1: 0.9 }, null)).toBe('in');
    expect(evaluateTarget(t, { hr: null, alpha1: null }, null)).toBe('unknown');
    const b = { vt1: 140, vt2: 160, estimated: false };
    const z = (hr: number) => zoneOf(hr, b);
    expect(evaluateTarget({ kind: 'zone', zone: 2 }, { hr: 130, alpha1: null }, z)).toBe('below');
    expect(evaluateTarget({ kind: 'zone', zone: 2 }, { hr: 150, alpha1: null }, z)).toBe('in');
    expect(evaluateTarget({ kind: 'zone', zone: 2 }, { hr: 165, alpha1: null }, z)).toBe('above');
    expect(describeTarget(t)).toBe('α1 acima de 0,75');
  });

  it('every built-in template is valid and ids are unique', () => {
    for (const t of BUILT_IN_WORKOUTS) expect(validateTemplate(t)).toEqual([]);
    expect(new Set(BUILT_IN_WORKOUTS.map((t) => t.id)).size).toBe(BUILT_IN_WORKOUTS.length);
    expect(validateTemplate({ ...BUILT_IN_WORKOUTS[1]!, name: ' ', phases: [phase('', 0.05)] })).toHaveLength(3);
  });
});

describe('profile and zones', () => {
  const now = new Date('2026-10-17T12:00:00');

  it('max HR: measured wins, otherwise Tanaka from age', () => {
    expect(effectiveMaxHr({ ...EMPTY_PROFILE, birthYear: 1996 }, now)).toEqual({ bpm: 187, estimated: true });
    expect(effectiveMaxHr({ ...EMPTY_PROFILE, birthYear: 1996, maxHr: 195 }, now)).toEqual({ bpm: 195, estimated: false });
    expect(effectiveMaxHr(EMPTY_PROFILE, now)).toBeNull();
  });

  it('zones prefer test thresholds, fall back to max-HR ratios and say so', () => {
    expect(zoneBounds({ ...EMPTY_PROFILE, hrvt1: 142, hrvt2: 163 }, now)).toEqual({ vt1: 142, vt2: 163, estimated: false });
    expect(zoneBounds({ ...EMPTY_PROFILE, maxHr: 190 }, now)).toEqual({ vt1: 146, vt2: 169, estimated: true });
    expect(zoneBounds(EMPTY_PROFILE, now)).toBeNull();
  });

  it('time in zones caps gaps; Lucia TRIMP weights 1/2/3 per minute', () => {
    const b = { vt1: 140, vt2: 160, estimated: false };
    const hr = [{ tS: 0, bpm: 120 }, { tS: 1, bpm: 150 }, { tS: 2, bpm: 170 }, { tS: 600, bpm: 120 }];
    expect(timeInZones(hr, b)).toEqual([2, 1, 5]);
    expect(luciaTrimp([600, 600, 600])).toBe(60);
  });

  it('calories need sex, age and weight; plausible for an hour at 140 bpm', () => {
    const hr = Array.from({ length: 3600 }, (_, i) => ({ tS: i, bpm: 140 }));
    const p = { ...EMPTY_PROFILE, sex: 'male' as const, birthYear: 1996, weightKg: 75 };
    const kcal = caloriesFromHr(hr, p, now)!;
    expect(kcal).toBeGreaterThan(600);
    expect(kcal).toBeLessThan(900);
    expect(caloriesFromHr(hr, { ...p, weightKg: null }, now)).toBeNull();
  });

  it('sanitize drops implausible values instead of storing them', () => {
    const p = sanitizeProfile({ ...EMPTY_PROFILE, name: '  Ana  ', weightKg: 900, maxHr: 190, restHr: 3 });
    expect(p).toMatchObject({ name: 'Ana', weightKg: null, maxHr: 190, restHr: null });
  });
});

describe('estimateThresholds', () => {
  // α1 falls linearly with HR: α1 = 1.2 − 0.015·(HR − 120) → 0.75 at 150, 0.50 at ~166.7.
  function ramp(hrMax: number) {
    const hr: { tS: number; bpm: number }[] = [];
    const dfa: DfaPoint[] = [];
    for (let t = 0; t <= 1500; t++) hr.push({ tS: t, bpm: 100 + ((hrMax - 100) * t) / 1500 });
    for (let t = 120; t <= 1500; t += 5) {
      const h = 100 + ((hrMax - 100) * (t - 60)) / 1500;
      dfa.push({ tS: t, alpha1: Math.min(1.2, 1.2 - 0.015 * (h - 120)), artifactPct: 0, beats: 200 });
    }
    return { hr, dfa };
  }

  it('recovers HRVT1 and HRVT2 from a clean ramp', () => {
    const { hr, dfa } = ramp(175);
    const e = estimateThresholds(dfa, hr)!;
    expect(e.hrvt1).toBeGreaterThanOrEqual(149);
    expect(e.hrvt1).toBeLessThanOrEqual(151);
    expect(e.hrvt2).toBeGreaterThanOrEqual(166);
    expect(e.hrvt2).toBeLessThanOrEqual(168);
    expect(e.r2).toBeGreaterThan(0.95);
  });

  it('does not invent HRVT2 when the ramp stopped early, and explains why', () => {
    const { hr, dfa } = ramp(155);
    const e = estimateThresholds(dfa, hr)!;
    expect(e.hrvt1).not.toBeNull();
    expect(e.hrvt2).toBeNull();
    expect(e.notes.join(' ')).toMatch(/não chegou perto de 0,50/);
  });

  it('returns null without enough valid windows', () => {
    expect(estimateThresholds([], [])).toBeNull();
  });
});

describe('orthostatic test', () => {
  function beats(lyingRr: number, standingRr: number, wobble: number) {
    const s = new RrSeries();
    let t = 0;
    let i = 0;
    while (t < 180_000) {
      const base = t < 90_000 ? lyingRr : t < 100_000 ? standingRr - 150 : standingRr;
      const rr = base + (i++ % 2 ? wobble : -wobble);
      s.push(rr);
      t += rr;
    }
    return s.all();
  }

  it('lying HRV, standing HR and the orthostatic peak', () => {
    const out = analyzeOrthostatic(beats(1100, 800, 30), 90_000);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.lyingHr).toBeCloseTo(60000 / 1100, 0);
    expect(out.result.standingHr).toBeCloseTo(75, 0);
    expect(out.result.peakHr).toBeGreaterThan(out.result.standingHr);
    expect(out.result.lyingRmssd).toBeCloseTo(60, 0);
    expect(out.result.lnRmssd).toBeCloseTo(Math.log(60), 1);
  });

  it('refuses a test cut short', () => {
    const short = beats(1100, 800, 30).filter((b) => b.tMs < 100_000);
    expect(analyzeOrthostatic(short, 90_000)).toMatchObject({ ok: false });
  });

  it('readiness compares with the previous 7 days only, after 3 measurements', () => {
    const r = (id: string, day: number, ln: number): OrthostaticResult => ({
      id, dateIso: `2026-10-${String(day).padStart(2, '0')}T06:00:00.000Z`, lyingHr: 50, lyingRmssd: Math.exp(ln), lnRmssd: ln, standingHr: 70, standingRmssd: 30, peakHr: 90, artifactPct: 0,
    });
    const history = [r('a', 1, 2.0), r('b', 10, 4.0), r('c', 11, 4.1), r('d', 12, 3.9)];
    expect(readiness(r('t', 12, 3.9), history.slice(0, 3))).toEqual({ state: 'calibrating', needed: 1 });
    expect(readiness(r('t', 13, 4.0), history)).toMatchObject({ state: 'normal' });
    expect(readiness(r('t', 13, 3.5), history)).toMatchObject({ state: 'low' });
  });
});

describe('week plan and trends', () => {
  const monday = new Date('2026-10-12T00:00:00');

  it('marks planned workouts done by matching template sessions on the same day', () => {
    const tue = makeRecord('s1', new Date('2026-10-13T18:00:00').toISOString(), {
      workout: { templateId: 'intervals-4x4', name: 'x', kind: 'intervals', phases: [] },
    });
    const sunFree = makeRecord('s2', new Date('2026-10-18T09:00:00').toISOString());
    const week = resolveWeek(POLARIZED_WEEK, monday, [tue, sunFree], BUILT_IN_WORKOUTS, new Date('2026-10-15T12:00:00'));
    expect(week.map((d) => d.day)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
    expect(week[1]!.planned[0]).toMatchObject({ templateId: 'intervals-4x4', doneBy: 's1' });
    expect(week[2]!.planned[0]!.doneBy).toBeNull();
    expect(week[6]!.sessions.map((s) => s.id)).toEqual(['s2']);
    expect(week[6]!.planned[0]!.doneBy).toBeNull(); // a free ride does not tick off "Base"
    expect(week[3]!.isToday).toBe(true);
    expect(week[2]!.isPast).toBe(true);
    expect(mondayOf(new Date('2026-10-18T23:00:00')).getDate()).toBe(12);
  });

  it('weekly loads and fitness series react to sessions', () => {
    const b = { vt1: 140, vt2: 160, estimated: false };
    const hr = Array.from({ length: 1800 }, (_, i) => ({ tS: i, bpm: 150 }));
    const s = makeRecord('w', new Date('2026-10-14T18:00:00').toISOString(), { hr, durationS: 1800 });
    const weeks = weeklyLoads([s], b, 2, new Date('2026-10-17T12:00:00'));
    expect(weeks.map((w) => w.monday)).toEqual(['2026-10-05', '2026-10-12']);
    expect(weeks[1]!.trimp).toBeCloseTo(60, 0); // 30 min × 2
    expect(weeks[0]!.sessions).toBe(0);
    const fit = fitnessSeries([s], b, 7, new Date('2026-10-17T12:00:00'));
    expect(fit).toHaveLength(7);
    const day = fit.find((p) => p.day === '2026-10-14')!;
    expect(day.load).toBeCloseTo(60, 0);
    expect(fit.at(-1)!.atl).toBeGreaterThan(fit.at(-1)!.ctl);
  });

  it('threshold history keeps sessions that produced a threshold, in date order', () => {
    const t = { hrvt1: 150, hrvt2: null, slope: -0.01, intercept: 2, r2: 0.9, points: 20, alphaMax: 1.1, alphaMin: 0.6, hrMin: 120, hrMax: 160, notes: [] };
    const h = thresholdHistory([
      makeRecord('b', '2026-10-10T08:00:00.000Z', { thresholds: t }),
      makeRecord('a', '2026-09-10T08:00:00.000Z', { thresholds: { ...t, hrvt1: 146 } }),
      makeRecord('c', '2026-10-11T08:00:00.000Z'),
    ]);
    expect(h.map((p) => [p.sessionId, p.hrvt1])).toEqual([['a', 146], ['b', 150]]);
  });
});

describe('session analysis', () => {
  it('HR drift compares halves of the steady block', () => {
    const hr = Array.from({ length: 3600 }, (_, i) => ({ tS: i, bpm: i < 1800 ? 140 : 147 }));
    expect(hrDriftPct(hr, 0, 3600)).toBeCloseTo(5, 5);
    expect(hrDriftPct(hr, 0, 600)).toBeNull();
    const s = makeRecord('d', '2026-10-10T08:00:00.000Z', {
      segments: [{ startMs: 0, endMs: 3_600_000 }],
      workout: { templateId: 'base-60', name: 'b', kind: 'endurance', phases: [phase('Aq', 10), phase('Base', 45), phase('Des', 5)] },
    });
    expect(driftWindow(s)).toEqual({ fromS: 600, toS: 3300 });
  });

  it('HR recovery 60 s after each hard → easy transition', () => {
    const phases = [phase('Tiro', 4, { kind: 'zone', zone: 3 }), phase('Rec', 3, { kind: 'zone', zone: 1 })];
    const hr = Array.from({ length: 420 }, (_, t) => ({ tS: t, bpm: t < 240 ? 170 : Math.max(120, 170 - (t - 240)) }));
    const s = makeRecord('r', '2026-10-10T08:00:00.000Z', {
      hr, segments: [{ startMs: 0, endMs: 420_000 }], workout: { templateId: null, name: '4x4', kind: 'intervals', phases },
    });
    const rec = hrRecoveries(s);
    expect(rec).toHaveLength(1);
    expect(rec[0]!.afterPhase).toBe('Tiro');
    expect(rec[0]!.dropBpm).toBeCloseTo(50, 0);
  });
});

import { laps } from '../src/domain/analysis/session-analysis';

describe('laps', () => {
  it('splits by phases and markers, with HR per lap', () => {
    const hr = Array.from({ length: 600 }, (_, t) => ({ tS: t, bpm: t < 120 ? 100 : 150 }));
    const s = makeRecord('l', '2026-10-10T08:00:00.000Z', {
      hr, segments: [{ startMs: 0, endMs: 600_000 }], markers: [{ tMs: 300_000, label: 'Volta 1' }],
      workout: { templateId: null, name: 'x', kind: 'endurance', phases: [phase('Aq', 2), phase('Base', 8)] },
    });
    const l = laps(s);
    expect(l.map((x) => [x.name, x.activeS])).toEqual([['Aq', 120], ['Base', 180], ['Base · Volta 1', 300]]);
    expect(l[0]!.meanBpm).toBe(100);
    expect(l[2]!.maxBpm).toBe(150);
  });
});
