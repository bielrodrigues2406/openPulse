/**
 * Parser for Polar Measurement Data (PMD) frames from the H10.
 *
 * Frame layout: [measurementType u8][timestamp u64 LE, ns since 2000-01-01][frameType u8][payload].
 * frameType bits 0..6 select sample resolution, bit 7 marks delta-compressed payload.
 * For H10: ECG uses type 0x00 (3-byte signed µV); ACC uses 0x00/0x01/0x02 for 8/16/24-bit mG.
 */

export const PMD_HEADER_BYTES = 10;

export const PmdMeasurement = { ECG: 0x00, ACC: 0x02 } as const;

export type PmdFrame =
  | { readonly kind: 'ecg'; readonly timestampNs: bigint; readonly samplesUv: Int32Array }
  | { readonly kind: 'acc'; readonly timestampNs: bigint; readonly samplesMg: Int16Array }; // interleaved x,y,z

const COMPRESSED_BIT = 0x80;

export function parsePmdFrame(bytes: Uint8Array): PmdFrame {
  if (bytes.length < PMD_HEADER_BYTES) throw new RangeError(`PMD frame too short: ${bytes.length} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const measurement = view.getUint8(0);
  const timestampNs = view.getBigUint64(1, true);
  const frameType = view.getUint8(9);
  const compressed = (frameType & COMPRESSED_BIT) !== 0;
  const typeCode = frameType & ~COMPRESSED_BIT;
  const payload = bytes.subarray(PMD_HEADER_BYTES);

  switch (measurement) {
    case PmdMeasurement.ECG: {
      if (compressed || typeCode !== 0x00) throw new RangeError(`Unsupported ECG frame type 0x${hex(frameType)}`);
      return { kind: 'ecg', timestampNs, samplesUv: Int32Array.from(readRaw(payload, 1, 24)) };
    }
    case PmdMeasurement.ACC: {
      const bits = accResolutionBits(typeCode);
      const samples = compressed ? readDeltaCompressed(payload, 3, bits) : readRaw(payload, 3, bits);
      return { kind: 'acc', timestampNs, samplesMg: Int16Array.from(samples, clampInt16) };
    }
    default:
      throw new RangeError(`Unsupported PMD measurement type 0x${hex(measurement)}`);
  }
}

function accResolutionBits(typeCode: number): number {
  switch (typeCode) {
    case 0x00: return 8;
    case 0x01: return 16;
    case 0x02: return 24;
    default: throw new RangeError(`Unsupported ACC frame type 0x${hex(typeCode)}`);
  }
}

/** Uncompressed little-endian signed samples, `channels` values per sample. */
function readRaw(payload: Uint8Array, channels: number, bits: number): number[] {
  const bytesPerValue = bits / 8;
  const stride = bytesPerValue * channels;
  if (payload.length % stride !== 0) {
    throw new RangeError(`Payload length ${payload.length} is not a multiple of sample size ${stride}`);
  }
  const out: number[] = [];
  for (let i = 0; i < payload.length; i += bytesPerValue) out.push(readSignedLE(payload, i, bytesPerValue));
  return out;
}

/**
 * Delta-compressed payload: one full-resolution reference sample, followed by blocks of
 * [deltaBits u8][sampleCount u8][bit-packed signed deltas, LSB first, channel-interleaved].
 */
function readDeltaCompressed(payload: Uint8Array, channels: number, bits: number): number[] {
  const refBytes = (bits / 8) * channels;
  if (payload.length < refBytes) throw new RangeError('Compressed payload shorter than reference sample');
  const current: number[] = [];
  for (let c = 0; c < channels; c++) current.push(readSignedLE(payload, c * (bits / 8), bits / 8));
  const out = [...current];

  let offset = refBytes;
  while (offset < payload.length) {
    if (offset + 2 > payload.length) throw new RangeError('Truncated delta block header');
    const deltaBits = payload[offset]!;
    const count = payload[offset + 1]!;
    offset += 2;
    if (deltaBits === 0 || deltaBits > 32) throw new RangeError(`Invalid delta width ${deltaBits}`);
    const blockBytes = Math.ceil((deltaBits * channels * count) / 8);
    if (offset + blockBytes > payload.length) throw new RangeError('Truncated delta block');

    let bitPos = 0;
    for (let s = 0; s < count; s++) {
      for (let c = 0; c < channels; c++) {
        current[c] = current[c]! + readSignedBits(payload, offset, bitPos, deltaBits);
        bitPos += deltaBits;
        out.push(current[c]!);
      }
    }
    offset += blockBytes;
  }
  return out;
}

function readSignedLE(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) value |= bytes[offset + i]! << (8 * i);
  const shift = 32 - 8 * length;
  return shift === 0 ? value | 0 : (value << shift) >> shift;
}

function readSignedBits(bytes: Uint8Array, byteOffset: number, bitOffset: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i++) {
    const bit = bitOffset + i;
    if ((bytes[byteOffset + (bit >> 3)]! >> (bit & 7)) & 1) value += 2 ** i;
  }
  return value >= 2 ** (width - 1) ? value - 2 ** width : value;
}

function clampInt16(v: number): number {
  return Math.max(-32768, Math.min(32767, v));
}

function hex(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** Control point commands. Settings are TLV: [type][count][u16 LE value]. */
export const PMD_START_ECG = Uint8Array.of(0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0e, 0x00);
/** 200 Hz, 16-bit, ±8 G. ±2 G saturates on bumps when getting on/off the bike. */
export const PMD_START_ACC = Uint8Array.of(0x02, 0x02, 0x00, 0x01, 0xc8, 0x00, 0x01, 0x01, 0x10, 0x00, 0x02, 0x01, 0x08, 0x00);
export const PMD_STOP_ECG = Uint8Array.of(0x03, 0x00);
export const PMD_STOP_ACC = Uint8Array.of(0x03, 0x02);
