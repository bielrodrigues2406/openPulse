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

import { vi } from 'vitest';
import { SimulatedH10Adapter } from '../src/adapters/simulated-h10.adapter';
import { InertialTracker } from '../src/domain/physiology/inertial-fusion';

describe('simulated accelerometer', () => {
  it('feeds the inertial pipeline with ~90 rpm and the ramp breathing rate', async () => {
    vi.useFakeTimers();
    const sim = new SimulatedH10Adapter();
    const tracker = new InertialTracker();
    const points: ReturnType<InertialTracker['pushAcc']> = [];
    sim.onEvent((e) => {
      if (e.kind === 'acc') points.push(...tracker.pushAcc(e.samplesMg));
    });
    await sim.connect();
    await vi.advanceTimersByTimeAsync(120_000);
    sim.disconnect();
    vi.useRealTimers();
    const last = points.at(-1)!;
    expect(last.rpm!).toBeGreaterThan(85);
    expect(last.rpm!).toBeLessThan(95);
    // At t = 2 min the simulated rate is 14 + 22·(2/15) ≈ 16.9 /min (averaged over the window).
    expect(last.breathsPerMin!).toBeGreaterThan(15);
    expect(last.breathsPerMin!).toBeLessThan(18.5);
  });
});
