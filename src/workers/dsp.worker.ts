/// <reference lib="webworker" />
import { DfaTracker } from '../domain/physiology/dfa-alpha1';
import { InertialTracker } from '../domain/physiology/inertial-fusion';
import type { DspRequest, DspResponse, Tagged } from './dsp.protocol';

// Heavy signal processing lives here so the ECG canvas keeps its frame rate.
let dfa = new DfaTracker();
let inertial = new InertialTracker();

// Replies carry the generation of the request that produced them, so the page can drop
// results that belong to a segment it has already moved past.
const post = (msg: Tagged<DspResponse>) => (self as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (e: MessageEvent<Tagged<DspRequest>>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'reset':
      dfa = new DfaTracker(msg.fromMs);
      inertial = new InertialTracker(msg.fromMs);
      return;
    case 'beats': {
      inertial.pushBeats(msg.beats);
      const points = dfa.push(msg.beats);
      if (points.length) post({ type: 'dfa', points, gen: msg.gen });
      return;
    }
    case 'acc': {
      const points = inertial.pushAcc(msg.samplesMg);
      if (points.length) post({ type: 'inertial', points, gen: msg.gen });
      return;
    }
  }
};
