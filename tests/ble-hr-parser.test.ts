import { describe, expect, it } from 'vitest';
import { parseHeartRateMeasurement } from '../src/domain/physiology/ble-hr-parser';

const view = (...b: number[]) => new DataView(Uint8Array.from(b).buffer);

describe('parseHeartRateMeasurement', () => {
  it('reads uint8 HR with two RR intervals at 1/1024 s', () => {
    // flags: RR present + contact supported + detected
    const m = parseHeartRateMeasurement(view(0x16, 72, 0x00, 0x04, 0x00, 0x02));
    expect(m.bpm).toBe(72);
    expect(m.contact).toBe(true);
    expect(m.rrMs).toEqual([1000, 500]); // 1024/1024 s, 512/1024 s
  });

  it('reads uint16 HR and skips energy expended', () => {
    const m = parseHeartRateMeasurement(view(0x19, 0x2c, 0x01, 0xff, 0xff, 0x00, 0x03));
    expect(m.bpm).toBe(300);
    expect(m.contact).toBeNull();
    expect(m.rrMs).toEqual([750]);
  });

  it('reports lost skin contact', () => {
    expect(parseHeartRateMeasurement(view(0x04, 0)).contact).toBe(false);
  });

  it('rejects truncated packets instead of inventing values', () => {
    expect(() => parseHeartRateMeasurement(view(0x00))).toThrow(RangeError);
    expect(() => parseHeartRateMeasurement(view(0x01, 0x10))).toThrow(RangeError);
    expect(() => parseHeartRateMeasurement(view(0x10, 60, 0x00))).toThrow(RangeError);
  });

  it('round-trips any RR tick value within 1 ms', () => {
    for (let ticks = 0; ticks <= 0xffff; ticks += 97) {
      const m = parseHeartRateMeasurement(view(0x10, 60, ticks & 0xff, ticks >> 8));
      expect(Math.round((m.rrMs[0]! * 1024) / 1000)).toBe(ticks);
    }
  });
});
