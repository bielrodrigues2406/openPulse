import { describe, expect, it } from 'vitest';
import { parsePmdFrame } from '../src/domain/physiology/pmd-stream-parser';

function header(measurement: number, frameType: number, ts = 123456789n): number[] {
  const b = new Uint8Array(10);
  const v = new DataView(b.buffer);
  v.setUint8(0, measurement);
  v.setBigUint64(1, ts, true);
  v.setUint8(9, frameType);
  return [...b];
}
const le = (value: number, bytes: number) => Array.from({ length: bytes }, (_, i) => (value >> (8 * i)) & 0xff);

/** Packs signed deltas LSB-first, the inverse of the parser. */
function packDeltas(deltas: number[], width: number): number[] {
  const out = new Array<number>(Math.ceil((deltas.length * width) / 8)).fill(0);
  deltas.forEach((d, k) => {
    const u = d < 0 ? d + 2 ** width : d;
    for (let i = 0; i < width; i++) {
      const bit = k * width + i;
      if (Math.floor(u / 2 ** i) % 2) out[bit >> 3]! |= 1 << (bit & 7);
    }
  });
  return out;
}

describe('parsePmdFrame', () => {
  it('decodes ECG as signed 24-bit µV and keeps the timestamp', () => {
    const values = [0, 1, -1, 1234, -8388608, 8388607];
    const f = parsePmdFrame(Uint8Array.from([...header(0x00, 0x00, 2n ** 60n), ...values.flatMap((x) => le(x, 3))]));
    expect(f.kind).toBe('ecg');
    expect(f.timestampNs).toBe(2n ** 60n);
    if (f.kind === 'ecg') expect([...f.samplesUv]).toEqual(values);
  });

  it('decodes ACC frame type 0x01 as 16-bit (6 bytes per sample)', () => {
    const xyz = [-12, -1000, 37, 32767, -32768, 0];
    const f = parsePmdFrame(Uint8Array.from([...header(0x02, 0x01), ...xyz.flatMap((x) => le(x, 2))]));
    expect(f.kind === 'acc' && [...f.samplesMg]).toEqual(xyz);
  });

  it('decodes ACC frame type 0x00 as 8-bit, not 16-bit', () => {
    const f = parsePmdFrame(Uint8Array.from([...header(0x02, 0x00), 0x01, 0xff, 0x80]));
    expect(f.kind === 'acc' && [...f.samplesMg]).toEqual([1, -1, -128]);
  });

  it('decodes delta-compressed ACC (frame type 0x81)', () => {
    const ref = [100, -980, 40];
    const deltas = [1, -2, 3, -4, 5, -6]; // two samples × 3 channels, 4-bit deltas
    const payload = [...ref.flatMap((x) => le(x, 2)), 4, 2, ...packDeltas(deltas, 4)];
    const f = parsePmdFrame(Uint8Array.from([...header(0x02, 0x81), ...payload]));
    expect(f.kind === 'acc' && [...f.samplesMg]).toEqual([100, -980, 40, 101, -982, 43, 97, -977, 37]);
  });

  it('property: compressed decoding equals cumulative sum of random deltas', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let trial = 0; trial < 200; trial++) {
      const width = 2 + Math.floor(rnd() * 10);
      const count = 1 + Math.floor(rnd() * 20);
      const ref = [0, 0, 0].map(() => Math.floor(rnd() * 2000) - 1000);
      const half = 2 ** (width - 1);
      const deltas = Array.from({ length: count * 3 }, () => Math.floor(rnd() * 2 * half) - half);
      const expected = [...ref];
      const cur = [...ref];
      deltas.forEach((d, i) => expected.push((cur[i % 3]! += d)));
      const payload = [...ref.flatMap((x) => le(x, 2)), width, count, ...packDeltas(deltas, width)];
      const f = parsePmdFrame(Uint8Array.from([...header(0x02, 0x81), ...payload]));
      expect(f.kind === 'acc' && [...f.samplesMg]).toEqual(expected);
    }
  });

  it('rejects malformed frames', () => {
    expect(() => parsePmdFrame(new Uint8Array(5))).toThrow(RangeError);
    expect(() => parsePmdFrame(Uint8Array.from([...header(0x00, 0x00), 1, 2]))).toThrow(/multiple/);
    expect(() => parsePmdFrame(Uint8Array.from([...header(0x02, 0x05)]))).toThrow(/ACC frame type/);
    expect(() => parsePmdFrame(Uint8Array.from([...header(0x09, 0x00)]))).toThrow(/measurement/);
    expect(() => parsePmdFrame(Uint8Array.from([...header(0x02, 0x81), ...le(0, 6), 8, 5, 0]))).toThrow(/Truncated/);
  });
});
