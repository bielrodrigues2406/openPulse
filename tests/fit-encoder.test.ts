import FitParser from 'fit-file-parser';
import { describe, expect, it } from 'vitest';
import { RrSeries } from '../src/domain/physiology/rr-quality';
import { SESSION_SCHEMA_VERSION, type SessionRecord } from '../src/domain/session/recorded-session';
import { activeToWallMs, encodeFit, fitCrc } from '../src/domain/session/fit-encoder';
import { phase } from '../src/domain/workouts/workout';

function session(): SessionRecord {
  // 2 segments: 0–120 s and 180–300 s (a 60 s gap), 75 bpm, RR 800 ms.
  const rr = new RrSeries();
  const hr: { tS: number; bpm: number }[] = [];
  for (const [a, b] of [[0, 120_000], [180_000, 300_000]] as const) {
    rr.resumeAt(a);
    for (let t = a + 800; t <= b; t += 800) rr.push(800);
    for (let s = a / 1000 + 1; s <= b / 1000; s++) hr.push({ tS: s, bpm: s < 60 ? 70 : 80 });
  }
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: 'fit',
    startedAtIso: '2026-10-16T10:00:00.000Z',
    status: 'finished',
    durationS: 240,
    segments: [{ startMs: 0, endMs: 120_000 }, { startMs: 180_000, endMs: 300_000 }],
    source: 'sim',
    deviceName: 'Sim',
    sport: 'bike-indoor',
    workout: { templateId: 't', name: 'T', kind: 'endurance', phases: [phase('A', 1), phase('B', 3)] },
    markers: [{ tMs: 200_000, label: 'volta' }],
    rpe: 5,
    notes: '',
    ecgHz: 130,
    ecgSampleCount: 0,
    ecgSegments: [],
    ecgChunks: 0,
    hr,
    rr: [...rr.all()],
    dfa: [],
    inertial: [{ tS: 100, breathsPerMin: 20, breathSource: 'acc', breathConfidence: 0.8, rpm: 90, rpmConfidence: 0.9, swayMg: 15 }],
    thresholds: null,
  };
}

async function parse(bytes: Uint8Array) {
  const parser = new FitParser({ force: false, strict: true, mode: 'list' });
  return parser.parseAsync(bytes.slice().buffer);
}

describe('encodeFit', () => {
  it('produces a file that a strict independent FIT parser accepts (both CRCs valid)', async () => {
    const bytes = encodeFit(session());
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('.FIT');
    expect(fitCrc(bytes)).toBe(0); // CRC over data + appended CRC is zero
    await expect(parse(bytes)).resolves.toBeTruthy();
  });

  it('carries sport, durations, HR, laps and the session start', async () => {
    const fit = await parse(encodeFit(session(), { calories: 321 }));
    const s = fit.sessions![0]!;
    expect(s.total_calories).toBe(321);
    expect(s.sport).toBe('cycling');
    expect(s.sub_sport).toBe('indoor_cycling');
    expect(s.total_timer_time).toBe(240);
    expect(s.total_elapsed_time).toBe(300);
    expect(new Date(s.start_time as unknown as string).toISOString()).toBe('2026-10-16T10:00:00.000Z');
    expect(s.max_heart_rate).toBe(80);
    // Laps at phase end (60 s active → 60 s wall), marker at 200 s, end at 300 s.
    expect(fit.laps!.map((l) => l.total_elapsed_time)).toEqual([60, 140, 100]);
  });

  it('writes one record per second only inside segments, nothing in the gap', async () => {
    const fit = await parse(encodeFit(session()));
    const times = fit.records!.map((r) => (new Date(r.timestamp as unknown as string).getTime() - Date.parse('2026-10-16T10:00:00Z')) / 1000);
    expect(times.some((t) => t > 120 && t < 180)).toBe(false);
    expect(times.filter((t) => t <= 120)).toHaveLength(121);
    expect(fit.records!.find((r) => r.heart_rate !== undefined)!.heart_rate).toBe(70);
    expect(fit.records!.filter((r) => r.cadence === 90).length).toBeGreaterThan(0);
  });

  it('keeps every R-R interval in HRV messages', async () => {
    const s = session();
    const fit = await parse(encodeFit(s));
    const rr = (fit.hrv ?? []).flatMap((h) => (h.time as number[]).filter((v) => v < 65));
    expect(rr).toHaveLength(s.rr.length);
    expect(rr.every((v) => Math.abs(v - 0.8) < 1e-9)).toBe(true);
  });
});

describe('activeToWallMs', () => {
  it('skips gaps between segments', () => {
    const segs = [{ startMs: 0, endMs: 60_000 }, { startMs: 120_000, endMs: 180_000 }];
    expect(activeToWallMs(segs, 30)).toBe(30_000);
    expect(activeToWallMs(segs, 90)).toBe(150_000);
    expect(activeToWallMs(segs, 200)).toBeNull();
  });
});
