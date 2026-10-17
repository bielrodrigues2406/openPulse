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

describe('sustained HR change', () => {
  it('accepts a new level after 5 consistent beats instead of rejecting it forever', () => {
    const beats = feed([...Array(10).fill(1100), ...Array(12).fill(650)]).all();
    const after = beats.slice(10).map((b) => b.accepted);
    expect(after.slice(0, 4)).toEqual([false, false, false, false]);
    expect(after.slice(4).every(Boolean)).toBe(true);
  });

  it('isolated ectopics in between normal beats are still rejected', () => {
    const beats = feed([800, 810, 790, 805, 795, 500, 800, 1100, 805, 500, 800]).all();
    expect(beats.map((b) => b.accepted)).toEqual([true, true, true, true, true, false, true, false, true, false, true]);
  });
});

describe('segments', () => {
  it('resumeAt jumps the clock, restarts the median, and flags the first beat after the gap', () => {
    const s = feed([800, 800, 800]);
    s.resumeAt(60_000);
    const b = s.push(500);
    expect(b).toMatchObject({ tMs: 60_500, accepted: true, gapBefore: true });
    expect(s.push(510).gapBefore).toBeUndefined();
    // The pair across the gap (800 → 500) is not used by RMSSD.
    expect(rmssd(s.all())).toBeCloseTo(Math.sqrt((0 + 0 + 100) / 3), 10);
  });

  it('from() rebuilds a series that continues like the original', () => {
    const a = feed([800, 810, 790, 805, 795]);
    const b = RrSeries.from(a.all());
    expect(b.push(560).accepted).toBe(a.push(560).accepted);
    expect(b.all().at(-1)!.tMs).toBe(a.all().at(-1)!.tMs);
  });
});
