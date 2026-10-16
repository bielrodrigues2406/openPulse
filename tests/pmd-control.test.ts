import { describe, expect, it } from 'vitest';
import { parsePmdControlResponse, pmdErrorText } from '../src/domain/physiology/pmd-control';

describe('parsePmdControlResponse', () => {
  it('reads op code, measurement and error code', () => {
    expect(parsePmdControlResponse(Uint8Array.of(0xf0, 0x02, 0x00, 0x00, 0x00))).toEqual({ opCode: 2, measurementType: 0, errorCode: 0 });
    expect(parsePmdControlResponse(Uint8Array.of(0xf0, 0x02, 0x02, 0x0c))).toEqual({ opCode: 2, measurementType: 2, errorCode: 12 });
  });
  it('ignores non-response indications and short packets', () => {
    expect(parsePmdControlResponse(Uint8Array.of(0x0f, 0x05, 0x00, 0x00))).toBeNull();
    expect(parsePmdControlResponse(Uint8Array.of(0xf0, 0x02))).toBeNull();
  });
  it('explains the errors the H10 actually returns', () => {
    expect(pmdErrorText(0x0c)).toMatch(/contato/);
    expect(pmdErrorText(0x0a)).toMatch(/MTU/);
    expect(pmdErrorText(0x42)).toBe('erro 0x42');
  });
});
