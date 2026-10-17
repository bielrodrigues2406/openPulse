import { EMPTY_PROFILE, type AthleteProfile } from '../domain/athlete/profile';
import type { OrthostaticResult } from '../domain/physiology/orthostatic';
import { type LegacyRecord, type SessionRecord, upgradeRecord } from '../domain/session/recorded-session';
import { EMPTY_WEEK, type WeekPlan } from '../domain/workouts/week-plan';
import type { WorkoutTemplate } from '../domain/workouts/workout';

/**
 * Local-first storage (IndexedDB). v1 had sessions + one ECG blob per session; v2 adds ECG
 * chunks (written incrementally while recording), templates, morning tests and a small
 * key-value store for profile, week plan and settings.
 */

const DB_NAME = 'openpulse';
const DB_VERSION = 2;
const S = { sessions: 'sessions', ecgLegacy: 'ecg', ecgChunks: 'ecgChunks', templates: 'templates', morning: 'morning', kv: 'kv' } as const;

export function openDb(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const make = (name: string, opts?: IDBObjectStoreParameters) => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, opts);
      };
      make(S.sessions, { keyPath: 'id' });
      make(S.ecgLegacy);
      make(S.ecgChunks, { keyPath: ['sessionId', 'seq'] });
      make(S.templates, { keyPath: 'id' });
      make(S.morning, { keyPath: 'id' });
      make(S.kv);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('Feche outras janelas do openPulse e recarregue.'));
  });
}

interface EcgChunk {
  readonly sessionId: string;
  readonly seq: number;
  readonly samples: ArrayBuffer;
}

export class SessionRepository {
  constructor(private readonly db: Promise<IDBDatabase>) {}

  /**
   * Writes the record and, optionally, the next ECG chunk in one transaction, so the record's
   * ecgSampleCount never disagrees with what is on disk.
   */
  async save(record: SessionRecord, chunk?: { readonly seq: number; readonly samples: Int32Array }): Promise<void> {
    const tx = (await this.db).transaction([S.sessions, S.ecgChunks], 'readwrite');
    tx.objectStore(S.sessions).put(record);
    if (chunk && chunk.samples.length) {
      // Copy: the caller's buffer may be a view into a larger, still-growing one.
      const value: EcgChunk = { sessionId: record.id, seq: chunk.seq, samples: chunk.samples.slice().buffer };
      tx.objectStore(S.ecgChunks).put(value);
    }
    await done(tx);
  }

  /** Newest first. */
  async list(): Promise<SessionRecord[]> {
    const tx = (await this.db).transaction(S.sessions, 'readonly');
    const raw = await request<LegacyRecord[]>(tx.objectStore(S.sessions).getAll());
    return raw.map(upgradeRecord).sort((a, b) => b.startedAtIso.localeCompare(a.startedAtIso));
  }

  async get(id: string): Promise<SessionRecord | null> {
    const tx = (await this.db).transaction(S.sessions, 'readonly');
    const raw = await request<LegacyRecord | undefined>(tx.objectStore(S.sessions).get(id));
    return raw ? upgradeRecord(raw) : null;
  }

  /** The most recent session still marked open (interrupted), if any. */
  async findOpen(): Promise<SessionRecord | null> {
    return (await this.list()).find((s) => s.status === 'open') ?? null;
  }

  /** Legacy single blob (v1/v2 sessions) followed by chunks in order. */
  async ecg(id: string): Promise<Int32Array> {
    const tx = (await this.db).transaction([S.ecgLegacy, S.ecgChunks], 'readonly');
    const legacy = await request<ArrayBuffer | undefined>(tx.objectStore(S.ecgLegacy).get(id));
    const chunks = await request<EcgChunk[]>(tx.objectStore(S.ecgChunks).getAll(IDBKeyRange.bound([id, 0], [id, Infinity])));
    const parts = [legacy ? new Int32Array(legacy) : new Int32Array(0), ...chunks.sort((a, b) => a.seq - b.seq).map((c) => new Int32Array(c.samples))];
    const out = new Int32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  async delete(id: string): Promise<void> {
    const tx = (await this.db).transaction([S.sessions, S.ecgLegacy, S.ecgChunks], 'readwrite');
    tx.objectStore(S.sessions).delete(id);
    tx.objectStore(S.ecgLegacy).delete(id);
    tx.objectStore(S.ecgChunks).delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
    await done(tx);
  }
}

export interface AppSettings {
  readonly sound: boolean;
  readonly voice: boolean;
  /** Desktop app: connect to the remembered strap on launch. */
  readonly autoConnect: boolean;
  readonly sport: SessionRecord['sport'];
  readonly source: 'h10' | 'sim';
}

export const DEFAULT_SETTINGS: AppSettings = { sound: true, voice: true, autoConnect: true, sport: 'bike-indoor', source: 'h10' };

export class LibraryRepository {
  constructor(private readonly db: Promise<IDBDatabase>) {}

  async templates(): Promise<WorkoutTemplate[]> {
    const tx = (await this.db).transaction(S.templates, 'readonly');
    return request<WorkoutTemplate[]>(tx.objectStore(S.templates).getAll());
  }

  async saveTemplate(t: WorkoutTemplate): Promise<void> {
    if (t.builtIn) throw new RangeError('Built-in templates are read-only');
    const tx = (await this.db).transaction(S.templates, 'readwrite');
    tx.objectStore(S.templates).put(t);
    await done(tx);
  }

  async deleteTemplate(id: string): Promise<void> {
    const tx = (await this.db).transaction(S.templates, 'readwrite');
    tx.objectStore(S.templates).delete(id);
    await done(tx);
  }

  async profile(): Promise<AthleteProfile> {
    // Older versions stored fewer fields; defaults fill the gaps.
    return { ...EMPTY_PROFILE, ...(await this.kv<Partial<AthleteProfile>>('profile', {})) };
  }
  setProfile(p: AthleteProfile): Promise<void> {
    return this.setKv('profile', p);
  }
  weekPlan(): Promise<WeekPlan> {
    return this.kv('weekPlan', EMPTY_WEEK);
  }
  setWeekPlan(p: WeekPlan): Promise<void> {
    return this.setKv('weekPlan', p);
  }
  async settings(): Promise<AppSettings> {
    return { ...DEFAULT_SETTINGS, ...(await this.kv<Partial<AppSettings>>('settings', {})) };
  }
  setSettings(s: AppSettings): Promise<void> {
    return this.setKv('settings', s);
  }

  private async kv<T>(key: string, fallback: T): Promise<T> {
    const tx = (await this.db).transaction(S.kv, 'readonly');
    return (await request<T | undefined>(tx.objectStore(S.kv).get(key))) ?? fallback;
  }

  private async setKv(key: string, value: unknown): Promise<void> {
    const tx = (await this.db).transaction(S.kv, 'readwrite');
    tx.objectStore(S.kv).put(value, key);
    await done(tx);
  }
}

export class MorningRepository {
  constructor(private readonly db: Promise<IDBDatabase>) {}

  /** Oldest first. */
  async list(): Promise<OrthostaticResult[]> {
    const tx = (await this.db).transaction(S.morning, 'readonly');
    const all = await request<OrthostaticResult[]>(tx.objectStore(S.morning).getAll());
    return all.sort((a, b) => a.dateIso.localeCompare(b.dateIso));
  }

  async save(r: OrthostaticResult): Promise<void> {
    const tx = (await this.db).transaction(S.morning, 'readwrite');
    tx.objectStore(S.morning).put(r);
    await done(tx);
  }

  async delete(id: string): Promise<void> {
    const tx = (await this.db).transaction(S.morning, 'readwrite');
    tx.objectStore(S.morning).delete(id);
    await done(tx);
  }
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}
