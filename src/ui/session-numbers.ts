import { driftWindow, hrDriftPct, hrRecoveries, type HrRecovery } from '../domain/analysis/session-analysis';
import { sessionLoad } from '../domain/analysis/trends';
import { caloriesFromHr, zoneBounds, type AthleteProfile } from '../domain/athlete/profile';
import { summarize, type SessionRecord, type SessionSummary } from '../domain/session/recorded-session';

export interface SessionNumbers extends SessionSummary {
  readonly kcal: number | null;
  readonly trimp: number | null;
  readonly zonesS: [number, number, number] | null;
  readonly driftPct: number | null;
  readonly recoveries: readonly HrRecovery[];
}

/** Everything the review sheet, the list and the detail page show about one session. */
export function sessionNumbers(rec: SessionRecord, profile: AthleteProfile): SessionNumbers {
  const bounds = zoneBounds(profile, new Date(rec.startedAtIso));
  const load = bounds ? sessionLoad(rec, bounds) : null;
  const w = driftWindow(rec);
  return {
    ...summarize(rec),
    kcal: caloriesFromHr(rec.hr, profile, new Date(rec.startedAtIso)),
    trimp: load?.trimp ?? null,
    zonesS: load?.zonesS ?? null,
    driftPct: w ? hrDriftPct(rec.hr, w.fromS, w.toS) : null,
    recoveries: hrRecoveries(rec),
  };
}
