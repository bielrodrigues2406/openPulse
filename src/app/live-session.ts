import { zoneOf, type ZoneBounds } from '../domain/athlete/profile';
import type { DfaPoint } from '../domain/physiology/dfa-alpha1';
import type { InertialPoint } from '../domain/physiology/inertial-fusion';
import { RrSeries, artifactRate, rmssd } from '../domain/physiology/rr-quality';
import { estimateThresholds } from '../domain/physiology/thresholds';
import type { PolarSensor, SensorEvent, SensorStatus } from '../domain/ports/polar-sensor.port';
import {
  SESSION_SCHEMA_VERSION,
  type HrPoint,
  type Marker,
  type Segment,
  type SessionRecord,
  type WorkoutSnapshot,
} from '../domain/session/recorded-session';
import {
  evaluateTarget,
  phaseAt,
  totalDurationS,
  type PhasePosition,
  type Sport,
  type TargetState,
  type WorkoutTemplate,
  type Zone,
} from '../domain/workouts/workout';
import type { DspRequest, DspResponse } from '../workers/dsp.protocol';
import type { Cues } from './cues';

export const ECG_HZ = 130;
const ECG_DISPLAY_CAPACITY = ECG_HZ * 10;
const HRV_WINDOW_MS = 60_000;
const CHECKPOINT_MS = 10_000;
/** No HR packet for this long while recording = sensor lost; the segment closes. */
const STALL_MS = 6_000;
const TICK_MS = 500;
const TARGET_GRACE_S = 90; // HR lags and α1 needs a full window after a phase change
const TARGET_ALERT_AFTER_S = 30;
const TARGET_ALERT_REPEAT_S = 90;

/** The DSP worker as the session sees it; a synchronous fake in tests. */
export interface DspChannel {
  post(msg: DspRequest & { readonly gen: number }): void;
  onMessage(listener: (msg: DspResponse & { readonly gen: number }) => void): void;
}

/** Where sessions go; SessionRepository in the app, an in-memory map in tests. */
export interface SessionSink {
  save(record: SessionRecord, chunk?: { readonly seq: number; readonly samples: Int32Array }): Promise<void>;
  delete(id: string): Promise<void>;
}

export type SaveState =
  | { readonly state: 'none' }
  | { readonly state: 'saved'; readonly at: number }
  | { readonly state: 'error'; readonly message: string };

export interface WorkoutView {
  readonly id: string;
  readonly name: string;
  readonly kind: WorkoutSnapshot['kind'];
  readonly sport: Sport;
  readonly state: 'running' | 'paused';
  readonly pauseReason: 'user' | 'sensor' | null;
  readonly startedAtIso: string;
  readonly activeS: number;
  readonly elapsedS: number;
  readonly totalPlanS: number;
  readonly position: PhasePosition | null;
  readonly target: TargetState;
  readonly markers: number;
  readonly planComplete: boolean;
}

export interface LiveSnapshot {
  readonly sensor: SensorStatus;
  readonly battery: number | null;
  readonly bpm: number | null;
  readonly lastRrMs: number | null;
  readonly rmssdMs: number | null;
  readonly artifactPct: number | null;
  readonly contact: boolean | null;
  readonly dfa: DfaPoint | null;
  readonly inertial: InertialPoint | null;
  readonly zone: Zone | null;
  readonly bounds: ZoneBounds | null;
  readonly workout: WorkoutView | null;
  /** Finished, awaiting RPE/notes before being marked finished. */
  readonly review: SessionRecord | null;
  readonly save: SaveState;
}

interface Recording {
  readonly id: string;
  readonly startedAtIso: string;
  readonly source: SessionRecord['source'];
  deviceName: string;
  sport: Sport;
  readonly workout: WorkoutSnapshot;
  readonly segments: Segment[];
  openSince: number | null;
  pauseReason: 'user' | 'sensor' | null;
  readonly markers: Marker[];
  ecgSampleCount: number;
  ecgChunks: number;
  readonly ecgSegments: { startMs: number; samples: number }[];
  ecgPending: number[];
  // cue bookkeeping
  lastPhaseIndex: number;
  lastCountdownS: number;
  nextRepeatCueS: number;
  offTargetSince: number | null;
  lastAlertAt: number;
  planCompleteAnnounced: boolean;
}

export class LiveSession {
  // Display buffers, read by canvases every animation frame.
  readonly ecg = new Float32Array(ECG_DISPLAY_CAPACITY);
  ecgWritten = 0;
  hr: HrPoint[] = [];
  rr = new RrSeries();
  dfa: DfaPoint[] = [];
  inertial: InertialPoint[] = [];

  /** Epoch ms that all series times are relative to. */
  private t0: number | null = null;
  private recording: Recording | null = null;
  private lastPacketAt = 0;
  private gen = 0;
  private source: SessionRecord['source'] = 'sim';
  private bounds: ZoneBounds | null = null;
  private snap: LiveSnapshot;
  private readonly listeners = new Set<() => void>();
  private detachSensor: (() => void) | null = null;
  private lastCheckpointAt = 0;
  private saving: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sink: SessionSink,
    private readonly dsp: DspChannel,
    private readonly cues: Cues | null,
    private readonly now: () => number = Date.now,
  ) {
    this.snap = {
      sensor: { state: 'idle' }, battery: null, bpm: null, lastRrMs: null, rmssdMs: null, artifactPct: null, contact: null,
      dfa: null, inertial: null, zone: null, bounds: null, workout: null, review: null, save: { state: 'none' },
    };
    dsp.onMessage((msg) => {
      if (msg.gen !== this.gen) return; // computed for a segment that no longer exists
      if (msg.type === 'dfa') {
        this.dfa.push(...msg.points);
        this.update({ dfa: msg.points.at(-1) ?? null });
      } else {
        this.inertial.push(...msg.points);
        this.update({ inertial: msg.points.at(-1) ?? null });
      }
    });
  }

  // ── wiring ──────────────────────────────────────────────────────────────

  attach(sensor: PolarSensor, source: SessionRecord['source']): void {
    this.detachSensor?.();
    this.source = source;
    const offEvent = sensor.onEvent(this.handleEvent);
    const offStatus = sensor.onStatus(this.handleStatus);
    this.detachSensor = () => {
      offEvent();
      offStatus();
    };
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
  }

  dispose(): void {
    this.detachSensor?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setBounds(bounds: ZoneBounds | null): void {
    this.bounds = bounds;
    this.update({ bounds, zone: this.zoneFor(this.snap.bpm) });
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): LiveSnapshot => this.snap;

  /** Wall-clock offset (ms) now, in the series' time base. */
  offsetNow(): number {
    return this.t0 === null ? 0 : this.now() - this.t0;
  }

  segments(): readonly Segment[] {
    const r = this.recording;
    if (!r) return [];
    return r.openSince === null ? r.segments : [...r.segments, { startMs: r.openSince, endMs: this.offsetNow() }];
  }

  markers(): readonly Marker[] {
    return this.recording?.markers ?? [];
  }

  plannedPhases(): WorkoutSnapshot['phases'] {
    return this.recording?.workout.phases ?? [];
  }

  // ── workout lifecycle ───────────────────────────────────────────────────

  start(template: WorkoutTemplate, sport: Sport): void {
    if (this.recording) throw new Error('A workout is already in progress');
    this.resetSeries(this.now());
    this.recording = {
      id: crypto.randomUUID(),
      startedAtIso: new Date(this.t0!).toISOString(),
      source: this.source,
      deviceName: this.snap.sensor.state === 'streaming' ? this.snap.sensor.deviceName : '',
      sport,
      workout: { templateId: template.id, name: template.name, kind: template.kind, phases: template.phases },
      segments: [],
      openSince: null,
      pauseReason: 'sensor',
      markers: [],
      ecgSampleCount: 0,
      ecgChunks: 0,
      ecgSegments: [],
      ecgPending: [],
      lastPhaseIndex: -1,
      lastCountdownS: -1,
      nextRepeatCueS: Infinity,
      offTargetSince: null,
      lastAlertAt: -Infinity,
      planCompleteAnnounced: false,
    };
    // Start recording right away when data is flowing; otherwise the first packet opens it.
    if (this.dataFresh()) this.openSegment(0);
    this.lastCheckpointAt = this.now();
    this.refreshWorkout();
  }

  /** Continues an interrupted session from storage. Recording restarts with the next packet. */
  resume(rec: SessionRecord): void {
    if (this.recording) throw new Error('A workout is already in progress');
    this.gen++;
    this.t0 = Date.parse(rec.startedAtIso);
    this.hr = [...rec.hr];
    this.rr = RrSeries.from(rec.rr);
    this.dfa = [...rec.dfa];
    this.inertial = [...rec.inertial];
    this.recording = {
      id: rec.id,
      startedAtIso: rec.startedAtIso,
      source: rec.source,
      deviceName: rec.deviceName,
      sport: rec.sport,
      workout: rec.workout ?? { templateId: 'free', name: 'Treino livre', kind: 'free', phases: [] },
      segments: [...rec.segments],
      openSince: null,
      pauseReason: 'sensor',
      markers: [...rec.markers],
      ecgSampleCount: rec.ecgSampleCount,
      ecgChunks: rec.ecgChunks,
      ecgSegments: rec.ecgSegments.map((s) => ({ ...s })),
      ecgPending: [],
      lastPhaseIndex: -1,
      lastCountdownS: -1,
      nextRepeatCueS: Infinity,
      offTargetSince: null,
      lastAlertAt: -Infinity,
      planCompleteAnnounced: false,
    };
    this.cues?.say('Treino retomado.');
    if (this.dataFresh()) this.openSegment(this.offsetNow());
    this.refreshWorkout();
  }

  pause(): void {
    const r = this.recording;
    if (!r || r.openSince === null) return;
    this.closeSegment(this.offsetNow());
    r.pauseReason = 'user';
    this.cues?.beep('mark');
    void this.checkpoint();
    this.refreshWorkout();
  }

  unpause(): void {
    const r = this.recording;
    if (!r || r.openSince !== null) return;
    r.pauseReason = 'sensor'; // reopened by data; if data is flowing, right now
    if (this.dataFresh()) this.openSegment(this.offsetNow());
    this.refreshWorkout();
  }

  mark(label = 'Volta'): void {
    const r = this.recording;
    if (!r || r.openSince === null) return;
    r.markers.push({ tMs: this.offsetNow(), label: `${label} ${r.markers.length + 1}` });
    this.cues?.beep('mark');
    this.refreshWorkout();
  }

  /** Stops recording and moves the session to review. Returns null when nothing was recorded. */
  async finish(): Promise<SessionRecord | null> {
    const r = this.recording;
    if (!r) return null;
    if (r.openSince !== null) this.closeSegment(Math.max(r.openSince, this.lastPacketOffset()));
    const thresholds = r.workout.kind === 'ramp' ? estimateThresholds(this.dfa, this.hr) : null;
    const rec = { ...this.buildRecord('open'), thresholds };
    const chunk = this.takeChunk();
    this.recording = null;
    if (rec.rr.length === 0) {
      await this.sink.delete(rec.id).catch(() => undefined);
      this.update({ workout: null });
      return null;
    }
    await this.persist(rec, chunk);
    this.cues?.say('Treino encerrado.');
    this.update({ workout: null, review: rec });
    return rec;
  }

  /** Confirms the reviewed session with the athlete's notes. */
  async saveReview(meta: { readonly rpe: number | null; readonly notes: string; readonly sport: Sport; readonly name: string }): Promise<SessionRecord | null> {
    const rec = this.snap.review;
    if (!rec) return null;
    const done: SessionRecord = {
      ...rec,
      status: 'finished',
      rpe: meta.rpe,
      notes: meta.notes.trim(),
      sport: meta.sport,
      workout: rec.workout ? { ...rec.workout, name: meta.name.trim() || rec.workout.name } : rec.workout,
    };
    await this.persist(done);
    this.update({ review: null });
    return done;
  }

  async discardReview(): Promise<void> {
    const rec = this.snap.review;
    if (!rec) return;
    await this.sink.delete(rec.id);
    this.update({ review: null });
  }

  // ── sensor input ────────────────────────────────────────────────────────

  private readonly handleStatus = (sensor: SensorStatus): void => {
    const r = this.recording;
    if (sensor.state === 'streaming' && r && !r.deviceName) r.deviceName = sensor.deviceName;
    if (sensor.state !== 'streaming') {
      if (r && r.openSince !== null) this.sensorLost();
      // Without a workout the preview restarts with the next connection, gaps and all.
      if (!r) this.t0 = null;
    }
    this.update({ sensor });
  };

  private readonly handleEvent = (e: SensorEvent): void => {
    switch (e.kind) {
      case 'battery':
        this.update({ battery: e.percent });
        return;
      case 'ecg':
        for (const s of e.samplesUv) this.ecg[this.ecgWritten++ % ECG_DISPLAY_CAPACITY] = s;
        if (this.recording?.openSince != null) {
          const r = this.recording;
          for (const s of e.samplesUv) r.ecgPending.push(s);
          r.ecgSampleCount += e.samplesUv.length;
          r.ecgSegments[r.ecgSegments.length - 1]!.samples += e.samplesUv.length;
        }
        return;
      case 'acc':
        if (this.collecting()) this.dsp.post({ type: 'acc', samplesMg: e.samplesMg, gen: this.gen });
        return;
      case 'hr':
        this.handleHr(e.bpm, e.rrMs, e.contact);
        return;
    }
  };

  private handleHr(bpm: number, rrMs: readonly number[], contact: boolean | null): void {
    const nowMs = this.now();
    this.lastPacketAt = nowMs;
    const r = this.recording;
    if (!r && this.t0 === null) this.resetSeries(nowMs); // preview before a workout
    if (r && r.openSince === null && r.pauseReason === 'sensor') {
      this.openSegment(this.offsetNow());
      if (r.segments.length > 0) this.cues?.say('Sinal de volta. Gravando.');
    }
    let last = this.snap.lastRrMs;
    if (this.collecting()) {
      const tS = this.offsetNow() / 1000;
      if (bpm > 0) this.hr.push({ tS, bpm });
      const beats = rrMs.map((v) => this.rr.push(v));
      if (beats.length) this.dsp.post({ type: 'beats', beats, gen: this.gen });
    }
    if (rrMs.length) last = rrMs.at(-1)!;
    const win = this.rr.window(HRV_WINDOW_MS);
    const rate = artifactRate(win);
    this.update({
      bpm: bpm > 0 ? bpm : null,
      lastRrMs: last,
      rmssdMs: rmssd(win),
      artifactPct: rate === null ? null : rate * 100,
      contact,
      zone: this.zoneFor(bpm > 0 ? bpm : null),
    });
  }

  // ── time ────────────────────────────────────────────────────────────────

  private tick(): void {
    const r = this.recording;
    if (!r) return;
    if (r.openSince !== null && this.now() - this.lastPacketAt > STALL_MS) this.sensorLost();
    if (r.openSince !== null) this.runCues(r);
    if (this.now() - this.lastCheckpointAt >= CHECKPOINT_MS) void this.checkpoint();
    this.refreshWorkout();
  }

  private sensorLost(): void {
    const r = this.recording;
    if (!r || r.openSince === null) return;
    this.closeSegment(Math.max(r.openSince, this.lastPacketOffset()));
    r.pauseReason = 'sensor';
    this.cues?.beep('alert');
    this.cues?.say('Sinal perdido. Treino pausado.');
    void this.checkpoint();
  }

  private runCues(r: Recording): void {
    const activeS = this.activeS();
    const phases = r.workout.phases;
    const pos = phaseAt(phases, activeS);
    if (!pos) {
      if (phases.length && !r.planCompleteAnnounced) {
        r.planCompleteAnnounced = true;
        this.cues?.beep('go');
        this.cues?.say('Treino completo. Encerre quando quiser.');
      }
      return;
    }
    if (pos.index !== r.lastPhaseIndex) {
      r.lastPhaseIndex = pos.index;
      r.offTargetSince = null;
      r.nextRepeatCueS = pos.phase.repeatCue ? pos.phaseElapsedS + pos.phase.repeatCue.everyS : Infinity;
      this.cues?.beep('go');
      this.cues?.say(`${pos.phase.name}. ${pos.phase.cue}`);
    }
    const remaining = Math.ceil(pos.phaseRemainingS);
    if (pos.next && remaining <= 3 && remaining >= 1 && remaining !== r.lastCountdownS) {
      r.lastCountdownS = remaining;
      this.cues?.beep('tick');
    }
    if (pos.phase.repeatCue && pos.phaseElapsedS >= r.nextRepeatCueS && pos.phaseRemainingS > 5) {
      r.nextRepeatCueS += pos.phase.repeatCue.everyS;
      this.cues?.beep('mark');
      this.cues?.say(pos.phase.repeatCue.text);
    }
    const state = pos.phaseElapsedS < TARGET_GRACE_S ? 'unknown' : this.targetState(pos);
    const t = this.now();
    if (state === 'above' || state === 'below') {
      r.offTargetSince ??= t;
      if (t - r.offTargetSince >= TARGET_ALERT_AFTER_S * 1000 && t - r.lastAlertAt >= TARGET_ALERT_REPEAT_S * 1000) {
        r.lastAlertAt = t;
        this.cues?.beep('alert');
        this.cues?.say(state === 'above' ? 'Acima do alvo. Alivie.' : 'Abaixo do alvo. Pode subir.');
      }
    } else {
      r.offTargetSince = null;
    }
  }

  private targetState(pos: PhasePosition): TargetState {
    const recentDfa = this.dfa.at(-1);
    const alpha1 = recentDfa && recentDfa.alpha1 !== null && this.offsetNow() / 1000 - recentDfa.tS < 15 ? recentDfa.alpha1 : null;
    const bounds = this.bounds;
    return evaluateTarget(pos.phase.target, { hr: this.snap.bpm, alpha1 }, bounds ? (h) => zoneOf(h, bounds) : null);
  }

  // ── segments & persistence ──────────────────────────────────────────────

  private openSegment(atMs: number): void {
    const r = this.recording!;
    r.openSince = atMs;
    r.pauseReason = null;
    r.ecgSegments.push({ startMs: atMs, samples: 0 });
    this.rr.resumeAt(atMs);
    this.gen++;
    this.dsp.post({ type: 'reset', fromMs: atMs, gen: this.gen });
  }

  private closeSegment(atMs: number): void {
    const r = this.recording!;
    if (r.openSince === null) return;
    if (atMs > r.openSince) r.segments.push({ startMs: r.openSince, endMs: atMs });
    r.openSince = null;
  }

  private activeS(): number {
    return this.segments().reduce((s, g) => s + (g.endMs - g.startMs), 0) / 1000;
  }

  private buildRecord(status: SessionRecord['status']): SessionRecord {
    const r = this.recording!;
    const segments = this.segments();
    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id: r.id,
      startedAtIso: r.startedAtIso,
      status,
      durationS: segments.reduce((s, g) => s + (g.endMs - g.startMs), 0) / 1000,
      segments,
      source: r.source,
      deviceName: r.deviceName,
      sport: r.sport,
      workout: r.workout,
      markers: [...r.markers],
      rpe: null,
      notes: '',
      ecgHz: ECG_HZ,
      ecgSampleCount: r.ecgSampleCount,
      ecgSegments: r.ecgSegments.filter((s) => s.samples > 0).map((s) => ({ ...s })),
      ecgChunks: r.ecgChunks + (r.ecgPending.length ? 1 : 0),
      hr: [...this.hr],
      rr: [...this.rr.all()],
      dfa: [...this.dfa],
      inertial: [...this.inertial],
      thresholds: null,
    };
  }

  private takeChunk(): { seq: number; samples: Int32Array } | undefined {
    const r = this.recording!;
    if (!r.ecgPending.length) return undefined;
    const chunk = { seq: r.ecgChunks, samples: Int32Array.from(r.ecgPending) };
    r.ecgChunks++;
    r.ecgPending = [];
    return chunk;
  }

  /** Writes the open session; ECG since the last checkpoint goes as one new chunk. */
  async checkpoint(): Promise<void> {
    const r = this.recording;
    if (!r || this.rr.all().length === 0) return;
    this.lastCheckpointAt = this.now();
    const rec = this.buildRecord('open');
    await this.persist(rec, this.takeChunk());
  }

  private persist(rec: SessionRecord, chunk?: { seq: number; samples: Int32Array }): Promise<void> {
    // Serialize writes: a slow checkpoint must not land after the final save.
    this.saving = this.saving.then(async () => {
      try {
        await this.sink.save(rec, chunk);
        this.update({ save: { state: 'saved', at: this.now() } });
      } catch (err) {
        this.update({ save: { state: 'error', message: err instanceof Error ? err.message : String(err) } });
      }
    });
    return this.saving;
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private resetSeries(t0: number): void {
    this.t0 = t0;
    this.hr = [];
    this.rr = new RrSeries();
    this.dfa = [];
    this.inertial = [];
    this.gen++;
    this.dsp.post({ type: 'reset', fromMs: 0, gen: this.gen });
    this.update({ dfa: null, inertial: null });
  }

  /** Preview before a workout, or an open recording segment. Paused = not collecting. */
  private collecting(): boolean {
    return this.recording ? this.recording.openSince !== null : this.t0 !== null;
  }

  private dataFresh(): boolean {
    return this.snap.sensor.state === 'streaming' && this.now() - this.lastPacketAt < STALL_MS;
  }

  private lastPacketOffset(): number {
    return this.t0 === null ? 0 : this.lastPacketAt - this.t0;
  }

  private zoneFor(bpm: number | null): Zone | null {
    return bpm === null || !this.bounds ? null : zoneOf(bpm, this.bounds);
  }

  private refreshWorkout(): void {
    const r = this.recording;
    if (!r) {
      if (this.snap.workout) this.update({ workout: null });
      return;
    }
    const activeS = this.activeS();
    const position = phaseAt(r.workout.phases, activeS);
    this.update({
      workout: {
        id: r.id,
        name: r.workout.name,
        kind: r.workout.kind,
        sport: r.sport,
        state: r.openSince !== null ? 'running' : 'paused',
        pauseReason: r.openSince !== null ? null : r.pauseReason,
        startedAtIso: r.startedAtIso,
        activeS,
        elapsedS: this.offsetNow() / 1000,
        totalPlanS: totalDurationS(r.workout.phases),
        position,
        target: position && position.phaseElapsedS >= TARGET_GRACE_S ? this.targetState(position) : 'unknown',
        markers: r.markers.length,
        planComplete: r.workout.phases.length > 0 && position === null,
      },
    });
  }

  private update(patch: Partial<LiveSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }
}
