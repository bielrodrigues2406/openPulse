import { describe, expect, it } from 'vitest';
import {
  InertialTracker,
  estimateBreathingFromAcc,
  estimateBreathingFromRr,
  estimateCadence,
  fuseBreathing,
} from '../src/domain/physiology/inertial-fusion';
import { RrSeries } from '../src/domain/physiology/rr-quality';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) - 0.5;
}
const sine = (n: number, fs: number, f: number, amp: number, phase = 0) =>
  Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * f * (i / fs) + phase));
const add = (...xs: number[][]) => xs[0]!.map((_, i) => xs.reduce((s, x) => s + x[i]!, 0));
const noise = (n: number, amp: number, seed: number) => {
  const r = rng(seed);
  return Array.from({ length: n }, () => amp * r());
};

describe('estimateCadence', () => {
  const fs = 25;
  const n = 250;
  it('lateral at crank rate + vertical at twice it → 90 rpm, high confidence, lateral axis found', () => {
    const c = estimateCadence([add(sine(n, fs, 1.5, 30), noise(n, 4, 1)), add(sine(n, fs, 3, 15), noise(n, 4, 2)), noise(n, 4, 3)], fs);
    expect(c!.crankHz * 60).toBeCloseTo(90, 0);
    expect(c!.confidence).toBeGreaterThan(0.8);
    expect(c!.lateralAxis).toBe(0);
  });
  it('only the vertical stroke rhythm (3 Hz) → still 90 rpm, lower confidence', () => {
    const c = estimateCadence([noise(n, 4, 1), add(sine(n, fs, 3, 20), noise(n, 4, 2)), noise(n, 4, 3)], fs);
    expect(c!.crankHz * 60).toBeCloseTo(90, 0);
    expect(c!.confidence).toBeLessThan(0.6);
  });
  it('does not depend on which axis is which', () => {
    const c = estimateCadence([noise(n, 4, 1), add(sine(n, fs, 3, 15), noise(n, 4, 2)), add(sine(n, fs, 1.4, 30), noise(n, 4, 3))], fs);
    expect(c!.crankHz * 60).toBeCloseTo(84, 0);
    expect(c!.lateralAxis).toBe(2);
  });
  it('deep breathing on the chest axis does not pass for a sub-harmonic (no false halving)', () => {
    const c = estimateCadence(
      [add(sine(n, fs, 1.5, 25), noise(n, 4, 1)), add(sine(n, fs, 3, 12), noise(n, 4, 2)), add(sine(n, fs, 0.45, 40), noise(n, 4, 3))],
      fs,
    );
    expect(c!.crankHz * 60).toBeCloseTo(90, 0);
  });

  it('returns null when there is no rhythm', () => {
    expect(estimateCadence([noise(n, 10, 1), noise(n, 10, 2), noise(n, 10, 3)], fs)).toBeNull();
  });
});

describe('breathing', () => {
  it('finds 18 breaths/min on the chest axis while ignoring a pedalling rhythm', () => {
    const fs = 5;
    const n = 160;
    const z = add(sine(n, fs, 0.3, 40), noise(n, 5, 4));
    const x = add(sine(n, fs, 0.75, 30), noise(n, 5, 5)); // 45 rpm crank leaks into the band
    const p = estimateBreathingFromAcc([x, noise(n, 5, 6), z], fs, 0.75);
    expect(p!.freq * 60).toBeCloseTo(18, 0);
  });

  it('reads 15 breaths/min from respiratory sinus arrhythmia in R-R', () => {
    const s = new RrSeries();
    let t = 0;
    while (t < 60_000) {
      const rr = 800 + 40 * Math.sin(2 * Math.PI * 0.25 * (t / 1000));
      s.push(rr);
      t += rr;
    }
    expect(estimateBreathingFromRr(s.all())!.freq * 60).toBeCloseTo(15, 0);
  });

  it('fusion: agreeing sources average and gain confidence; weak sources give null', () => {
    const both = fuseBreathing({ freq: 0.3, prominence: 50 }, { freq: 0.31, prominence: 20 });
    expect(both.breathSource).toBe('both');
    expect(both.breathsPerMin!).toBeGreaterThan(18);
    expect(both.breathsPerMin!).toBeLessThan(18.6);
    const disagree = fuseBreathing({ freq: 0.3, prominence: 50 }, { freq: 0.5, prominence: 20 });
    expect(disagree.breathSource).toBe('acc');
    expect(disagree.breathConfidence).toBeLessThan(both.breathConfidence);
    expect(fuseBreathing({ freq: 0.3, prominence: 2 }, null)).toEqual({ breathsPerMin: null, breathSource: null, breathConfidence: 0 });
  });
});

describe('InertialTracker', () => {
  it('end to end: 200 Hz stream → points every 5 s with cadence, breathing and sway', () => {
    const tracker = new InertialTracker();
    const r = rng(9);
    const frame: number[] = [];
    const points = [];
    for (let i = 0; i < 200 * 60; i++) {
      const t = i / 200;
      frame.push(25 * Math.sin(2 * Math.PI * 1.5 * t) + 3 * r(), -980 + 12 * Math.sin(2 * Math.PI * 3 * t) + 3 * r(), 60 + 30 * Math.sin(2 * Math.PI * 0.3 * t) + 3 * r());
      if (frame.length === 36 * 3) points.push(...tracker.pushAcc(frame.splice(0)));
    }
    expect(points.map((p) => p.tS)).toEqual([10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60].slice(0, points.length));
    expect(points.length).toBeGreaterThanOrEqual(10);
    const last = points.at(-1)!;
    expect(last.rpm!).toBeCloseTo(90, 0);
    expect(last.breathsPerMin!).toBeCloseTo(18, 0);
    expect(last.swayMg!).toBeGreaterThan(14);
    expect(last.swayMg!).toBeLessThan(22); // RMS of a 25 mG sine ≈ 17.7
    // Breathing needs 32 s of motion; before that only cadence is reported.
    expect(points[0]!.breathsPerMin).toBeNull();
    expect(points[0]!.rpm).not.toBeNull();
  });
});
