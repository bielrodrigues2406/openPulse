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
export const LIST = [
  ...PRELUDE,
  'foreach ($d in $paired) {',
  "  if ($d.Name -notlike 'Polar H10*') { continue }",
  '  $dev = Await ($LE::FromIdAsync($d.Id)) ($LE)',
  "  if ($dev) { '{0:x12}{1}{2}' -f $dev.BluetoothAddress, \"`t\", $d.Name; $dev.Dispose() }",
  '}',
];

/** Removes every paired Polar H10 and prints one status line per strap. */
export const UNPAIR = [
  ...PRELUDE,
  'foreach ($d in $paired) {',
  "  if ($d.Name -notlike 'Polar H10*') { continue }",
  '  $r = Await ($d.Pairing.UnpairAsync()) ([Windows.Devices.Enumeration.DeviceUnpairingResult])',
  '  "$($d.Name): $($r.Status)"',
  '}',
];

/**
 * Everything worth knowing about this PC's Bluetooth, as one JSON object (see
 * src/app/pc-bluetooth.ts for the shape and how it is judged). Each part is guarded: a missing
 * cmdlet or class leaves its field empty instead of failing the report.
 */
export const REPORT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$r = [ordered]@{ generatedAt = (Get-Date).ToString("s"); radios = @(); events = @(); eventDays = 14; wifi = @(); straps = @() }',
  'try { $os = Get-CimInstance Win32_OperatingSystem; $r.os = [ordered]@{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber } } catch {}',
  'try { $cs = Get-CimInstance Win32_ComputerSystem; $r.machine = [ordered]@{ manufacturer = $cs.Manufacturer; model = $cs.Model } } catch {}',
  // The radio itself: Bluetooth-class devices on a bus (USB/PCI/…); BTHENUM/BTHLE children are paired devices.
  'try {',
  '  $pm = @(Get-CimInstance -Namespace root\\wmi -ClassName MSPower_DeviceEnable)',
  '  $drivers = @(Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceClass -eq "BLUETOOTH" })',
  '  $radios = @(Get-PnpDevice -Class Bluetooth -PresentOnly | Where-Object { $_.InstanceId -notmatch "^(BTHENUM|BTHLE|BTHLEDEVICE|SWD|ROOT|BTH)\\\\" })',
  '  foreach ($d in $radios) {',
  '    $drv = $drivers | Where-Object { $_.DeviceID -eq $d.InstanceId } | Select-Object -First 1',
  '    $p = $pm | Where-Object { $_.InstanceName -like ($d.InstanceId + "*") } | Select-Object -First 1',
  '    $parent = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName DEVPKEY_Device_Parent).Data',
  '    $pp = if ($parent) { $pm | Where-Object { $_.InstanceName -like ($parent + "*") } | Select-Object -First 1 } else { $null }',
  '    $lmp = (Get-PnpDeviceProperty -InstanceId $d.InstanceId | Where-Object { $_.KeyName -match "Lmp" } | Select-Object -First 1).Data',
  '    $r.radios += [ordered]@{',
  '      name = $d.FriendlyName; instanceId = $d.InstanceId; status = [string]$d.Status; problem = [string]$d.Problem;',
  '      manufacturer = $drv.Manufacturer; provider = $drv.DriverProviderName; driverVersion = $drv.DriverVersion;',
  '      driverDate = $(if ($drv.DriverDate) { $drv.DriverDate.ToString("yyyy-MM-dd") } else { $null });',
  '      powerSaving = $(if ($p) { [bool]$p.Enable } elseif ($pp) { [bool]$pp.Enable } else { $null });',
  '      lmp = $lmp',
  '    }',
  '  }',
  '} catch { $r.radiosError = $_.Exception.Message }',
  'try { $svc = Get-Service bthserv; $r.service = [ordered]@{ status = [string]$svc.Status; startType = [string]$svc.StartType } } catch {}',
  // WinRT view of the default adapter: what the radio can do.
  'try {',
  '  Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  "  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  '  function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); if (-not $t.Wait(15000)) { throw "timeout" }; $t.Result }',
  '  $null = [Windows.Devices.Bluetooth.BluetoothAdapter, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]',
  '  $null = [Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]',
  '  $null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType=WindowsRuntime]',
  '  $ad = Await ([Windows.Devices.Bluetooth.BluetoothAdapter]::GetDefaultAsync()) ([Windows.Devices.Bluetooth.BluetoothAdapter])',
  '  if ($ad) {',
  '    $r.adapter = [ordered]@{ le = $ad.IsLowEnergySupported; central = $ad.IsCentralRoleSupported; extendedAdvertising = $ad.IsExtendedAdvertisingSupported; maxAdvertisementBytes = $ad.MaxAdvertisementDataLength; secureConnections = $ad.AreLowEnergySecureConnectionsSupported }',
  '    try { $null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType=WindowsRuntime]; $radio = Await ($ad.GetRadioAsync()) ([Windows.Devices.Radios.Radio]); if ($radio) { $r.adapter.radioState = [string]$radio.State } } catch {}',
  '  }',
  '  $LE = [Windows.Devices.Bluetooth.BluetoothLEDevice]',
  '  $paired = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($LE::GetDeviceSelectorFromPairingState($true))) ([Windows.Devices.Enumeration.DeviceInformationCollection])',
  '  foreach ($d in $paired) {',
  "    if ($d.Name -notlike 'Polar*') { continue }",
  '    $dev = Await ($LE::FromIdAsync($d.Id)) ($LE)',
  '    if ($dev) { $r.straps += [ordered]@{ name = $d.Name; connected = ([string]$dev.ConnectionStatus -eq "Connected") }; $dev.Dispose() }',
  '  }',
  '} catch { $r.adapterError = $_.Exception.Message }',
  // Bluetooth errors and warnings Windows logged recently, grouped.
  'try {',
  '  $ev = @(Get-WinEvent -FilterHashtable @{ LogName = "System"; Level = 1,2,3; StartTime = (Get-Date).AddDays(-14) } -MaxEvents 5000 | Where-Object { $_.ProviderName -match "BTH|Bluetooth" })',
  '  $r.events = @($ev | Group-Object { "$($_.ProviderName)#$($_.Id)" } | Sort-Object Count -Descending | Select-Object -First 10 | ForEach-Object {',
  '    $e = $_.Group[0]',
  '    [ordered]@{ provider = $e.ProviderName; id = $e.Id; level = [int]$e.Level; count = $_.Count; last = $e.TimeCreated.ToString("yyyy-MM-dd HH:mm"); message = (($e.Message -split "`r?`n")[0]) }',
  '  })',
  '} catch {}',
  'try { $r.wifi = @(netsh wlan show interfaces | ForEach-Object { $_.Trim() } | Where-Object { $_ -match "^(Descri|Description|Tipo de r|Radio type|Banda|Band|Canal|Channel|SSID|Estado|State)" }) } catch {}',
  // Power plan: USB selective suspend (AC/DC indexes, 1 = enabled).
  'try { $q = powercfg /q SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226; $idx = @($q | Select-String "0x0000000[0-9]" | ForEach-Object { [int]($_.Line -replace ".*0x0*", "") }); if ($idx.Count -ge 2) { $r.usbSelectiveSuspend = [ordered]@{ ac = $idx[-2]; dc = $idx[-1] } } } catch {}',
  '$r | ConvertTo-Json -Depth 6 -Compress',
];

function run(lines: readonly string[]): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Disponível só no Windows'));
  const encoded = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: 90_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
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

/** Raw JSON produced by REPORT; parsed and judged in the renderer. */
export async function bluetoothReport(): Promise<string> {
  const lines = await run(REPORT);
  return lines.join('');
}
