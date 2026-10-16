import { describe, expect, it } from 'vitest';
import { RrSeries, artifactRate, rmssd } from '../src/domain/physiology/rr-quality';

const feed = (values: number[]) => {
  const s = new RrSeries();
  values.forEach((v) => s.push(v));
  return s;
};

describe('RR artifact gate', () => {
  it('rejects physiologically impossible intervals', () => {
    const beats = feed([200, 2100, 800]).all();
    expect(beats.map((b) => b.accepted)).toEqual([false, false, true]);
  });

  it('rejects an ectopic beat deviating >20% from the recent median, then recovers', () => {
    const beats = feed([800, 810, 790, 805, 795, 560, 1040, 800]).all();
    expect(beats.map((b) => b.accepted)).toEqual([true, true, true, true, true, false, false, true]);
  });

  it('time advances by every beat, including rejected ones', () => {
    expect(feed([800, 200, 800]).all().at(-1)!.tMs).toBe(1800);
  });
});

describe('rmssd', () => {
  it('matches the definition on clean data', () => {
    // diffs: 20, -40, 30 → sqrt((400+1600+900)/3)
    expect(rmssd(feed([800, 820, 780, 810]).all())).toBeCloseTo(Math.sqrt(2900 / 3), 10);
  });

  it('ignores pairs touching a rejected beat', () => {
    // valid diffs: 20, -40, 30, -10; both pairs around the 400 ms ectopic are skipped
    expect(rmssd(feed([800, 820, 780, 810, 800, 400, 810]).all())).toBeCloseTo(Math.sqrt(3000 / 4), 10);
  });

  it('returns null when there is not enough data', () => {
    expect(rmssd(feed([800]).all())).toBeNull();
    expect(rmssd(feed([800, 810]).all())).toBeNull();
  });

  it('is invariant to a constant shift of all intervals', () => {
    const a = [800, 830, 790, 815, 805, 820];
    expect(rmssd(feed(a.map((x) => x + 100)).all())).toBeCloseTo(rmssd(feed(a).all())!, 10);
  });
});

describe('artifactRate', () => {
  it('counts rejected fraction', () => {
    expect(artifactRate(feed([800, 100, 800, 3000]).all())).toBe(0.5);
    expect(artifactRate([])).toBeNull();
  });
});
