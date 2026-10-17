import { afterEach, describe, expect, it } from 'vitest';
import { WebBluetoothH10Adapter } from '../src/adapters/web-bluetooth-h10.adapter';
import type { SensorStatus } from '../src/domain/ports/polar-sensor.port';

/** A fake H10 reproducing the Windows field log: HR works, touching PMD drops the link. */
class FakeChar extends EventTarget {
  value: DataView | null = null;
  async startNotifications() {
    return this;
  }
  notify(bytes: number[]) {
    this.value = new DataView(Uint8Array.from(bytes).buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function fakeStrap(pmdDropsLink: boolean, failConnects = 0) {
  const hr = new FakeChar();
  const device = new EventTarget() as EventTarget & { name: string; gatt: unknown };
  const stats = { connects: 0, pmdRequests: 0 };
  const gatt = {
    connected: false,
    async connect() {
      stats.connects++;
      if (failConnects > 0 && stats.connects > 1) {
        failConnects--;
        throw new DOMException('Connection Error: Connection attempt failed.', 'NetworkError');
      }
      gatt.connected = true;
      return gatt;
    },
    disconnect() {
      if (!gatt.connected) return;
      gatt.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
    async getPrimaryService(uuid: number | string) {
      if (uuid === 0x180d) return { getCharacteristic: async () => hr };
      if (uuid === 0x180f) return { getCharacteristic: async () => ({ readValue: async () => new DataView(Uint8Array.of(90).buffer) }) };
      stats.pmdRequests++;
      if (pmdDropsLink) {
        queueMicrotask(() => gatt.disconnect());
        throw new DOMException('Connection Error: Connection attempt failed.', 'NetworkError');
      }
      throw new Error('PMD not modelled');
    },
  };
  device.name = 'Polar H10 TEST';
  device.gatt = gatt;
  Object.defineProperty(globalThis.navigator, 'bluetooth', {
    configurable: true,
    value: { requestDevice: async () => device },
  });
  return { hr, gatt, stats };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const hrPacket = [0x16, 70, 0x00, 0x04]; // 70 bpm, contact, one R-R

afterEach(() => {
  Reflect.deleteProperty(globalThis.navigator, 'bluetooth');
});

describe('WebBluetoothH10Adapter', () => {
  it('streams HR before touching PMD', async () => {
    const { stats } = fakeStrap(true);
    const a = new WebBluetoothH10Adapter();
    const statuses: SensorStatus[] = [];
    a.onStatus((s) => statuses.push(s));
    const battery: number[] = [];
    a.onEvent((e) => e.kind === 'battery' && battery.push(e.percent));
    await a.connect();
    await tick();
    expect(statuses.at(-1)).toEqual({ state: 'streaming', deviceName: 'Polar H10 TEST' });
    expect(stats.pmdRequests).toBe(0);
    expect(battery).toEqual([90]);
  });

  it('when PMD drops the link: reconnects HR-only, never retries PMD, keeps the session alive', async () => {
    const { hr, gatt, stats } = fakeStrap(true);
    const a = new WebBluetoothH10Adapter();
    const statuses: SensorStatus[] = [];
    const bpm: number[] = [];
    a.onStatus((s) => statuses.push(s));
    a.onEvent((e) => e.kind === 'hr' && bpm.push(e.bpm));
    await a.connect();

    hr.notify(hrPacket); // first beat → PMD attempt → link drops → auto-reconnect
    for (let i = 0; i < 5; i++) await tick();

    expect(stats.pmdRequests).toBe(1);
    expect(stats.connects).toBe(2);
    expect(gatt.connected).toBe(true);
    expect(statuses.some((s) => s.state === 'idle' || s.state === 'error')).toBe(false);
    expect(statuses.at(-1)).toMatchObject({ state: 'streaming', deviceName: expect.stringContaining('só FC') });

    hr.notify(hrPacket);
    await tick();
    expect(stats.pmdRequests).toBe(1);
    expect(bpm).toEqual([70, 70]);
    expect(a.diagnostics().join('\n')).toMatch(/derrubou a conexão/);
  });

  it('a user disconnect goes idle without reconnecting', async () => {
    const { stats } = fakeStrap(true);
    const a = new WebBluetoothH10Adapter();
    const statuses: SensorStatus[] = [];
    a.onStatus((s) => statuses.push(s));
    await a.connect();
    a.disconnect();
    await tick();
    expect(statuses.at(-1)).toEqual({ state: 'idle' });
    expect(stats.connects).toBe(1);
  });

  it('gives up with an error after repeated drops that deliver no data', async () => {
    const { gatt } = fakeStrap(false);
    const a = new WebBluetoothH10Adapter();
    const statuses: SensorStatus[] = [];
    a.onStatus((s) => statuses.push(s));
    await a.connect();
    for (let i = 0; i < 4; i++) {
      gatt.disconnect();
      for (let k = 0; k < 5; k++) await tick();
    }
    expect(statuses.at(-1)).toMatchObject({ state: 'error' });
  });

  it('keeps trying to reconnect for a while instead of giving up after a few quick failures', async () => {
    const { hr, gatt, stats } = fakeStrap(false, 12);
    const waits: number[] = [];
    const a = new WebBluetoothH10Adapter(async (ms) => { waits.push(ms); });
    const statuses: SensorStatus[] = [];
    a.onStatus((s) => statuses.push(s));
    await a.connect();
    gatt.disconnect();
    for (let k = 0; k < 200; k++) await tick();
    expect(stats.connects).toBe(14);
    expect(statuses.at(-1)).toEqual({ state: 'streaming', deviceName: 'Polar H10 TEST' });
    expect(statuses.some((s) => s.state === 'error')).toBe(false);
    expect(waits.filter((w) => w >= 2000).length).toBeGreaterThan(0);
    hr.notify(hrPacket);
  });

  it('stops reconnecting when the user disconnects mid-way', async () => {
    const { gatt, stats } = fakeStrap(false, 100);
    const a = new WebBluetoothH10Adapter(tick);
    const statuses: SensorStatus[] = [];
    a.onStatus((s) => statuses.push(s));
    await a.connect();
    gatt.disconnect();
    for (let k = 0; k < 15; k++) await tick();
    a.disconnect();
    for (let k = 0; k < 200; k++) await tick();
    expect(statuses.at(-1)).toEqual({ state: 'idle' });
    expect(stats.connects).toBeLessThan(30);
  });
});
