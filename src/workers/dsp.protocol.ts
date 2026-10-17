import type { DfaPoint } from '../domain/physiology/dfa-alpha1';
import type { InertialPoint } from '../domain/physiology/inertial-fusion';
import type { RrBeat } from '../domain/physiology/rr-quality';

/** fromMs: start of the current recording segment, in the session's wall-clock offset. */
export type DspRequest =
  | { readonly type: 'reset'; readonly fromMs: number }
  | { readonly type: 'beats'; readonly beats: readonly RrBeat[] }
  | { readonly type: 'acc'; readonly samplesMg: Int16Array };

export type DspResponse =
  | { readonly type: 'dfa'; readonly points: readonly DfaPoint[] }
  | { readonly type: 'inertial'; readonly points: readonly InertialPoint[] };

export type Tagged<T> = T & { readonly gen: number };
