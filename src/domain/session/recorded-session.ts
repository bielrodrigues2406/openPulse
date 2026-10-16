import type { DfaPoint } from '../physiology/dfa-alpha1';
import type { RrBeat } from '../physiology/rr-quality';
import { artifactRate, rmssd } from '../physiology/rr-quality';

export const SESSION_SCHEMA_VERSION = 2;

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
  /** One point per 5 s once 120 s of beats exist. Added in schema v2. */
  readonly dfa: readonly DfaPoint[];
}

export interface SessionSummary {
  readonly meanBpm: number | null;
  readonly maxBpm: number | null;
  readonly rmssdMs: number | null;
  readonly artifactPct: number | null;
  readonly beats: number;
  /** Lowest valid α1 seen; a rough marker of how far past VT1 the session went. */
  readonly minAlpha1: number | null;
}

/** Records written by older versions, upgraded on read. */
export function upgradeRecord(raw: Omit<SessionRecord, 'schemaVersion' | 'dfa'> & { schemaVersion: number; dfa?: readonly DfaPoint[] }): SessionRecord {
  if (raw.schemaVersion > SESSION_SCHEMA_VERSION) {
    throw new RangeError(`Session ${raw.id} uses schema v${raw.schemaVersion}; this app reads up to v${SESSION_SCHEMA_VERSION}`);
  }
  return { ...raw, schemaVersion: SESSION_SCHEMA_VERSION, dfa: raw.dfa ?? [] };
}

export function summarize(s: Pick<SessionRecord, 'hr' | 'rr' | 'dfa'>): SessionSummary {
  const bpm = s.hr.map((p) => p.bpm);
  const rate = artifactRate(s.rr);
  const valid = s.dfa.flatMap((p) => (p.alpha1 === null ? [] : [p.alpha1]));
  return {
    meanBpm: bpm.length ? bpm.reduce((a, b) => a + b, 0) / bpm.length : null,
    maxBpm: bpm.length ? Math.max(...bpm) : null,
    rmssdMs: rmssd(s.rr),
    artifactPct: rate === null ? null : rate * 100,
    beats: s.rr.length,
    minAlpha1: valid.length ? Math.min(...valid) : null,
  };
}
