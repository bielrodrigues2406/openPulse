import { describe, expect, it } from 'vitest';
import { assessBluetooth, parseBluetoothReport } from '../src/app/pc-bluetooth';

const today = new Date('2026-10-17T12:00:00');

/** Shaped like Windows PowerShell 5.1 output: single-element arrays come out unwrapped. */
const troubled = JSON.stringify({
  generatedAt: '2026-10-17T11:20:00',
  os: { caption: 'Microsoft Windows 11 Home', version: '10.0.26100', build: '26100' },
  machine: { manufacturer: 'Acer', model: 'Aspire 5' },
  radios: {
    name: 'Intel(R) Wireless Bluetooth(R)', instanceId: 'USB\\VID_8087&PID_0AAA\\5&1', status: 'OK', problem: 'CM_PROB_NONE',
    manufacturer: 'Intel Corporation', provider: 'Intel', driverVersion: '20.100.5.1', driverDate: '2019-03-01', powerSaving: true, lmp: null,
  },
  service: { status: 'Running', startType: 'Manual' },
  adapter: { le: true, central: true, extendedAdvertising: false, maxAdvertisementBytes: 31, secureConnections: false, radioState: 'On' },
  straps: { name: 'Polar H10 EBEC782E', connected: true },
  events: [{ provider: 'BTHUSB', id: 17, level: 2, count: 9, last: '2026-10-17 10:31', message: 'O rádio Bluetooth foi redefinido.' }],
  eventDays: 14,
  wifi: ['SSID                   : Casa', 'Descrição              : Intel(R) Wireless-AC 9560', 'Estado                 : conectado', 'Canal                  : 6'],
  usbSelectiveSuspend: { ac: 1, dc: 1 },
});

describe('PC Bluetooth report', () => {
  it('reads PowerShell 5.1 output with unwrapped single-element arrays', () => {
    const r = parseBluetoothReport(troubled);
    expect(r.radios).toHaveLength(1);
    expect(r.straps).toEqual([{ name: 'Polar H10 EBEC782E', connected: true }]);
    expect(r.usbSelectiveSuspend).toEqual({ ac: 1, dc: 1 });
  });

  it('flags power saving, an old driver, 2.4 GHz Wi-Fi on the same chip and logged radio resets', () => {
    const { findings, facts } = assessBluetooth(parseBluetoothReport(troubled), today);
    const titles = findings.map((f) => f.title);
    expect(findings[0]!.level).toBe('bad');
    expect(titles[0]).toBe('O Windows registrou erros de Bluetooth');
    expect(titles).toContain('O Windows pode desligar o Bluetooth para economizar energia');
    expect(titles).toContain('Driver de Bluetooth antigo (01/03/2019)');
    expect(titles).toContain('Wi-Fi em 2,4 GHz divide o ar com o Bluetooth');
    expect(findings.find((f) => f.title.startsWith('Wi-Fi'))!.detail).toContain('o mesmo chip');
    expect(titles).toContain('Rádio Bluetooth de geração antiga (4.x)');
    expect(titles).toContain('Suspensão seletiva de USB ligada');
    expect(facts.find((f) => f.label === 'Driver')!.value).toBe('20.100.5.1 · de 01/03/2019 · por Intel');
    expect(facts.find((f) => f.label === 'Wi-Fi')!.value).toBe('Intel(R) Wireless-AC 9560 · canal 6 (2,4 GHz)');
    expect(facts.find((f) => f.label === 'Cinta pareada')!.value).toContain('conectada ao Windows agora');
  });

  it('a healthy PC gets a single all-clear', () => {
    const r = parseBluetoothReport(JSON.stringify({
      radios: [{ name: 'Realtek Bluetooth 5.3 Adapter', instanceId: 'USB\\VID_0BDA', status: 'OK', problem: 'CM_PROB_NONE', provider: 'Realtek', driverDate: '2025-06-01', powerSaving: false }],
      service: { status: 'Running' },
      adapter: { le: true, extendedAdvertising: true, secureConnections: true, radioState: 'On' },
      wifi: ['Channel : 44', 'State : connected'],
      events: [],
    }));
    const { findings } = assessBluetooth(r, today);
    expect(findings).toEqual([{ level: 'ok', title: 'Nada de errado no Bluetooth deste PC', detail: expect.any(String) }]);
  });

  it('no radio, a radio with a problem code, or the service stopped are blocking', () => {
    expect(assessBluetooth(parseBluetoothReport('{"radios":[]}'), today).findings[0]!.title).toBe('Nenhum adaptador Bluetooth encontrado');
    const broken = assessBluetooth(parseBluetoothReport(JSON.stringify({
      radios: [{ name: 'X', status: 'Error', problem: 'CM_PROB_FAILED_START' }], service: { status: 'Stopped' },
    })), today);
    expect(broken.findings.filter((f) => f.level === 'bad').map((f) => f.title)).toEqual([
      'O Windows marca o adaptador com problema',
      'O serviço de suporte Bluetooth não está rodando',
    ]);
  });

  it('rejects text that is not a report', () => {
    expect(() => parseBluetoothReport('PowerShell não encontrado')).toThrow(RangeError);
    expect(() => parseBluetoothReport('[]')).toThrow(RangeError);
  });
});
