import { describe, expect, it } from 'vitest';
import { connectGatt, describeBleError } from '../src/adapters/web-bluetooth-h10.adapter';

function fakeDevice(results: ('ok' | 'busy' | 'hang')[]) {
  const calls = { connect: 0, disconnect: 0 };
  const gatt = {
    connected: false,
    connect() {
      const r = results[calls.connect++] ?? 'ok';
      if (r === 'ok') return Promise.resolve(gatt);
      if (r === 'busy') return Promise.reject(new DOMException('Connection already in progress.', 'NetworkError'));
      return new Promise<never>(() => {});
    },
    disconnect() {
      calls.disconnect++;
    },
    getPrimaryService: () => Promise.reject(new Error('unused')),
  } as unknown as BluetoothRemoteGATTServer;
  const device = { name: 'Polar H10 TEST', gatt } as unknown as BluetoothDevice;
  return { device, gatt, calls };
}
const instant = () => Promise.resolve();

describe('connectGatt', () => {
  it('cancels the stuck attempt and retries after "already in progress"', async () => {
    const { device, gatt, calls } = fakeDevice(['busy', 'ok']);
    await expect(connectGatt(device, instant)).resolves.toBe(gatt);
    expect(calls).toEqual({ connect: 2, disconnect: 1 });
  });

  it('bounds a hanging connect with a timeout, then retries', async () => {
    const { device, gatt, calls } = fakeDevice(['hang', 'ok']);
    await expect(connectGatt(device, instant)).resolves.toBe(gatt);
    expect(calls.connect).toBe(2);
  });

  it('gives up after 3 attempts with the last error', async () => {
    const { device, calls } = fakeDevice(['busy', 'busy', 'busy', 'ok']);
    await expect(connectGatt(device, instant)).rejects.toThrow(/already in progress/);
    expect(calls).toEqual({ connect: 3, disconnect: 3 });
  });
});

describe('describeBleError', () => {
  it('translates the known Chrome failures', () => {
    expect(describeBleError(new DOMException('Connection already in progress.', 'NetworkError'))).toMatch(/conexão anterior/);
    expect(describeBleError(new DOMException('x', 'TimeoutError'))).toMatch(/não respondeu/);
    expect(describeBleError(new DOMException('GATT Server is disconnected.', 'NetworkError'))).toMatch(/perdida/);
    expect(describeBleError(new Error('outro'))).toBe('outro');
  });
});
