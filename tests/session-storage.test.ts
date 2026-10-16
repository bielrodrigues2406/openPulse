import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbSessionRepository } from '../src/adapters/indexeddb-session.repository';
import { RrSeries } from '../src/domain/physiology/rr-quality';
import { SESSION_SCHEMA_VERSION, type SessionRecord, summarize } from '../src/domain/session/recorded-session';
import { ecgToCsv, fileStem, hrToCsv, rrToCsv, sessionToJson } from '../src/domain/session/session-export';

function record(id: string, startedAtIso: string, rrValues = [800, 810, 400, 805, 790], ecgSampleCount = 4): SessionRecord {
  const rr = new RrSeries();
  rrValues.forEach((v) => rr.push(v));
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    startedAtIso,
    durationS: 4.2,
    source: 'sim',
    deviceName: 'Simulador H10',
    ecgHz: 130,
    ecgSampleCount,
    hr: [{ tS: 1, bpm: 74 }, { tS: 2.5, bpm: 76 }],
    rr: [...rr.all()],
  };
}

describe('IndexedDbSessionRepository', () => {
  it('round-trips record and ECG, lists newest first, deletes both', async () => {
    const repo = new IndexedDbSessionRepository(new IDBFactory());
    const older = record('a', '2026-10-15T08:00:00.000Z');
    const newer = record('b', '2026-10-16T08:00:00.000Z');
    await repo.save(older, Int32Array.of(1, -2, 3, -4));
    await repo.save(newer, Int32Array.of(5, 6, 7, 8));

    expect((await repo.list()).map((s) => s.id)).toEqual(['b', 'a']);
    expect(await repo.list()).toContainEqual(older);
    expect([...(await repo.ecg('a'))]).toEqual([1, -2, 3, -4]);

    await repo.delete('a');
    expect((await repo.list()).map((s) => s.id)).toEqual(['b']);
    expect((await repo.ecg('a')).length).toBe(0);
  });

  it('checkpointing the same id overwrites instead of duplicating', async () => {
    const repo = new IndexedDbSessionRepository(new IDBFactory());
    await repo.save(record('x', '2026-10-16T08:00:00.000Z', [800, 810], 2), Int32Array.of(1, 2));
    await repo.save(record('x', '2026-10-16T08:00:00.000Z', [800, 810, 820], 3), Int32Array.of(1, 2, 3));
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.rr).toHaveLength(3);
    expect([...(await repo.ecg('x'))]).toEqual([1, 2, 3]);
  });

  it('stores only the visible part of an ECG view, not its backing buffer', async () => {
    const repo = new IndexedDbSessionRepository(new IDBFactory());
    const backing = Int32Array.of(9, 9, 1, 2, 9);
    await repo.save(record('v', '2026-10-16T08:00:00.000Z', [800], 2), backing.subarray(2, 4));
    expect([...(await repo.ecg('v'))]).toEqual([1, 2]);
  });

  it('refuses an ECG that disagrees with the record', async () => {
    const repo = new IndexedDbSessionRepository(new IDBFactory());
    await expect(repo.save(record('z', '2026-10-16T08:00:00.000Z'), Int32Array.of(1))).rejects.toThrow(RangeError);
  });
});

describe('export formats', () => {
  const s = record('e', '2026-10-16T08:00:00.000Z');

  it('R-R CSV has one row per beat, rejected beats flagged rather than dropped', () => {
    const lines = rrToCsv(s).trimEnd().split('\n');
    expect(lines[0]).toBe('t_ms,rr_ms,accepted');
    expect(lines).toHaveLength(1 + s.rr.length);
    expect(lines.slice(1).map((l) => l.split(',')[2])).toEqual(s.rr.map((b) => (b.accepted ? '1' : '0')));
  });

  it('R-R CSV round-trips values with dot decimals', () => {
    const odd = { ...s, rr: [{ tMs: 1000.25, rrMs: 1000.244140625, accepted: true }] };
    const [, row] = rrToCsv(odd).trimEnd().split('\n');
    const [t, rr] = row!.split(',').map(Number);
    expect(t).toBeCloseTo(1000.25, 1);
    expect(rr).toBeCloseTo(1000.244, 3);
  });

  it('FC CSV lists every sample', () => {
    expect(hrToCsv(s)).toBe('t_s,bpm\n1,74\n2.5,76\n');
  });

  it('ECG CSV derives time from sample index and sample rate', () => {
    expect(ecgToCsv(s, Int32Array.of(10, -20, 30, -40))).toBe('t_s,ecg_uv\n0,10\n0.0077,-20\n0.0154,30\n0.0231,-40\n');
    expect(() => ecgToCsv(s, Int32Array.of(1))).toThrow(RangeError);
  });

  it('JSON round-trips the record and embeds the same summary the UI shows', () => {
    const parsed = JSON.parse(sessionToJson(s)) as SessionRecord & { summary: unknown };
    const { summary, ...rest } = parsed;
    expect(rest).toEqual(s);
    expect(summary).toEqual(summarize(s));
  });

  it('file stem is filesystem-safe', () => {
    expect(fileStem(s)).toMatch(/^openpulse-\d{4}-\d{2}-\d{2}-\d{4}$/);
  });
});
