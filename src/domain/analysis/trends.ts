import { luciaTrimp, timeInZones, type ZoneBounds } from '../athlete/profile';
import { localDay, type SessionRecord } from '../session/recorded-session';
import { addDays, mondayOf } from '../workouts/week-plan';

type SessionLike = Pick<SessionRecord, 'id' | 'startedAtIso' | 'durationS' | 'status' | 'hr' | 'thresholds'>;

export interface SessionLoad {
  readonly zonesS: [number, number, number];
  readonly trimp: number;
}

export function sessionLoad(s: Pick<SessionRecord, 'hr'>, bounds: ZoneBounds): SessionLoad {
  const zonesS = timeInZones(s.hr, bounds);
  return { zonesS, trimp: luciaTrimp(zonesS) };
}

export interface WeekLoad {
  readonly monday: string;
  readonly sessions: number;
  readonly activeS: number;
  readonly trimp: number | null;
  readonly zonesS: [number, number, number] | null;
}

/** Last `weeks` weeks ending with the week of `now`, oldest first. */
export function weeklyLoads(sessions: readonly SessionLike[], bounds: ZoneBounds | null, weeks: number, now = new Date()): WeekLoad[] {
  const lastMonday = mondayOf(now);
  return Array.from({ length: weeks }, (_, i) => {
    const monday = addDays(lastMonday, -7 * (weeks - 1 - i));
    const next = addDays(monday, 7);
    const inWeek = sessions.filter((s) => {
      const t = new Date(s.startedAtIso);
      return s.status === 'finished' && t >= monday && t < next;
    });
    let trimp: number | null = null;
    let zonesS: [number, number, number] | null = null;
    if (bounds) {
      zonesS = [0, 0, 0];
      trimp = 0;
      for (const s of inWeek) {
        const l = sessionLoad(s, bounds);
        trimp += l.trimp;
        zonesS = [zonesS[0] + l.zonesS[0], zonesS[1] + l.zonesS[1], zonesS[2] + l.zonesS[2]];
      }
    }
    return { monday: localDay(monday), sessions: inWeek.length, activeS: inWeek.reduce((a, s) => a + s.durationS, 0), trimp, zonesS };
  });
}

export interface FitnessPoint {
  readonly day: string;
  readonly load: number;
  /** Chronic training load (42-day EWMA): "fitness". */
  readonly ctl: number;
  /** Acute training load (7-day EWMA): "fatigue". */
  readonly atl: number;
}

/** Banister-style impulse-response on daily Lucia TRIMP. */
export function fitnessSeries(sessions: readonly SessionLike[], bounds: ZoneBounds, days: number, now = new Date()): FitnessPoint[] {
  const daily = new Map<string, number>();
  for (const s of sessions) {
    if (s.status !== 'finished') continue;
    const d = localDay(new Date(s.startedAtIso));
    daily.set(d, (daily.get(d) ?? 0) + sessionLoad(s, bounds).trimp);
  }
  // Warm up the filters over the 42 days before the visible range.
  const warm = 42;
  const start = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), -(days - 1) - warm);
  const kc = 1 - Math.exp(-1 / 42);
  const ka = 1 - Math.exp(-1 / 7);
  let ctl = 0;
  let atl = 0;
  const out: FitnessPoint[] = [];
  for (let i = 0; i < days + warm; i++) {
    const day = localDay(addDays(start, i));
    const load = daily.get(day) ?? 0;
    ctl += kc * (load - ctl);
    atl += ka * (load - atl);
    if (i >= warm) out.push({ day, load, ctl, atl });
  }
  return out;
}

export interface ThresholdPoint {
  readonly day: string;
  readonly sessionId: string;
  readonly hrvt1: number | null;
  readonly hrvt2: number | null;
}

export function thresholdHistory(sessions: readonly SessionLike[]): ThresholdPoint[] {
  return sessions
    .filter((s) => s.thresholds && (s.thresholds.hrvt1 !== null || s.thresholds.hrvt2 !== null))
    .map((s) => ({ day: localDay(new Date(s.startedAtIso)), sessionId: s.id, hrvt1: s.thresholds!.hrvt1, hrvt2: s.thresholds!.hrvt2 }))
    .sort((a, b) => a.day.localeCompare(b.day));
}
