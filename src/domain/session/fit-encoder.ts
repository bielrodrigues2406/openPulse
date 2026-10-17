import type { SessionRecord } from './recorded-session';
import { totalDurationS } from '../workouts/workout';

/**
 * Minimal FIT activity writer: file_id, events, 1 Hz records (HR, cadence when confident),
 * HRV (every R-R interval, so Intervals.icu & co. can run their own DFA α1), laps from
 * workout phases and manual markers, one session, one activity.
 * Spec: Garmin FIT SDK, protocol 2.0, little-endian.
 */

const FIT_EPOCH_S = 631_065_600; // 1989-12-31T00:00:00Z in Unix seconds

type FieldType = 'enum' | 'uint8' | 'uint16' | 'uint32' | 'uint32z';
const BASE: Record<FieldType, { id: number; size: number; invalid: number }> = {
  enum: { id: 0x00, size: 1, invalid: 0xff },
  uint8: { id: 0x02, size: 1, invalid: 0xff },
  uint16: { id: 0x84, size: 2, invalid: 0xffff },
  uint32: { id: 0x86, size: 4, invalid: 0xffffffff },
  uint32z: { id: 0x8c, size: 4, invalid: 0 },
};

interface FieldDef {
  readonly num: number;
  readonly type: FieldType;
  readonly count?: number;
}

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

export function fitCrc(bytes: ArrayLike<number>, start = 0, end = bytes.length, crc = 0): number {
  for (let i = start; i < end; i++) {
    const byte = bytes[i]!;
    let tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf]!;
    tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf]!;
  }
  return crc;
}

class FitWriter {
  private readonly out: number[] = [];
  private readonly defs = new Map<number, readonly FieldDef[]>();

  define(local: number, global: number, fields: readonly FieldDef[]): void {
    this.out.push(0x40 | local, 0, 0, global & 0xff, global >> 8, fields.length);
    for (const f of fields) this.out.push(f.num, BASE[f.type].size * (f.count ?? 1), BASE[f.type].id);
    this.defs.set(local, fields);
  }

  write(local: number, values: readonly (number | readonly number[] | null)[]): void {
    const fields = this.defs.get(local);
    if (!fields || fields.length !== values.length) throw new RangeError(`FIT local ${local}: bad value count`);
    this.out.push(local);
    fields.forEach((f, i) => {
      const v = values[i] ?? null;
      const list = Array.isArray(v) ? v : [v];
      for (let k = 0; k < (f.count ?? 1); k++) this.push(f.type, (list[k] ?? null) as number | null);
    });
  }

  private push(type: FieldType, v: number | null): void {
    const { size, invalid } = BASE[type];
    let n = v === null || !Number.isFinite(v) ? invalid : Math.round(v);
    const max = size === 4 ? 0xffffffff : (1 << (8 * size)) - 1;
    if (n < 0 || n > max) n = invalid;
    for (let b = 0; b < size; b++) this.out.push(Math.floor(n / 2 ** (8 * b)) & 0xff);
  }

  finish(): Uint8Array {
    const header = [14, 0x20, 0x5c, 0x08, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54]; // ".FIT", profile 21.40
    const size = this.out.length;
    header[4] = size & 0xff;
    header[5] = (size >> 8) & 0xff;
    header[6] = (size >> 16) & 0xff;
    header[7] = (size >>> 24) & 0xff;
    const hcrc = fitCrc(header);
    const file = [...header, hcrc & 0xff, hcrc >> 8, ...this.out];
    const crc = fitCrc(file);
    file.push(crc & 0xff, crc >> 8);
    return Uint8Array.from(file);
  }
}

const L = { fileId: 0, event: 1, record: 2, hrv: 3, lap: 4, session: 5, activity: 6 } as const;
const HRV_PER_MESSAGE = 5;

function sportCodes(sport: SessionRecord['sport']): [number, number] {
  switch (sport) {
    case 'bike-indoor':
      return [2, 6]; // cycling / indoor_cycling
    case 'run':
      return [1, 0]; // running / generic
    case 'other':
      return [0, 0];
  }
}

/** Wall-clock ms (since start) at which `activeS` of recorded time has elapsed. */
export function activeToWallMs(segments: SessionRecord['segments'], activeS: number): number | null {
  let left = activeS * 1000;
  for (const s of segments) {
    const len = s.endMs - s.startMs;
    if (left <= len) return s.startMs + left;
    left -= len;
  }
  return null;
}

export function encodeFit(s: SessionRecord, opts: { readonly calories?: number | null; readonly now?: Date } = {}): Uint8Array {
  const now = opts.now ?? new Date();
  const startUnixMs = new Date(s.startedAtIso).getTime();
  const ts = (wallMs: number) => Math.floor((startUnixMs + wallMs) / 1000) - FIT_EPOCH_S;
  const segments = s.segments.length ? s.segments : [{ startMs: 0, endMs: s.durationS * 1000 }];
  const endMs = segments.at(-1)!.endMs;
  const w = new FitWriter();

  w.define(L.fileId, 0, [
    { num: 0, type: 'enum' },
    { num: 1, type: 'uint16' },
    { num: 2, type: 'uint16' },
    { num: 3, type: 'uint32z' },
    { num: 4, type: 'uint32' },
  ]);
  w.write(L.fileId, [4, 255, 1, 1, ts(0)]); // activity, manufacturer "development"

  w.define(L.event, 21, [
    { num: 253, type: 'uint32' },
    { num: 0, type: 'enum' },
    { num: 1, type: 'enum' },
  ]);
  w.define(L.record, 20, [
    { num: 253, type: 'uint32' },
    { num: 3, type: 'uint8' },
    { num: 4, type: 'uint8' },
  ]);
  w.define(L.hrv, 78, [{ num: 0, type: 'uint16', count: HRV_PER_MESSAGE }]);

  // Records at 1 Hz inside segments, with the RR beats of each second interleaved.
  const hr = s.hr;
  const confidentRpm = s.inertial.filter((p) => p.rpm !== null && p.rpmConfidence >= 0.5);
  let hi = 0;
  let ci = 0;
  let ri = 0;
  let pendingRr: number[] = [];
  const flushRr = (all: boolean) => {
    while (pendingRr.length >= HRV_PER_MESSAGE || (all && pendingRr.length)) {
      w.write(L.hrv, [pendingRr.splice(0, HRV_PER_MESSAGE)]);
    }
  };
  for (const seg of segments) {
    w.write(L.event, [ts(seg.startMs), 0, 0]); // timer start
    for (let t = Math.ceil(seg.startMs / 1000) * 1000; t <= seg.endMs; t += 1000) {
      while (hi + 1 < hr.length && hr[hi + 1]!.tS * 1000 <= t) hi++;
      while (ci + 1 < confidentRpm.length && confidentRpm[ci + 1]!.tS * 1000 <= t) ci++;
      const h = hr[hi];
      const bpm = h && Math.abs(h.tS * 1000 - t) <= 5000 ? h.bpm : null;
      const c = confidentRpm[ci];
      const rpm = c && Math.abs(c.tS * 1000 - t) <= 10_000 ? c.rpm : null;
      w.write(L.record, [ts(t), bpm, rpm]);
      while (ri < s.rr.length && s.rr[ri]!.tMs <= t) pendingRr.push(s.rr[ri++]!.rrMs);
      flushRr(false);
    }
    w.write(L.event, [ts(seg.endMs), 0, 4]); // timer stop_all
  }
  while (ri < s.rr.length) pendingRr.push(s.rr[ri++]!.rrMs);
  flushRr(true);
  pendingRr = [];

  // Laps: phase boundaries (converted from active to wall time) and manual markers.
  const cuts = new Set<number>();
  if (s.workout && s.workout.phases.length) {
    let acc = 0;
    for (const p of s.workout.phases.slice(0, -1)) {
      acc += p.durationS;
      if (acc >= totalDurationS(s.workout.phases)) break;
      const wall = activeToWallMs(segments, acc);
      if (wall !== null) cuts.add(Math.round(wall));
    }
  }
  for (const m of s.markers) cuts.add(Math.round(m.tMs));
  const bounds = [0, ...[...cuts].filter((c) => c > 0 && c < endMs).sort((a, b) => a - b), endMs];

  w.define(L.lap, 19, [
    { num: 254, type: 'uint16' },
    { num: 253, type: 'uint32' },
    { num: 0, type: 'enum' },
    { num: 1, type: 'enum' },
    { num: 2, type: 'uint32' },
    { num: 7, type: 'uint32' },
    { num: 8, type: 'uint32' },
    { num: 15, type: 'uint8' },
    { num: 16, type: 'uint8' },
    { num: 24, type: 'enum' },
  ]);
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i]!;
    const b = bounds[i + 1]!;
    const lapHr = hr.filter((p) => p.tS * 1000 >= a && p.tS * 1000 < b).map((p) => p.bpm);
    const timer = activeMsBetween(segments, a, b);
    const trigger = i + 2 === bounds.length ? 7 : s.markers.some((m) => Math.round(m.tMs) === b) ? 0 : 1;
    w.write(L.lap, [i, ts(b), 9, 1, ts(a), b - a, timer, avg(lapHr), max(lapHr), trigger]);
  }

  const allHr = hr.map((p) => p.bpm);
  const [sport, subSport] = sportCodes(s.sport);
  w.define(L.session, 18, [
    { num: 254, type: 'uint16' },
    { num: 253, type: 'uint32' },
    { num: 0, type: 'enum' },
    { num: 1, type: 'enum' },
    { num: 2, type: 'uint32' },
    { num: 5, type: 'enum' },
    { num: 6, type: 'enum' },
    { num: 7, type: 'uint32' },
    { num: 8, type: 'uint32' },
    { num: 16, type: 'uint8' },
    { num: 17, type: 'uint8' },
    { num: 11, type: 'uint16' },
    { num: 25, type: 'uint16' },
    { num: 26, type: 'uint16' },
    { num: 28, type: 'enum' },
  ]);
  w.write(L.session, [0, ts(endMs), 8, 1, ts(0), sport, subSport, endMs, s.durationS * 1000, avg(allHr), max(allHr), opts.calories ?? null, 0, bounds.length - 1, 0]);

  w.define(L.activity, 34, [
    { num: 253, type: 'uint32' },
    { num: 0, type: 'uint32' },
    { num: 1, type: 'uint16' },
    { num: 2, type: 'enum' },
    { num: 3, type: 'enum' },
    { num: 4, type: 'enum' },
    { num: 5, type: 'uint32' },
  ]);
  const tzOffsetS = -now.getTimezoneOffset() * 60;
  w.write(L.activity, [ts(endMs), s.durationS * 1000, 1, 0, 26, 1, ts(endMs) + tzOffsetS]);
  return w.finish();
}

function activeMsBetween(segments: SessionRecord['segments'], a: number, b: number): number {
  return segments.reduce((sum, s) => sum + Math.max(0, Math.min(b, s.endMs) - Math.max(a, s.startMs)), 0);
}

function avg(xs: readonly number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

function max(xs: readonly number[]): number | null {
  return xs.length ? Math.max(...xs) : null;
}
