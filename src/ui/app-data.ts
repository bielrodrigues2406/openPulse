import type { AppSettings, LibraryRepository, MorningRepository, SessionRepository } from '../adapters/storage';
import { DEFAULT_SETTINGS } from '../adapters/storage';
import { EMPTY_PROFILE, type AthleteProfile } from '../domain/athlete/profile';
import type { OrthostaticResult } from '../domain/physiology/orthostatic';
import type { SessionRecord } from '../domain/session/recorded-session';
import { EMPTY_WEEK, type WeekPlan } from '../domain/workouts/week-plan';
import { BUILT_IN_WORKOUTS, type WorkoutTemplate } from '../domain/workouts/workout';

export interface AppDataSnapshot {
  readonly loaded: boolean;
  readonly error: string | null;
  /** Newest first. */
  readonly sessions: readonly SessionRecord[];
  readonly templates: readonly WorkoutTemplate[];
  readonly profile: AthleteProfile;
  readonly weekPlan: WeekPlan;
  readonly settings: AppSettings;
  /** Oldest first. */
  readonly morning: readonly OrthostaticResult[];
}

/** Everything persisted, mirrored in memory for the screens; every write goes through here. */
export class AppData {
  private snap: AppDataSnapshot = {
    loaded: false, error: null, sessions: [], templates: BUILT_IN_WORKOUTS, profile: EMPTY_PROFILE,
    weekPlan: EMPTY_WEEK, settings: DEFAULT_SETTINGS, morning: [],
  };
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly sessionsRepo: SessionRepository,
    private readonly library: LibraryRepository,
    private readonly morningRepo: MorningRepository,
  ) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): AppDataSnapshot => this.snap;

  async load(): Promise<void> {
    try {
      const [sessions, custom, profile, weekPlan, settings, morning] = await Promise.all([
        this.sessionsRepo.list(),
        this.library.templates(),
        this.library.profile(),
        this.library.weekPlan(),
        this.library.settings(),
        this.morningRepo.list(),
      ]);
      this.set({ loaded: true, error: null, sessions, templates: [...BUILT_IN_WORKOUTS, ...custom], profile, weekPlan, settings, morning });
    } catch (err) {
      this.set({ loaded: true, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async refreshSessions(): Promise<void> {
    this.set({ sessions: await this.sessionsRepo.list() });
  }

  async updateSession(rec: SessionRecord): Promise<void> {
    await this.sessionsRepo.save(rec);
    await this.refreshSessions();
  }

  async deleteSession(id: string): Promise<void> {
    await this.sessionsRepo.delete(id);
    await this.refreshSessions();
  }

  async saveProfile(p: AthleteProfile): Promise<void> {
    await this.library.setProfile(p);
    this.set({ profile: p });
  }

  async saveWeekPlan(p: WeekPlan): Promise<void> {
    await this.library.setWeekPlan(p);
    this.set({ weekPlan: p });
  }

  async saveSettings(s: AppSettings): Promise<void> {
    await this.library.setSettings(s);
    this.set({ settings: s });
  }

  async saveTemplate(t: WorkoutTemplate): Promise<void> {
    await this.library.saveTemplate(t);
    const others = this.snap.templates.filter((x) => x.id !== t.id);
    this.set({ templates: [...others.filter((x) => x.builtIn), ...others.filter((x) => !x.builtIn), t] });
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.library.deleteTemplate(id);
    this.set({ templates: this.snap.templates.filter((t) => t.id !== id) });
  }

  async addMorning(r: OrthostaticResult): Promise<void> {
    await this.morningRepo.save(r);
    this.set({ morning: [...this.snap.morning, r].sort((a, b) => a.dateIso.localeCompare(b.dateIso)) });
  }

  async deleteMorning(id: string): Promise<void> {
    await this.morningRepo.delete(id);
    this.set({ morning: this.snap.morning.filter((m) => m.id !== id) });
  }

  private set(patch: Partial<AppDataSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }
}
