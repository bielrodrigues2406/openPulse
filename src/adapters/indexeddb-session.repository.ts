import type { SessionRecord } from '../domain/session/recorded-session';

const DB_NAME = 'openpulse';
const DB_VERSION = 1;
const SESSIONS = 'sessions';
const ECG = 'ecg';

/** Local-first session storage. Records and ECG live in separate stores so listing stays cheap. */
export class IndexedDbSessionRepository {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory = indexedDB) {}

  /** Writes record and ECG atomically; called repeatedly during a session as a checkpoint. */
  async save(record: SessionRecord, ecgUv: Int32Array): Promise<void> {
    if (ecgUv.length !== record.ecgSampleCount) throw new RangeError('ECG length does not match record');
    const tx = (await this.open()).transaction([SESSIONS, ECG], 'readwrite');
    tx.objectStore(SESSIONS).put(record);
    // Copy: the caller's buffer may be a view into a larger, still-growing one.
    tx.objectStore(ECG).put(ecgUv.slice().buffer, record.id);
    await done(tx);
  }

  /** Newest first. */
  async list(): Promise<SessionRecord[]> {
    const tx = (await this.open()).transaction(SESSIONS, 'readonly');
    const all = await request<SessionRecord[]>(tx.objectStore(SESSIONS).getAll());
    return all.sort((a, b) => b.startedAtIso.localeCompare(a.startedAtIso));
  }

  async ecg(id: string): Promise<Int32Array> {
    const tx = (await this.open()).transaction(ECG, 'readonly');
    const buf = await request<ArrayBuffer | undefined>(tx.objectStore(ECG).get(id));
    return buf ? new Int32Array(buf) : new Int32Array(0);
  }

  async delete(id: string): Promise<void> {
    const tx = (await this.open()).transaction([SESSIONS, ECG], 'readwrite');
    tx.objectStore(SESSIONS).delete(id);
    tx.objectStore(ECG).delete(id);
    await done(tx);
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = this.factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(ECG)) db.createObjectStore(ECG);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB bloqueado por outra aba aberta'));
    });
    return this.db;
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
