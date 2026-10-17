import { localDay, type SessionRecord } from '../session/recorded-session';
import { totalDurationS, type WorkoutTemplate } from './workout';

/** Recurring weekly structure: template ids per weekday, Monday first. */
export interface WeekPlan {
  readonly days: readonly (readonly string[])[];
}

export const WEEKDAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'] as const;

export const EMPTY_WEEK: WeekPlan = { days: [[], [], [], [], [], [], []] };

/**
 * ~80/20 polarized week: one high-intensity day, volume below VT1 on the rest,
 * recovery after the hard day, two full rest days. A starting point, meant to be edited.
 */
export const POLARIZED_WEEK: WeekPlan = {
  days: [[], ['intervals-4x4'], ['recovery-30'], ['base-60'], [], ['long-90'], ['base-60']],
};

export function mondayOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (m.getDay() + 6) % 7; // 0 = Monday
  m.setDate(m.getDate() - dow);
  return m;
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

type SessionLike = Pick<SessionRecord, 'id' | 'startedAtIso' | 'durationS' | 'status' | 'workout'>;

export interface PlannedItem {
  readonly templateId: string;
  readonly name: string;
  readonly durationS: number;
  readonly kind: WorkoutTemplate['kind'] | 'unknown';
  /** Session that fulfilled it, if any. */
  readonly doneBy: string | null;
}

export interface DayView {
  readonly day: string; // YYYY-MM-DD local
  readonly weekday: number; // 0 = Monday
  readonly planned: readonly PlannedItem[];
  readonly sessions: readonly SessionLike[];
  readonly isToday: boolean;
  readonly isPast: boolean;
}

/** Places plan and completed sessions on the 7 days of the week starting at `monday`. */
export function resolveWeek(
  plan: WeekPlan,
  monday: Date,
  sessions: readonly SessionLike[],
  templates: readonly WorkoutTemplate[],
  now: Date = new Date(),
): DayView[] {
  const today = localDay(now);
  return Array.from({ length: 7 }, (_, weekday) => {
    const day = localDay(addDays(monday, weekday));
    const daySessions = sessions
      .filter((s) => s.status === 'finished' && localDay(new Date(s.startedAtIso)) === day)
      .sort((a, b) => a.startedAtIso.localeCompare(b.startedAtIso));
    const unused = [...daySessions];
    const planned = (plan.days[weekday] ?? []).map((templateId): PlannedItem => {
      const t = templates.find((x) => x.id === templateId);
      const i = unused.findIndex((s) => s.workout?.templateId === templateId);
      const doneBy = i >= 0 ? unused.splice(i, 1)[0]!.id : null;
      return {
        templateId,
        name: t?.name ?? 'Treino removido',
        durationS: t ? totalDurationS(t.phases) : 0,
        kind: t?.kind ?? 'unknown',
        doneBy,
      };
    });
    return { day, weekday, planned, sessions: daySessions, isToday: day === today, isPast: day < today };
  });
}

export function plannedDurationS(plan: WeekPlan, templates: readonly WorkoutTemplate[]): number {
  return plan.days.flat().reduce((s, id) => s + totalDurationS(templates.find((t) => t.id === id)?.phases ?? []), 0);
}
