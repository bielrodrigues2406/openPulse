import type { DfaPoint } from '../domain/physiology/dfa-alpha1';
import type { RrBeat } from '../domain/physiology/rr-quality';

export type DspRequest = { readonly type: 'reset' } | { readonly type: 'beats'; readonly beats: readonly RrBeat[] };
export type DspResponse = { readonly type: 'dfa'; readonly points: readonly DfaPoint[] };
