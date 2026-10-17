import { sanitizeProfile, type AthleteProfile } from '../domain/athlete/profile';
import type { OrthostaticResult } from '../domain/physiology/orthostatic';
import { upgradeRecord, type LegacyRecord } from '../domain/session/recorded-session';
import type { WeekPlan } from '../domain/workouts/week-plan';
import type { WorkoutTemplate } from '../domain/workouts/workout';
import type { AppData } from './app-data';

const FORMAT = 'openpulse-backup';
const VERSION = 1;

interface Backup {
  readonly format: typeof FORMAT;
  readonly version: number;
  readonly exportedAt: string;
  readonly profile: AthleteProfile;
  readonly weekPlan: WeekPlan;
  readonly templates: readonly WorkoutTemplate[];
  readonly sessions: readonly LegacyRecord[];
  readonly morning: readonly OrthostaticResult[];
}

export async function exportBackup(data: AppData): Promise<string> {
  const d = data.getSnapshot();
  const backup: Backup = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    profile: d.profile,
    weekPlan: d.weekPlan,
    templates: d.templates.filter((t) => !t.builtIn),
    sessions: d.sessions.map((s) => ({ ...s, ecgSampleCount: 0, ecgSegments: [], ecgChunks: 0 })),
    morning: d.morning,
  };
  return JSON.stringify(backup);
}

/** Merges a backup into local data (same ids overwrite). Returns the number of sessions imported. */
export async function importBackup(data: AppData, json: string): Promise<number> {
  const raw = JSON.parse(json) as Partial<Backup>;
  if (raw.format !== FORMAT || typeof raw.version !== 'number') throw new Error('arquivo não é um backup do openPulse');
  if (raw.version > VERSION) throw new Error('backup de uma versão mais nova do app');
  const sessions = (raw.sessions ?? []).map(upgradeRecord);
  for (const s of sessions) await data.sessionsRepo.save(s);
  for (const t of raw.templates ?? []) if (!t.builtIn) await data.saveTemplate(t);
  for (const m of raw.morning ?? []) await data.addMorning(m);
  if (raw.profile) await data.saveProfile(sanitizeProfile({ ...data.getSnapshot().profile, ...raw.profile }));
  if (raw.weekPlan?.days?.length === 7) await data.saveWeekPlan(raw.weekPlan);
  await data.refreshSessions();
  return sessions.length;
}
