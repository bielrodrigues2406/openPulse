/**
 * Audio cues for training without looking at the screen: short beeps (Web Audio) and
 * spoken prompts (speech synthesis, pt-BR). Both are optional and fail silently: a
 * missing voice must never interrupt a workout.
 */

export interface CueSettings {
  readonly sound: boolean;
  readonly voice: boolean;
}

export type Beep = 'tick' | 'go' | 'mark' | 'alert';

const TONES: Record<Beep, readonly [freq: number, ms: number][]> = {
  tick: [[880, 90]],
  go: [[1320, 220]],
  mark: [[660, 70], [990, 90]],
  alert: [[520, 140], [390, 220]],
};

export class Cues {
  private ctx: AudioContext | null = null;
  private settings: CueSettings = { sound: true, voice: true };

  configure(s: CueSettings): void {
    this.settings = s;
  }

  /** Browsers only allow audio after a user gesture; call from a click handler. */
  unlock(): void {
    try {
      this.ctx ??= new AudioContext();
      void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  beep(kind: Beep): void {
    if (!this.settings.sound || !this.ctx) return;
    const ctx = this.ctx;
    let at = ctx.currentTime;
    for (const [freq, ms] of TONES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.18, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + ms / 1000 + 0.02);
      at += ms / 1000 + 0.04;
    }
  }

  say(text: string): void {
    if (!this.settings.voice || typeof speechSynthesis === 'undefined' || !text) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'pt-BR';
      const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('pt'));
      if (voice) u.voice = voice;
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch {
      // No voice available: the beep already signalled the event.
    }
  }
}
