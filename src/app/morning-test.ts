import { ORTHO_LYING_S, ORTHO_STANDING_S, analyzeOrthostatic, type OrthostaticResult } from '../domain/physiology/orthostatic';
import { RrSeries } from '../domain/physiology/rr-quality';
import type { PolarSensor, SensorEvent } from '../domain/ports/polar-sensor.port';
import type { Cues } from './cues';

export type MorningState =
  | { readonly step: 'idle' }
  | { readonly step: 'lying' | 'standing'; readonly remainingS: number; readonly bpm: number | null; readonly beats: number }
  | { readonly step: 'done'; readonly result: OrthostaticResult }
  | { readonly step: 'failed'; readonly reason: string };

/** Guided 3-minute orthostatic test: 90 s lying, stand up, 90 s standing. */
export class MorningTest {
  private state: MorningState = { step: 'idle' };
  private readonly listeners = new Set<() => void>();
  private rr = new RrSeries();
  private startedAt = 0;
  private standUpMs = 0;
  private bpm: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private detach: (() => void) | null = null;

  constructor(
    private readonly onResult: (r: OrthostaticResult) => Promise<void>,
    private readonly cues: Cues | null,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getState = (): MorningState => this.state;

  start(sensor: PolarSensor): void {
    this.stop();
    this.rr = new RrSeries();
    this.bpm = null;
    this.startedAt = this.now();
    this.detach = sensor.onEvent(this.handle);
    this.cues?.beep('go');
    this.cues?.say('Deite e fique imóvel. Respire normalmente.');
    this.set({ step: 'lying', remainingS: ORTHO_LYING_S, bpm: null, beats: 0 });
    this.timer = setInterval(() => void this.tick(), 250);
  }

  cancel(): void {
    this.stop();
    this.set({ step: 'idle' });
  }

  private stop(): void {
    this.detach?.();
    this.detach = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private readonly handle = (e: SensorEvent): void => {
    if (e.kind !== 'hr') return;
    this.bpm = e.bpm > 0 ? e.bpm : this.bpm;
    for (const v of e.rrMs) this.rr.push(v);
  };

  private async tick(): Promise<void> {
    const s = this.state;
    if (s.step !== 'lying' && s.step !== 'standing') return;
    const t = this.now() - this.startedAt;
    if (s.step === 'lying' && t >= ORTHO_LYING_S * 1000) {
      // RR time is the beat clock; anchor the stand-up there so both phases use one timeline.
      this.standUpMs = this.rr.all().at(-1)?.tMs ?? t;
      this.cues?.beep('go');
      this.cues?.say('Levante agora e fique parado em pé.');
      this.set({ step: 'standing', remainingS: ORTHO_STANDING_S, bpm: this.bpm, beats: this.rr.all().length });
      return;
    }
    if (s.step === 'standing' && t >= (ORTHO_LYING_S + ORTHO_STANDING_S) * 1000) {
      this.stop();
      const out = analyzeOrthostatic(this.rr.all(), this.standUpMs);
      if (!out.ok) {
        this.cues?.beep('alert');
        this.set({ step: 'failed', reason: out.reason });
        return;
      }
      const result: OrthostaticResult = { ...out.result, id: crypto.randomUUID(), dateIso: new Date(this.startedAt).toISOString() };
      this.cues?.beep('go');
      this.cues?.say('Teste concluído.');
      await this.onResult(result);
      this.set({ step: 'done', result });
      return;
    }
    const phaseEnd = s.step === 'lying' ? ORTHO_LYING_S : ORTHO_LYING_S + ORTHO_STANDING_S;
    const remainingS = Math.max(0, Math.ceil(phaseEnd - t / 1000));
    if (remainingS <= 3 && remainingS >= 1 && remainingS !== s.remainingS) this.cues?.beep('tick');
    this.set({ ...s, remainingS, bpm: this.bpm, beats: this.rr.all().length });
  }

  private set(s: MorningState): void {
    this.state = s;
    for (const l of this.listeners) l();
  }
}
