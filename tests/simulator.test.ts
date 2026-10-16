import { describe, expect, it } from 'vitest';
import { RampRrModel, mulberry32 } from '../src/adapters/simulated-h10.adapter';
import { DfaTracker, type DfaPoint } from '../src/domain/physiology/dfa-alpha1';
import { RrSeries } from '../src/domain/physiology/rr-quality';

function run(seed: number, minutes: number): DfaPoint[] {
  const model = new RampRrModel();
  const random = mulberry32(seed);
  const series = new RrSeries();
  const tracker = new DfaTracker();
  const out: DfaPoint[] = [];
  for (let t = 600; t < minutes * 60_000; ) {
    const rr = model.next(t, random);
    out.push(...tracker.push([series.push(rr)]));
    t += rr;
  }
  return out;
}

describe('simulated ramp test', () => {
  it('is deterministic for a seed', () => {
    expect(run(3, 4)).toEqual(run(3, 4));
  });

  it('drives DFA α1 from well above VT1 to below it, with artifacts under the 5% gate', () => {
    const pts = run(1, 17);
    const early = pts.filter((p) => p.tS < 300);
    const late = pts.filter((p) => p.tS > 900);
    const avg = (ps: DfaPoint[]) => ps.reduce((a, p) => a + (p.alpha1 ?? NaN), 0) / ps.length;
    expect(avg(early)).toBeGreaterThan(1.0);
    expect(avg(late)).toBeLessThan(0.7);
    expect(pts.every((p) => p.alpha1 !== null)).toBe(true);
  });
});
