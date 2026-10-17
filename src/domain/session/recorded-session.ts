import type { DfaPoint } from '../physiology/dfa-alpha1';
import type { InertialPoint } from '../physiology/inertial-fusion';
import type { ThresholdEstimate } from '../physiology/thresholds';
import type { RrBeat } from '../physiology/rr-quality';
import { artifactRate, rmssd } from '../physiology/rr-quality';
import type { Phase, Sport, WorkoutKind } from '../workouts/workout';

export const SESSION_SCHEMA_VERSION = 3;

export interface HrPoint {
  readonly tS: number;
  readonly bpm: number;
}

/** A stretch of continuous recording, in ms since startedAt (wall clock). */
export interface Segment {
  readonly startMs: number;
  readonly endMs: number;
}

export interface Marker {
  readonly tMs: number;
  readonly label: string;
}

/** The plan as it was when the workout started; later template edits don't rewrite history. */
export interface WorkoutSnapshot {
  readonly templateId: string | null;
  readonly name: string;
  readonly kind: WorkoutKind;
  readonly phases: readonly Phase[];
}

/**
 * Everything about a session except raw ECG, which is stored in chunks (it dominates size).
 * Times are wall-clock offsets from startedAt, so gaps between segments are real time.
 */
export interface SessionRecord {
  readonly schemaVersion: typeof SESSION_SCHEMA_VERSION;
  readonly id: string;
  readonly startedAtIso: string;
  /** 'open' until the athlete finishes it; an open session can be resumed. */
  readonly status: 'open' | 'finished';
  /** Active (recorded) time; excludes gaps. */
  readonly durationS: number;
  readonly segments: readonly Segment[];
  readonly source: 'h10' | 'sim';
  readonly deviceName: string;
  readonly sport: Sport;
  readonly workout: WorkoutSnapshot | null;
  readonly markers: readonly Marker[];
  readonly rpe: number | null;
  readonly notes: string;
  readonly ecgHz: number;
  readonly ecgSampleCount: number;
  /** How many ECG samples each segment holds, in order. */
  readonly ecgSegments: readonly { readonly startMs: number; readonly samples: number }[];
  readonly ecgChunks: number;
  readonly hr: readonly HrPoint[];
  readonly rr: readonly RrBeat[];
  readonly dfa: readonly DfaPoint[];
  readonly inertial: readonly InertialPoint[];
  readonly thresholds: ThresholdEstimate | null;
}

/** Shape of records written by v1/v2. */
export type LegacyRecord = Omit<Partial<SessionRecord>, 'schemaVersion'> &
  Pick<SessionRecord, 'id' | 'startedAtIso' | 'durationS' | 'source' | 'deviceName' | 'ecgHz' | 'ecgSampleCount' | 'hr' | 'rr'> & {
    schemaVersion: number;
  };

/** Records written by older versions, upgraded on read. */
export function upgradeRecord(raw: LegacyRecord): SessionRecord {
  if (raw.schemaVersion > SESSION_SCHEMA_VERSION) {
    throw new RangeError(`Session ${raw.id} uses schema v${raw.schemaVersion}; this app reads up to v${SESSION_SCHEMA_VERSION}`);
  }
  if (raw.schemaVersion === SESSION_SCHEMA_VERSION) return raw as SessionRecord;
  const durationMs = raw.durationS * 1000;
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: raw.id,
    startedAtIso: raw.startedAtIso,
    status: 'finished',
    durationS: raw.durationS,
    segments: [{ startMs: 0, endMs: durationMs }],
    source: raw.source,
    deviceName: raw.deviceName,
    sport: 'bike-indoor',
    workout: null,
    markers: [],
    rpe: null,
    notes: '',
    ecgHz: raw.ecgHz,
    ecgSampleCount: raw.ecgSampleCount,
    ecgSegments: [{ startMs: 0, samples: raw.ecgSampleCount }],
    ecgChunks: 0,
    hr: raw.hr,
    rr: raw.rr,
    dfa: raw.dfa ?? [],
    inertial: [],
    thresholds: null,
  };
}

export interface SessionSummary {
  readonly meanBpm: number | null;
  readonly maxBpm: number | null;
  readonly rmssdMs: number | null;
  readonly artifactPct: number | null;
  readonly beats: number;
  /** Lowest valid α1 seen; a rough marker of how far past VT1 the session went. */
  readonly minAlpha1: number | null;
  readonly meanBreaths: number | null;
  readonly meanRpm: number | null;
}

export function summarize(s: Pick<SessionRecord, 'hr' | 'rr' | 'dfa'> & Partial<Pick<SessionRecord, 'inertial'>>): SessionSummary {
  const bpm = s.hr.map((p) => p.bpm);
  const rate = artifactRate(s.rr);
  const valid = s.dfa.flatMap((p) => (p.alpha1 === null ? [] : [p.alpha1]));
  const breaths = (s.inertial ?? []).flatMap((p) => (p.breathsPerMin === null || p.breathConfidence < 0.3 ? [] : [p.breathsPerMin]));
  const rpm = (s.inertial ?? []).flatMap((p) => (p.rpm === null || p.rpmConfidence < 0.5 ? [] : [p.rpm]));
  return {
    meanBpm: mean(bpm),
    maxBpm: bpm.length ? Math.max(...bpm) : null,
    rmssdMs: rmssd(s.rr),
    artifactPct: rate === null ? null : rate * 100,
    beats: s.rr.length,
    minAlpha1: valid.length ? Math.min(...valid) : null,
    meanBreaths: mean(breaths),
    meanRpm: mean(rpm),
  };
}

function mean(xs: readonly number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Local calendar day of a session, "YYYY-MM-DD". */
export function sessionDay(s: Pick<SessionRecord, 'startedAtIso'>): string {
  return localDay(new Date(s.startedAtIso));
}

export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
