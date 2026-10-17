import { describe, expect, it, vi } from 'vitest';
import { NativeH10Adapter, type NativeBleTransport, type NativeCharKey } from '../src/adapters/native-h10.adapter';
import type { SensorEvent, SensorStatus } from '../src/domain/ports/polar-sensor.port';

/**
 * A fake of the shell's native Bluetooth. `bond` models Windows' pairing record:
 * 'ok' works, 'stale' means Windows kept keys the strap dropped (pairing fails, or the link dies
 * when ECG asks for encryption), 'none' pairs on request.
 */
function fakeShell(opts: { bond?: 'ok' | 'stale' | 'none'; staleDropsLink?: boolean; pmdError?: number } = {}) {
  let bond = opts.bond ?? 'ok';
  const data = new Set<(k: NativeCharKey, b: Uint8Array) => void>();
  const drops = new Set<(r: string) => void>();
  const calls: string[] = [];
  const send = (k: NativeCharKey, bytes: number[]) => { for (const l of data) l(k, Uint8Array.from(bytes)); };
  const drop = () => { for (const l of drops) l('link caiu'); };
  const t: NativeBleTransport = {
    async open() { calls.push('open'); return { name: 'Polar H10 EBEC782E', address: 'a0b1c2d3e4f5' }; },
    async subscribe(key) {
      calls.push(`sub:${key}`);
      if (key.startsWith('pmd') && bond === 'stale') {
        if (opts.staleDropsLink) queueMicrotask(drop);
        throw new Error("Error invoking remote method 'ble:subscribe': Error: AccessDenied");
      }
    },
    async write(key, bytes) {
      calls.push(`write:${key}:${bytes[0]}`);
      if (key === 'pmdControl' && bytes[0] === 0x02) {
        queueMicrotask(() => send('pmdControl', [0xf0, 0x02, bytes[1]!, opts.pmdError ?? 0x00]));
      }
    },
    async read() { return Uint8Array.of(77); },
    async pair() {
      calls.push('pair');
      if (bond === 'stale') throw new Error("Error invoking remote method 'ble:pair': Error: pairing failed");
      bond = 'ok';
    },
    async repair() { calls.push('repair'); bond = 'ok'; return { name: 'Polar H10 EBEC782E', address: 'a0b1c2d3e4f5' }; },
    async close() { calls.push('close'); },
    onData(cb) { data.add(cb); return () => data.delete(cb); },
    onDisconnected(cb) { drops.add(cb); return () => drops.delete(cb); },
    onLog() { return () => undefined; },
  };
  return { t, calls, send, drop };
}

const flush = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((r) => setTimeout(r, 0)); };
const hrPacket = [0x16, 70, 0x00, 0x04]; // 70 bpm, contact, one R-R
const ecgFrame = [0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 1, 0, 0, 2, 0, 0];

function setup(opts: Parameters<typeof fakeShell>[0] = {}) {
  const shell = fakeShell(opts);
  const a = new NativeH10Adapter(shell.t, async () => {});
  const statuses: SensorStatus[] = [];
  const events: SensorEvent[] = [];
  a.onStatus((s) => statuses.push(s));
  a.onEvent((e) => events.push(e));
  return { ...shell, a, statuses, events };
}

describe('NativeH10Adapter', () => {
  it('streams HR first, then pairs and starts ECG on the first beat', async () => {
    const { a, calls, send, statuses, events } = setup({ bond: 'none' });
    await a.connect();
    expect(calls).toEqual(['open', 'sub:hr']);
    expect(statuses.at(-1)).toEqual({ state: 'streaming', deviceName: 'Polar H10 EBEC782E' });

    send('hr', hrPacket);
    await flush();
    expect(calls).toEqual(['open', 'sub:hr', 'pair', 'sub:pmdControl', 'sub:pmdData', 'write:pmdControl:2', 'write:pmdControl:2']);
    send('pmdData', ecgFrame);
    const ecg = events.find((e) => e.kind === 'ecg');
    expect(ecg?.kind === 'ecg' && [...ecg.samplesUv]).toEqual([1, 2]);
    expect(events.some((e) => e.kind === 'battery' && e.percent === 77)).toBe(true);
  });

  it('a stale pairing that refuses ECG is removed and redone once, without user action', async () => {
    const { a, calls, send, statuses } = setup({ bond: 'stale' });
    await a.connect();
    send('hr', hrPacket);
    await flush();
    expect(calls.filter((c) => c === 'repair')).toHaveLength(1);
    expect(statuses.some((s) => s.state === 'error' || s.state === 'idle')).toBe(false);
    expect(statuses.at(-1)).toEqual({ state: 'streaming', deviceName: 'Polar H10 EBEC782E' });

    send('hr', hrPacket); // first beat on the new pairing: ECG starts right away
    await flush();
    expect(calls.slice(-4)).toEqual(['sub:pmdControl', 'sub:pmdData', 'write:pmdControl:2', 'write:pmdControl:2']);
  });

  it('a stale pairing that kills the link when ECG starts is also repaired', async () => {
    const { a, calls, send, statuses } = setup({ bond: 'stale', staleDropsLink: true });
    await a.connect();
    send('hr', hrPacket);
    await flush();
    expect(calls.filter((c) => c === 'repair')).toHaveLength(1);
    expect(statuses.at(-1)).toEqual({ state: 'streaming', deviceName: 'Polar H10 EBEC782E' });
  });

  it('a link that dies right after connecting, twice and before any data, triggers a repair', async () => {
    const { a, calls, drop } = setup();
    await a.connect();
    drop();
    await flush();
    expect(calls.filter((c) => c === 'repair')).toHaveLength(0);
    drop();
    await flush();
    expect(calls.filter((c) => c === 'repair')).toHaveLength(1);
  });

  it('an ordinary drop after data reconnects without touching the pairing', async () => {
    const { a, calls, send, drop, statuses } = setup();
    await a.connect();
    send('hr', hrPacket);
    await flush();
    const later = performance.now() + 60_000; // well after the ECG request, so ECG is not blamed
    const clock = vi.spyOn(performance, 'now').mockReturnValue(later);
    drop();
    await flush();
    clock.mockRestore();
    expect(calls.filter((c) => c === 'open')).toHaveLength(2);
    expect(calls).not.toContain('repair');
    expect(statuses.at(-1)).toEqual({ state: 'streaming', deviceName: 'Polar H10 EBEC782E' });
  });

  it('the strap refusing ECG (no skin contact) is not a pairing problem', async () => {
    const { a, calls, send, statuses } = setup({ pmdError: 0x0c });
    await a.connect();
    send('hr', hrPacket);
    await flush();
    expect(calls).not.toContain('repair');
    expect(statuses.at(-1)).toMatchObject({ state: 'streaming', deviceName: expect.stringContaining('sem ECG') });
  });

  it('the user can redo the pairing from the error state', async () => {
    const { a, calls, statuses } = setup();
    await a.repairPairing();
    expect(calls).toEqual(['repair', 'sub:hr']);
    expect(statuses.at(-1)).toEqual({ state: 'streaming', deviceName: 'Polar H10 EBEC782E' });
  });

  it('a user disconnect closes the link and goes idle without reconnecting', async () => {
    const { a, calls, statuses, drop } = setup();
    await a.connect();
    a.disconnect();
    drop();
    await flush();
    expect(statuses.at(-1)).toEqual({ state: 'idle' });
    expect(calls).toContain('close');
    expect(calls.filter((c) => c === 'open')).toHaveLength(1);
  });
});
