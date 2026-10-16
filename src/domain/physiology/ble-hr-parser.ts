/** Parser for the standard Heart Rate Measurement characteristic (0x2A37). */

export interface HeartRateMeasurement {
  readonly bpm: number;
  /** null when the sensor does not support contact detection. */
  readonly contact: boolean | null;
  readonly rrMs: readonly number[];
}

const FLAG_HR_UINT16 = 0x01;
const FLAG_CONTACT_SUPPORTED = 0x04;
const FLAG_CONTACT_DETECTED = 0x02;
const FLAG_ENERGY_EXPENDED = 0x08;
const FLAG_RR_PRESENT = 0x10;

export function parseHeartRateMeasurement(view: DataView): HeartRateMeasurement {
  if (view.byteLength < 2) throw new RangeError(`HR packet too short: ${view.byteLength} bytes`);
  const flags = view.getUint8(0);
  let offset = 1;

  let bpm: number;
  if (flags & FLAG_HR_UINT16) {
    if (view.byteLength < 3) throw new RangeError('HR packet truncated (uint16 HR)');
    bpm = view.getUint16(offset, true);
    offset += 2;
  } else {
    bpm = view.getUint8(offset);
    offset += 1;
  }

  const contact = flags & FLAG_CONTACT_SUPPORTED ? (flags & FLAG_CONTACT_DETECTED) !== 0 : null;

  if (flags & FLAG_ENERGY_EXPENDED) offset += 2;

  const rrMs: number[] = [];
  if (flags & FLAG_RR_PRESENT) {
    if ((view.byteLength - offset) % 2 !== 0) throw new RangeError('HR packet has odd number of RR bytes');
    for (; offset + 1 < view.byteLength; offset += 2) {
      rrMs.push((view.getUint16(offset, true) / 1024) * 1000);
    }
  }
  return { bpm, contact, rrMs };
}
