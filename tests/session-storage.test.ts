import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { LibraryRepository, MorningRepository, SessionRepository, openDb } from '../src/adapters/storage';
import { RrSeries } from '../src/domain/physiology/rr-quality';
import { SESSION_SCHEMA_VERSION, type SessionRecord, summarize, upgradeRecord } from '../src/domain/session/recorded-session';
import { dfaToCsv, ecgToCsv, fileStem, hrToCsv, inertialToCsv, rrToCsv, sessionToJson } from '../src/domain/session/session-export';
import { EMPTY_PROFILE } from '../src/domain/athlete/profile';
import { POLARIZED_WEEK } from '../src/domain/workouts/week-plan';

export function makeRecord(id: string, startedAtIso: string, over: Partial<SessionRecord> = {}): SessionRecord {
  const rr = new RrSeries();
  [800, 810, 400, 805, 790].forEach((v) => rr.push(v));
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    startedAtIso,
    status: 'finished',
    durationS: 4.2,
    segments: [{ startMs: 0, endMs: 4200 }],
    source: 'sim',
    deviceName: 'Simulador H10',
    sport: 'bike-indoor',
    workout: null,
    markers: [],
    rpe: null,
    notes: '',
    ecgHz: 130,
    ecgSampleCount: 4,
    ecgSegments: [{ startMs: 0, samples: 4 }],
    ecgChunks: 1,
    hr: [{ tS: 1, bpm: 74 }, { tS: 2.5, bpm: 76 }],
    rr: [...rr.all()],
    dfa: [
      { tS: 120, alpha1: 1.05, artifactPct: 0.8, beats: 140 },
      { tS: 125, alpha1: null, reason: 'artifacts', artifactPct: 6.2, beats: 141 },
    ],
    inertial: [],
    thresholds: null,
    ...over,
  };
}

const fresh = () => openDb(new IDBFactory());

describe('SessionRepository', () => {
  it('round-trips records, appends ECG chunks in order, lists newest first, deletes everything', async () => {
    const repo = new SessionRepository(fresh());
    const a = makeRecord('a', '2026-10-15T08:00:00.000Z', { ecgSampleCount: 2, ecgChunks: 1 });
    await repo.save(a, { seq: 0, samples: Int32Array.of(1, -2) });
    await repo.save({ ...a, ecgSampleCount: 4, ecgChunks: 2 }, { seq: 1, samples: Int32Array.of(3, -4) });
    await repo.save(makeRecord('b', '2026-10-16T08:00:00.000Z'), { seq: 0, samples: Int32Array.of(9, 9, 9, 9) });

    expect((await repo.list()).map((s) => s.id)).toEqual(['b', 'a']);
    expect((await repo.get('a'))!.ecgSampleCount).toBe(4);
    expect([...(await repo.ecg('a'))]).toEqual([1, -2, 3, -4]);

    await repo.delete('a');
    expect((await repo.list()).map((s) => s.id)).toEqual(['b']);
    expect((await repo.ecg('a')).length).toBe(0);
    expect([...(await repo.ecg('b'))]).toEqual([9, 9, 9, 9]);
  });

  it('stores only the visible part of a chunk view, not its backing buffer', async () => {
    const repo = new SessionRepository(fresh());
    const backing = Int32Array.of(7, 7, 1, 2, 7);
    await repo.save(makeRecord('v', '2026-10-16T08:00:00.000Z', { ecgSampleCount: 2 }), { seq: 0, samples: backing.subarray(2, 4) });
    expect([...(await repo.ecg('v'))]).toEqual([1, 2]);
  });

  it('finds the interrupted (open) session', async () => {
    const repo = new SessionRepository(fresh());
    await repo.save(makeRecord('done', '2026-10-16T07:00:00.000Z'));
    expect(await repo.findOpen()).toBeNull();
    await repo.save(makeRecord('open', '2026-10-16T08:00:00.000Z', { status: 'open' }));
    expect((await repo.findOpen())!.id).toBe('open');
  });

  it('reads sessions written by v1/v2 (legacy ECG blob, no segments) as finished v3 records', async () => {
    const db = await fresh();
    const tx = db.transaction(['sessions', 'ecg'], 'readwrite');
    tx.objectStore('sessions').put({
      schemaVersion: 1, id: 'old', startedAtIso: '2026-10-01T08:00:00.000Z', durationS: 10, source: 'h10', deviceName: 'Polar H10',
      ecgHz: 130, ecgSampleCount: 3, hr: [], rr: [],
    });
    tx.objectStore('ecg').put(Int32Array.of(5, 6, 7).buffer, 'old');
    await new Promise((r) => (tx.oncomplete = r));
    const repo = new SessionRepository(Promise.resolve(db));
    const old = (await repo.get('old'))!;
    expect(old).toMatchObject({ schemaVersion: 3, status: 'finished', segments: [{ startMs: 0, endMs: 10_000 }], dfa: [], inertial: [], markers: [] });
    expect([...(await repo.ecg('old'))]).toEqual([5, 6, 7]);
  });
});

describe('LibraryRepository / MorningRepository', () => {
  it('defaults, then persists profile, plan, settings and custom templates', async () => {
    const db = fresh();
    const lib = new LibraryRepository(db);
    expect((await lib.profile()).hrvt1).toBeNull();
    expect((await lib.settings()).sound).toBe(true);
    await lib.setProfile({ ...EMPTY_PROFILE, restHr: 48, maxHr: 186, hrvt1: 142, hrvt2: 163 });
    await lib.setWeekPlan(POLARIZED_WEEK);
    await lib.setSettings({ sound: false, voice: false, autoConnect: false, sport: 'run', source: 'sim' });
    await lib.saveTemplate({ id: 'mine', name: 'Meu', kind: 'endurance', sport: 'bike-indoor', description: '', phases: [], builtIn: false });
    expect((await lib.profile()).hrvt1).toBe(142);
    expect(await lib.weekPlan()).toEqual(POLARIZED_WEEK);
    expect((await lib.settings()).sport).toBe('run');
    expect((await lib.templates()).map((t) => t.id)).toEqual(['mine']);
    await expect(lib.saveTemplate({ id: 'x', name: 'x', kind: 'free', sport: 'other', description: '', phases: [], builtIn: true })).rejects.toThrow();
  });

  it('morning results come back oldest first', async () => {
    const m = new MorningRepository(fresh());
    const r = { lyingHr: 50, lyingRmssd: 60, lnRmssd: Math.log(60), standingHr: 70, standingRmssd: 30, peakHr: 90, artifactPct: 0 };
    await m.save({ ...r, id: '2', dateIso: '2026-10-16T06:00:00.000Z' });
    await m.save({ ...r, id: '1', dateIso: '2026-10-15T06:00:00.000Z' });
    expect((await m.list()).map((x) => x.id)).toEqual(['1', '2']);
  });
});

describe('export formats', () => {
  const s = makeRecord('e', '2026-10-16T08:00:00.000Z');

  it('R-R CSV has one row per beat, rejected beats flagged rather than dropped', () => {
    const lines = rrToCsv(s).trimEnd().split('\n');
    expect(lines[0]).toBe('t_ms,rr_ms,accepted');
    expect(lines).toHaveLength(1 + s.rr.length);
    expect(lines.slice(1).map((l) => l.split(',')[2])).toEqual(s.rr.map((b) => (b.accepted ? '1' : '0')));
  });

  it('FC CSV lists every sample', () => {
    expect(hrToCsv(s)).toBe('t_s,bpm\n1,74\n2.5,76\n');
  });

  it('ECG CSV takes time from each segment, so a gap shows as a jump in t_s', () => {
    const gapped = { ...s, ecgSampleCount: 4, ecgSegments: [{ startMs: 0, samples: 2 }, { startMs: 60_000, samples: 2 }] };
    expect(ecgToCsv(gapped, Int32Array.of(10, -20, 30, -40))).toBe('t_s,ecg_uv\n0,10\n0.0077,-20\n60,30\n60.0077,-40\n');
    expect(() => ecgToCsv(s, Int32Array.of(1))).toThrow(RangeError);
  });

  it('DFA CSV leaves alpha1 empty and states why when a window was withheld', () => {
    expect(dfaToCsv(s)).toBe('t_s,alpha1,artifact_pct,beats,invalid_reason\n120,1.05,0.8,140,\n125,,6.2,141,artifacts\n');
  });

  it('inertial CSV leaves missing estimates empty', () => {
    const withInertial = { ...s, inertial: [{ tS: 10, breathsPerMin: null, breathSource: null, breathConfidence: 0, rpm: 88.5, rpmConfidence: 0.9, swayMg: 12.3 }] };
    expect(inertialToCsv(withInertial).split('\n')[1]).toBe('10,,,0,88.5,0.9,12.3');
  });

  it('JSON round-trips the record and embeds the same summary the UI shows', () => {
    const parsed = JSON.parse(sessionToJson(s)) as SessionRecord & { summary: unknown };
    const { summary, ...rest } = parsed;
    expect(rest).toEqual(s);
    expect(summary).toEqual(JSON.parse(JSON.stringify(summarize(s))));
  });

  it('upgrade refuses records from a newer app', () => {
    expect(() => upgradeRecord({ ...s, schemaVersion: 99 })).toThrow(/v99/);
  });

  it('file stem is filesystem-safe', () => {
    expect(fileStem(s)).toMatch(/^openpulse-\d{4}-\d{2}-\d{2}-\d{4}$/);
  });
});
