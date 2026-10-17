import { describe, expect, it } from 'vitest';
import { DFA_MIN_BEATS, DfaTracker, correctedRr, dfaAlpha1 } from '../src/domain/physiology/dfa-alpha1';
import type { RrBeat } from '../src/domain/physiology/rr-quality';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function gaussian(r: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}
const white = (n: number, seed: number) => {
  const r = rng(seed);
  return Array.from({ length: n }, () => 800 + 30 * gaussian(r));
};
const brown = (n: number, seed: number) => {
  let acc = 0;
  return white(n, seed).map((v) => 800 + (acc += v - 800));
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('dfaAlpha1', () => {
  // Known theoretical exponents; short-scale DFA has finite-size bias, so we test averages over seeds.
  it('white noise → ≈0.5', () => {
    const a = mean(Array.from({ length: 30 }, (_, s) => dfaAlpha1(white(150, s + 1))));
    expect(a).toBeGreaterThan(0.4);
    expect(a).toBeLessThan(0.6);
  });

  it('Brownian motion → ≈1.5', () => {
    const a = mean(Array.from({ length: 30 }, (_, s) => dfaAlpha1(brown(150, s + 1))));
    expect(a).toBeGreaterThan(1.35);
    expect(a).toBeLessThan(1.65);
  });

  it('is invariant to scaling and offset of the series', () => {
    const x = white(120, 7);
    const a = dfaAlpha1(x);
    expect(dfaAlpha1(x.map((v) => v * 3.7))).toBeCloseTo(a, 10);
    expect(dfaAlpha1(x.map((v) => v + 250))).toBeCloseTo(a, 10);
  });

  it('a linear trend added to the series does not change alpha1 much (detrending works)', () => {
    const x = white(120, 9);
    const trended = x.map((v, i) => v + i * 0.5);
    expect(Math.abs(dfaAlpha1(trended) - dfaAlpha1(x))).toBeLessThan(0.1);
  });

  it('refuses series too short for the largest scale and flat series', () => {
    expect(() => dfaAlpha1(white(DFA_MIN_BEATS - 1, 1))).toThrow(RangeError);
    expect(() => dfaAlpha1(new Array(100).fill(800))).toThrow(/no fluctuation/);
  });
});

const beat = (tMs: number, rrMs: number, accepted = true): RrBeat => ({ tMs, rrMs, accepted });

describe('correctedRr', () => {
  it('interpolates rejected beats linearly between accepted neighbours', () => {
    expect(correctedRr([beat(0, 800), beat(0, 300, false), beat(0, 1500, false), beat(0, 830)])).toEqual([800, 810, 820, 830]);
  });
  it('holds edges at the nearest accepted value', () => {
    expect(correctedRr([beat(0, 1, false), beat(0, 800), beat(0, 900), beat(0, 2, false)])).toEqual([800, 800, 900, 900]);
  });
  it('returns null when nothing is accepted and keeps clean series unchanged', () => {
    expect(correctedRr([beat(0, 1, false)])).toBeNull();
    expect(correctedRr([beat(0, 800), beat(0, 810)])).toEqual([800, 810]);
  });
});

function beatsFrom(rr: number[], rejectEvery = 0): RrBeat[] {
  let t = 0;
  return rr.map((v, i) => beat((t += v), v, rejectEvery === 0 || i % rejectEvery !== 0));
}

describe('DfaTracker', () => {
  it('emits nothing before 120 s, then one point every 5 s', () => {
    const tracker = new DfaTracker();
    const beats = beatsFrom(white(400, 3)); // ~320 s
    expect(tracker.push(beats.filter((b) => b.tMs < 120_000))).toEqual([]);
    const pts = tracker.push(beats.filter((b) => b.tMs >= 120_000));
    const last = beats.at(-1)!.tMs;
    expect(pts).toHaveLength(Math.floor((last - 120_000) / 5000) + 1);
    expect(pts.map((p) => p.tS)).toEqual(pts.map((_, i) => 120 + 5 * i));
  });

  it('gives the same result whether beats arrive one by one or all at once', () => {
    const beats = beatsFrom(white(300, 5));
    const bulk = new DfaTracker().push(beats);
    const t = new DfaTracker();
    const single = beats.flatMap((b) => t.push([b]));
    expect(single).toEqual(bulk);
  });

  it('matches dfaAlpha1 on the exact 120 s window', () => {
    const beats = beatsFrom(white(200, 11));
    const [first] = new DfaTracker().push(beats);
    const win = beats.filter((b) => b.tMs <= 120_000).map((b) => b.rrMs);
    expect(first!.alpha1).toBeCloseTo(dfaAlpha1(win), 12);
  });

  it('withholds alpha1 when artifacts exceed 5%', () => {
    const [p] = new DfaTracker().push(beatsFrom(white(200, 2), 10)); // 10% rejected
    expect(p).toMatchObject({ alpha1: null, reason: 'artifacts' });
    expect(p!.artifactPct).toBeGreaterThan(5);
  });

  it('withholds alpha1 when the window has too few beats', () => {
    const slow = Array.from({ length: 70 }, () => 1900); // ~31 bpm → 63 beats in 120 s
    expect(new DfaTracker().push(beatsFrom(slow))[0]).toMatchObject({ alpha1: null, reason: 'too-few-beats' });
  });
});

describe('DfaTracker robustness', () => {
  it('withholds a window with no variability instead of throwing', () => {
    const [p] = new DfaTracker().push(beatsFrom(new Array(200).fill(800)));
    expect(p).toMatchObject({ alpha1: null, reason: 'no-variability' });
  });

  it('a tracker started at a segment ignores earlier beats and waits 120 s after it', () => {
    const beats = beatsFrom(white(500, 4));
    const t = new DfaTracker(100_000);
    const pts = t.push(beats);
    expect(pts[0]!.tS).toBe(220);
  });
});
