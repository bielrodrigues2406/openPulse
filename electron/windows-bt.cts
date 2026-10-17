import { execFile } from 'node:child_process';

/**
 * Windows pairing records through WinRT, driven from Windows PowerShell 5.1 (no native build).
 * Used to find a strap that is already connected to Windows (it stops advertising, so a scan
 * never sees it) and to drop a stale pairing before pairing again.
 */

const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  "$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  "function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); if (-not $t.Wait(20000)) { throw 'o Windows não respondeu' }; $t.Result }",
  '$null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType=WindowsRuntime]',
  '$null = [Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]',
  '$LE = [Windows.Devices.Bluetooth.BluetoothLEDevice]',
  '$paired = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($LE::GetDeviceSelectorFromPairingState($true))) ([Windows.Devices.Enumeration.DeviceInformationCollection])',
];

/** Prints "address<TAB>name" for every paired Polar H10. */
const LIST = [
  ...PRELUDE,
  'foreach ($d in $paired) {',
  "  if ($d.Name -notlike 'Polar H10*') { continue }",
  '  $dev = Await ($LE::FromIdAsync($d.Id)) ($LE)',
  "  if ($dev) { '{0:x12}{1}{2}' -f $dev.BluetoothAddress, \"`t\", $d.Name; $dev.Dispose() }",
  '}',
];

/** Removes every paired Polar H10 and prints one status line per strap. */
const UNPAIR = [
  ...PRELUDE,
  'foreach ($d in $paired) {',
  "  if ($d.Name -notlike 'Polar H10*') { continue }",
  '  $r = Await ($d.Pairing.UnpairAsync()) ([Windows.Devices.Enumeration.DeviceUnpairingResult])',
  '  "$($d.Name): $($r.Status)"',
  '}',
];

function run(lines: readonly string[]): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Disponível só no Windows'));
  const encoded = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 45_000, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (err) reject(new Error(String(stderr).trim().split(/\r?\n/)[0] || err.message));
        else resolve(out);
      },
    );
  });
}

export interface PairedStrap {
  readonly address: string; // 12 hex digits, no separators
  readonly name: string;
}

export async function listPairedH10(): Promise<PairedStrap[]> {
  const lines = await run(LIST);
  return lines.flatMap((l) => {
    const [address, name] = l.split('\t');
    return address && /^[0-9a-f]{12}$/.test(address) ? [{ address, name: name ?? 'Polar H10' }] : [];
  });
}

export function unpairH10(): Promise<string[]> {
  return run(UNPAIR);
}
