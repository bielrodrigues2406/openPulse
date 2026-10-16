/// <reference lib="webworker" />
import { DfaTracker } from '../domain/physiology/dfa-alpha1';
import type { DspRequest, DspResponse } from './dsp.protocol';

let tracker = new DfaTracker();

self.onmessage = (e: MessageEvent<DspRequest>) => {
  const msg = e.data;
  if (msg.type === 'reset') {
    tracker = new DfaTracker();
    return;
  }
  const points = tracker.push(msg.beats);
  if (points.length) (self as DedicatedWorkerGlobalScope).postMessage({ type: 'dfa', points } satisfies DspResponse);
};
