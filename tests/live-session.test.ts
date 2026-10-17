import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveSession, type DspChannel, type SessionSink } from '../src/app/live-session';
import type { Cues } from '../src/app/cues';
import { SensorBase } from '../src/adapters/listeners';
import { DfaTracker } from '../src/domain/physiology/dfa-alpha1';
import { InertialTracker } from '../src/domain/physiology/inertial-fusion';
import type { SessionRecord } from '../src/domain/session/recorded-session';
import { FREE_WORKOUT, phase, type WorkoutTemplate } from '../src/domain/workouts/workout';

class FakeStrap extends SensorBase {
  readonly label = 'fake';
  async connect() {
    this.setStatus({ state: 'streaming', deviceName: 'Fake H10' });
  }
  disconnect() {
    this.setStatus({ state: 'idle' });
  }
  beat(bpm = 60) {
    this.emit({ kind: 'hr', bpm, rrMs: [60000 / bpm], contact: true, receivedAt: 0 });
  }
  ecg(n: number) {
    this.emit({ kind: 'ecg', samplesUv: Int32Array.from({ length: n }, (_, i) => i), receivedAt: 0 });
  }
}

/** Runs the real trackers synchronously, like the worker would. */
function syncDsp(): DspChannel & { resets: number[] } {
  let listener: Parameters<DspChannel['onMessage']>[0] = () => {};
  let dfa = new DfaTracker();
  let inertial = new InertialTracker();
  const resets: number[] = [];
  return {
    resets,
    onMessage: (l) => (listener = l),
    post: (msg) => {
      if (msg.type === 'reset') {
        resets.push(msg.fromMs);
        dfa = new DfaTracker(msg.fromMs);
        inertial = new InertialTracker(msg.fromMs);
      } else if (msg.type === 'beats') {
        inertial.pushBeats(msg.beats);
        const points = dfa.push(msg.beats);
        if (points.length) listener({ type: 'dfa', points, gen: msg.gen });
      } else {
        const points = inertial.pushAcc(msg.samplesMg);
        if (points.length) listener({ type: 'inertial', points, gen: msg.gen });
      }
    },
  };
}

function memorySink(): SessionSink & { records: Map<string, SessionRecord>; chunks: Map<string, number[]>; deleted: string[] } {
  const records = new Map<string, SessionRecord>();
  const chunks = new Map<string, number[]>();
  const deleted: string[] = [];
  return {
    records, chunks, deleted,
    async save(rec, chunk) {
      records.set(rec.id, rec);
      if (chunk) chunks.set(rec.id, [...(chunks.get(rec.id) ?? []), chunk.seq]);
    },
    async delete(id) {
      deleted.push(id);
      records.delete(id);
    },
  };
}

function fakeCues() {
  const said: string[] = [];
  const beeps: string[] = [];
  const cues = { say: (t: string) => said.push(t), beep: (b: string) => beeps.push(b) } as unknown as Cues;
  return { cues, said, beeps };
}

async function seconds(strap: FakeStrap | null, n: number, bpm = 60) {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(1000);
    strap?.beat(bpm);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());

async function setup(cues: Cues | null = null) {
  const strap = new FakeStrap();
  const sink = memorySink();
  const dsp = syncDsp();
  const live = new LiveSession(sink, dsp, cues);
  live.attach(strap, 'sim');
  await strap.connect();
  strap.beat();
  return { strap, sink, dsp, live };
}

describe('LiveSession', () => {
  it('records, checkpoints while running, then finishes into review and saves as finished', async () => {
    const { strap, sink, live } = await setup();
    live.start(FREE_WORKOUT, 'bike-indoor');
    expect(live.getSnapshot().workout).toMatchObject({ state: 'running', name: 'Treino livre' });
    strap.ecg(130);
    await seconds(strap, 30);
    const open = [...sink.records.values()][0]!;
    expect(open.status).toBe('open');
    expect(open.ecgSampleCount).toBe(130);

    const rec = (await live.finish())!;
    expect(rec.status).toBe('open');
    expect(rec.durationS).toBeCloseTo(30, 0);
    expect(rec.segments).toHaveLength(1);
    expect(live.getSnapshot().review?.id).toBe(rec.id);
    expect(live.getSnapshot().workout).toBeNull();

    const done = (await live.saveReview({ rpe: 6, notes: ' boa ', sport: 'run', name: '' }))!;
    expect(sink.records.get(rec.id)).toMatchObject({ status: 'finished', rpe: 6, notes: 'boa', sport: 'run' });
    expect(done.workout!.name).toBe('Treino livre');
    expect(live.getSnapshot().review).toBeNull();
  });

  it('a lost sensor closes the segment; data coming back opens a new one, with a real gap', async () => {
    const { strap, dsp, live } = await setup();
    live.start(FREE_WORKOUT, 'bike-indoor');
    await seconds(strap, 20);
    await seconds(null, 15); // strap silent
    expect(live.getSnapshot().workout).toMatchObject({ state: 'paused', pauseReason: 'sensor' });
    await seconds(strap, 20);
    expect(live.getSnapshot().workout!.state).toBe('running');
    const rec = (await live.finish())!;
    expect(rec.segments).toHaveLength(2);
    const [a, b] = rec.segments;
    expect(b!.startMs - a!.endMs).toBeGreaterThan(10_000);
    expect(rec.durationS).toBeGreaterThan(38);
    expect(rec.durationS).toBeLessThan(42);
    expect(rec.rr.filter((x) => x.gapBefore)).toHaveLength(1);
    expect(dsp.resets.at(-1)).toBe(b!.startMs); // DFA restarts at the new segment
  });

  it('user pause stops collecting even while the strap keeps sending', async () => {
    const { strap, live } = await setup();
    live.start(FREE_WORKOUT, 'bike-indoor');
    await seconds(strap, 10);
    live.pause();
    await seconds(strap, 10);
    expect(live.getSnapshot().workout).toMatchObject({ state: 'paused', pauseReason: 'user' });
    live.unpause();
    await seconds(strap, 10);
    const rec = (await live.finish())!;
    expect(rec.segments).toHaveLength(2);
    expect(rec.durationS).toBeCloseTo(20, 0);
    expect(rec.hr.length).toBeLessThanOrEqual(22);
  });

  it('resumes an interrupted session from storage and keeps appending to it', async () => {
    const first = await setup();
    first.live.start(FREE_WORKOUT, 'bike-indoor');
    first.strap.ecg(260);
    await seconds(first.strap, 25);
    await first.live.checkpoint();
    const stored = [...first.sink.records.values()][0]!;
    first.live.dispose(); // app closed

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const second = await setup();
    second.sink.records.set(stored.id, stored);
    second.live.resume(stored);
    second.strap.ecg(130);
    await seconds(second.strap, 15);
    const rec = (await second.live.finish())!;
    expect(rec.id).toBe(stored.id);
    expect(rec.segments).toHaveLength(2);
    expect(rec.segments[1]!.startMs).toBeGreaterThan(5 * 60_000);
    expect(rec.ecgSampleCount).toBe(390);
    expect(rec.ecgSegments.map((s) => s.samples)).toEqual([260, 130]);
    expect(second.sink.chunks.get(stored.id)).toEqual([stored.ecgChunks]); // seq continues
  });

  it('nothing recorded → no session is kept', async () => {
    const { live, sink } = await setup();
    live.start(FREE_WORKOUT, 'bike-indoor');
    expect(await live.finish()).toBeNull();
    expect(sink.records.size).toBe(0);
  });

  it('structured workout: announces phases, counts down, repeats the ramp cue', async () => {
    const { cues, said, beeps } = fakeCues();
    const { strap, live } = await setup(cues);
    const t: WorkoutTemplate = {
      id: 'x', name: 'X', kind: 'ramp', sport: 'bike-indoor', description: '', builtIn: false,
      phases: [phase('Aquecimento', 0.5, undefined, 'Leve.'), phase('Rampa', 2.5, undefined, 'Suba.', { everyS: 60, text: 'Suba um nível.' })],
    };
    live.start(t, 'bike-indoor');
    await seconds(strap, 31);
    expect(said[0]).toBe('Aquecimento. Leve.');
    expect(said).toContain('Rampa. Suba.');
    expect(beeps.filter((b) => b === 'tick')).toHaveLength(3);
    await seconds(strap, 65);
    expect(said.filter((s) => s === 'Suba um nível.')).toHaveLength(1);
    expect(live.getSnapshot().workout!.position!.phase.name).toBe('Rampa');
    await seconds(strap, 90);
    expect(live.getSnapshot().workout!.planComplete).toBe(true);
    expect(said.at(-1)).toMatch(/Treino completo/);
  });

  it('ramp steps: a lap per repeat cue, numbered apart from manual laps', async () => {
    const { cues } = fakeCues();
    const { strap, live } = await setup(cues);
    const t: WorkoutTemplate = {
      id: 'r', name: 'R', kind: 'ramp', sport: 'bike-indoor', description: '', builtIn: false,
      phases: [phase('Rampa', 10, undefined, '', { everyS: 60, text: 'Gire.', lap: true })],
    };
    live.start(t, 'bike-indoor');
    await seconds(strap, 30);
    live.mark();
    await seconds(strap, 100);
    const rec = (await live.finish())!;
    expect(rec.markers.map((m) => m.label)).toEqual(['Volta 1', 'Degrau 1', 'Degrau 2']);
  });

  it('warns when the cadence estimate stays off target, and says when the ramp has reached α1 < 0.50', async () => {
    const { cues, said } = fakeCues();
    const { strap, live } = await setup(cues);
    const t: WorkoutTemplate = {
      id: 'r', name: 'R', kind: 'ramp', sport: 'bike-indoor', description: '', builtIn: false,
      phases: [phase('Rampa', 20, undefined, '', null, 90)],
    };
    live.start(t, 'bike-indoor');
    await seconds(strap, 40);
    // Inject what the worker would have produced: cadence 80 and α1 well below 0.5.
    const nowS = live.offsetNow() / 1000;
    for (let k = 0; k < 40; k++) {
      live.inertial.push({ tS: nowS + k, breathsPerMin: null, breathSource: null, breathConfidence: 0, rpm: 80, rpmConfidence: 0.9, swayMg: 10 });
    }
    for (let k = -110; k < 40; k += 5) live.dfa.push({ tS: nowS + k, alpha1: 0.42, artifactPct: 0, beats: 300 });
    await seconds(strap, 35);
    expect(said).toContain('Cadência abaixo de 90.');
    expect(live.getSnapshot().workout).toMatchObject({ cadenceTarget: 90, cadenceNow: 80 });
    expect(said.some((x) => x.includes('Limiar dois alcançado'))).toBe(true);
    expect(live.getSnapshot().workout!.rampDone).toBe(true);
  });
});

