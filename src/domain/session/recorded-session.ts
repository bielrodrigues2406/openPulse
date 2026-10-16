import type { RrBeat } from '../physiology/rr-quality';
import { artifactRate, rmssd } from '../physiology/rr-quality';

export const SESSION_SCHEMA_VERSION = 1;

export interface HrPoint {
  readonly tS: number;
  readonly bpm: number;
}

/** Everything about a session except raw ECG, which is stored separately (it dominates size). */
export interface SessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly id: string;
  readonly startedAtIso: string;
  readonly durationS: number;
  readonly source: 'h10' | 'sim';
  readonly deviceName: string;
  readonly ecgHz: number;
  readonly ecgSampleCount: number;
  readonly hr: readonly HrPoint[];
  readonly rr: readonly RrBeat[];
}

export interface SessionSummary {
  readonly meanBpm: number | null;
  readonly maxBpm: number | null;
  readonly rmssdMs: number | null;
  readonly artifactPct: number | null;
  readonly beats: number;
}

export function summarize(s: Pick<SessionRecord, 'hr' | 'rr'>): SessionSummary {
  const bpm = s.hr.map((p) => p.bpm);
  const rate = artifactRate(s.rr);
  return {
    meanBpm: bpm.length ? bpm.reduce((a, b) => a + b, 0) / bpm.length : null,
    maxBpm: bpm.length ? Math.max(...bpm) : null,
    rmssdMs: rmssd(s.rr),
    artifactPct: rate === null ? null : rate * 100,
    beats: s.rr.length,
  };
}
