/**
 * Judges the PC Bluetooth report the desktop shell collects on Windows
 * (electron/windows-bt.cts → REPORT). Pure: raw JSON in, facts and findings out.
 */

export interface RadioInfo {
  readonly name: string;
  readonly instanceId: string;
  readonly status: string;
  readonly problem: string;
  readonly manufacturer: string | null;
  readonly provider: string | null;
  readonly driverVersion: string | null;
  readonly driverDate: string | null; // yyyy-mm-dd
  readonly powerSaving: boolean | null;
  readonly lmp: string | number | null;
}

export interface BluetoothReport {
  readonly generatedAt: string;
  readonly os: { readonly caption: string; readonly build: string } | null;
  readonly machine: { readonly manufacturer: string; readonly model: string } | null;
  readonly radios: readonly RadioInfo[];
  readonly service: { readonly status: string; readonly startType: string } | null;
  readonly adapter: {
    readonly le: boolean | null;
    readonly extendedAdvertising: boolean | null;
    readonly secureConnections: boolean | null;
    readonly radioState: string | null;
  } | null;
  readonly straps: readonly { readonly name: string; readonly connected: boolean }[];
  readonly events: readonly { readonly provider: string; readonly id: number; readonly level: number; readonly count: number; readonly last: string; readonly message: string }[];
  readonly eventDays: number;
  readonly wifi: readonly string[];
  readonly usbSelectiveSuspend: { readonly ac: number; readonly dc: number } | null;
}

export type FindingLevel = 'ok' | 'info' | 'warn' | 'bad';

export interface Finding {
  readonly level: FindingLevel;
  readonly title: string;
  readonly detail: string;
}

export interface Assessment {
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly findings: readonly Finding[];
}

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]); // PowerShell 5.1 unwraps 1-element arrays
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Throws RangeError when the text is not a report at all. */
export function parseBluetoothReport(text: string): BluetoothReport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RangeError('Relatório de Bluetooth ilegível');
  }
  const r = obj(raw);
  if (!r) throw new RangeError('Relatório de Bluetooth vazio');
  const os = obj(r.os);
  const machine = obj(r.machine);
  const service = obj(r.service);
  const adapter = obj(r.adapter);
  const usb = obj(r.usbSelectiveSuspend);
  return {
    generatedAt: str(r.generatedAt) ?? '',
    os: os ? { caption: str(os.caption) ?? 'Windows', build: str(os.build) ?? '' } : null,
    machine: machine ? { manufacturer: str(machine.manufacturer) ?? '', model: str(machine.model) ?? '' } : null,
    radios: arr(r.radios).flatMap((x) => {
      const d = obj(x);
      if (!d) return [];
      return [{
        name: str(d.name) ?? 'Adaptador Bluetooth',
        instanceId: str(d.instanceId) ?? '',
        status: str(d.status) ?? 'Unknown',
        problem: str(d.problem) ?? '',
        manufacturer: str(d.manufacturer),
        provider: str(d.provider),
        driverVersion: str(d.driverVersion),
        driverDate: str(d.driverDate),
        powerSaving: bool(d.powerSaving),
        lmp: str(d.lmp),
      }];
    }),
    service: service ? { status: str(service.status) ?? '', startType: str(service.startType) ?? '' } : null,
    adapter: adapter
      ? { le: bool(adapter.le), extendedAdvertising: bool(adapter.extendedAdvertising), secureConnections: bool(adapter.secureConnections), radioState: str(adapter.radioState) }
      : null,
    straps: arr(r.straps).flatMap((x) => {
      const d = obj(x);
      return d ? [{ name: str(d.name) ?? 'Polar', connected: d.connected === true }] : [];
    }),
    events: arr(r.events).flatMap((x) => {
      const d = obj(x);
      if (!d) return [];
      return [{ provider: str(d.provider) ?? '', id: num(d.id) ?? 0, level: num(d.level) ?? 3, count: num(d.count) ?? 1, last: str(d.last) ?? '', message: str(d.message) ?? '' }];
    }),
    eventDays: num(r.eventDays) ?? 14,
    wifi: arr(r.wifi).flatMap((x) => (typeof x === 'string' ? [x] : [])),
    usbSelectiveSuspend: usb && num(usb.ac) !== null && num(usb.dc) !== null ? { ac: num(usb.ac)!, dc: num(usb.dc)! } : null,
  };
}

/** Value of a "Key : value" line from `netsh wlan show interfaces` (Portuguese or English). */
function wifiField(lines: readonly string[], keys: RegExp): string | null {
  for (const l of lines) {
    const m = /^([^:]+?)\s*:\s*(.+)$/.exec(l);
    if (m && keys.test(m[1]!)) return m[2]!.trim();
  }
  return null;
}

const OK_PROBLEMS = new Set(['', '0', 'CM_PROB_NONE']);
const DRIVER_OLD_YEARS = 3;

export function assessBluetooth(r: BluetoothReport, today: Date): Assessment {
  const facts: { label: string; value: string }[] = [];
  const findings: Finding[] = [];
  const radio = r.radios[0] ?? null;

  if (r.machine && (r.machine.manufacturer || r.machine.model)) facts.push({ label: 'Computador', value: `${r.machine.manufacturer} ${r.machine.model}`.trim() });
  if (r.os) facts.push({ label: 'Sistema', value: `${r.os.caption}${r.os.build ? ` (build ${r.os.build})` : ''}` });

  if (!radio) {
    findings.push({
      level: 'bad',
      title: 'Nenhum adaptador Bluetooth encontrado',
      detail: 'O Windows não listou um rádio Bluetooth ativo. Verifique se ele não está desativado no Gerenciador de Dispositivos ou na BIOS.',
    });
  } else {
    facts.push({ label: 'Adaptador', value: radio.name });
    if (radio.manufacturer) facts.push({ label: 'Fabricante', value: radio.manufacturer });
    const driver = [radio.driverVersion, radio.driverDate && `de ${formatDate(radio.driverDate)}`, radio.provider && `por ${radio.provider}`].filter(Boolean).join(' · ');
    if (driver) facts.push({ label: 'Driver', value: driver });
    if (radio.lmp !== null) facts.push({ label: 'Versão LMP', value: String(radio.lmp) });
    if (r.radios.length > 1) facts.push({ label: 'Outros rádios', value: r.radios.slice(1).map((x) => x.name).join(', ') });

    if (radio.status !== 'OK' || !OK_PROBLEMS.has(radio.problem)) {
      findings.push({
        level: 'bad',
        title: 'O Windows marca o adaptador com problema',
        detail: `Estado "${radio.status}"${OK_PROBLEMS.has(radio.problem) ? '' : `, código ${radio.problem}`}. Reinstale o driver do fabricante do notebook/placa e reinicie.`,
      });
    }
    if (radio.powerSaving === true) {
      findings.push({
        level: 'warn',
        title: 'O Windows pode desligar o Bluetooth para economizar energia',
        detail: 'É uma causa comum de quedas. Gerenciador de Dispositivos → Bluetooth → ' + radio.name + ' → Propriedades → Gerenciamento de Energia → desmarque "O computador pode desligar o dispositivo para economizar energia".',
      });
    }
    if (radio.driverDate) {
      const ageYears = (today.getTime() - Date.parse(radio.driverDate)) / (365.25 * 86_400_000);
      if (ageYears > DRIVER_OLD_YEARS) {
        findings.push({
          level: 'warn',
          title: `Driver de Bluetooth antigo (${formatDate(radio.driverDate)})`,
          detail: `Tem ${Math.floor(ageYears)} anos. Procure a versão mais nova no site do fabricante do computador ou do chip${radio.manufacturer ? ` (${radio.manufacturer})` : ''}. O Windows Update nem sempre traz a última.`,
        });
      }
    }
    if (radio.provider && /^microsoft$/i.test(radio.provider)) {
      findings.push({
        level: 'info',
        title: 'Driver genérico da Microsoft',
        detail: 'Funciona, mas o driver do fabricante do chip costuma ser mais estável com dispositivos de baixa energia como a H10.',
      });
    }
    if (r.usbSelectiveSuspend?.ac === 1 && /^USB\\/i.test(radio.instanceId)) {
      findings.push({
        level: 'info',
        title: 'Suspensão seletiva de USB ligada',
        detail: 'O adaptador é USB e o plano de energia pode suspender portas ociosas. Se as quedas continuarem: Opções de Energia → Alterar configurações avançadas → Configurações de USB → desabilitar a suspensão seletiva.',
      });
    }
  }

  if (r.adapter) {
    const caps = [
      r.adapter.le === true ? 'Bluetooth de baixa energia' : r.adapter.le === false ? 'sem Bluetooth de baixa energia' : null,
      r.adapter.extendedAdvertising === true ? 'recursos do Bluetooth 5' : r.adapter.extendedAdvertising === false ? 'nível Bluetooth 4.x' : null,
      r.adapter.secureConnections === true ? 'conexões seguras LE' : null,
    ].filter(Boolean).join(' · ');
    if (caps) facts.push({ label: 'Recursos', value: caps });
    if (r.adapter.radioState && r.adapter.radioState !== 'On') {
      findings.push({ level: 'bad', title: 'O rádio Bluetooth está desligado', detail: 'Ligue o Bluetooth nas Configurações rápidas do Windows.' });
    }
    if (r.adapter.le === false) {
      findings.push({ level: 'bad', title: 'O adaptador não tem Bluetooth de baixa energia', detail: 'A H10 só fala Bluetooth de baixa energia (4.0+). Um adaptador USB Bluetooth 5 resolve.' });
    } else if (r.adapter.extendedAdvertising === false && r.adapter.secureConnections !== true) {
      findings.push({
        level: 'info',
        title: 'Rádio Bluetooth de geração antiga (4.x)',
        detail: 'Suficiente para a H10, mas mais sensível a interferência e à distância. Se as quedas persistirem depois dos outros ajustes, um adaptador USB Bluetooth 5 barato costuma resolver de vez.',
      });
    }
  }

  if (r.service) {
    facts.push({ label: 'Serviço Bluetooth', value: r.service.status === 'Running' ? 'em execução' : r.service.status });
    if (r.service.status !== 'Running') {
      findings.push({ level: 'bad', title: 'O serviço de suporte Bluetooth não está rodando', detail: 'Abra services.msc, encontre "Serviço de Suporte Bluetooth", inicie-o e deixe como Automático.' });
    }
  }

  const channelText = wifiField(r.wifi, /^(canal|channel)$/i);
  const channel = channelText ? Number.parseInt(channelText, 10) : NaN;
  const wifiState = wifiField(r.wifi, /^(estado|state)$/i);
  const wifiCard = wifiField(r.wifi, /^(descri[cç][aã]o|description)$/i);
  if (Number.isFinite(channel)) {
    facts.push({ label: 'Wi-Fi', value: `${wifiCard ? `${wifiCard} · ` : ''}canal ${channel} (${channel <= 14 ? '2,4 GHz' : '5 GHz'})` });
    if (channel <= 14 && (!wifiState || /conectado|connected/i.test(wifiState))) {
      findings.push({
        level: 'warn',
        title: 'Wi-Fi em 2,4 GHz divide o ar com o Bluetooth',
        detail: `Canal ${channel}. Bluetooth e Wi-Fi 2,4 GHz usam a mesma faixa${wifiCard && radio?.manufacturer && sameVendor(wifiCard, radio.manufacturer) ? ' e, aqui, o mesmo chip' : ''}; com tráfego de rede, o Bluetooth perde pacotes. Conecte-se à rede de 5 GHz do roteador (geralmente com "5G" no nome) durante o treino.`,
      });
    }
  }

  for (const s of r.straps) facts.push({ label: 'Cinta pareada', value: `${s.name} · ${s.connected ? 'conectada ao Windows agora' : 'não conectada'}` });

  const errors = r.events.filter((e) => e.level <= 2);
  const total = r.events.reduce((n, e) => n + e.count, 0);
  facts.push({ label: `Alertas do Windows (${r.eventDays} dias)`, value: total ? `${total} registro${total === 1 ? '' : 's'} de Bluetooth` : 'nenhum de Bluetooth' });
  if (errors.length) {
    const top = errors.slice(0, 3).map((e) => `${e.count}× ${e.provider} ${e.id}: ${e.message.replace(/\.$/, '')}`).join(' · ');
    findings.push({
      level: errors.reduce((n, e) => n + e.count, 0) >= 5 ? 'bad' : 'warn',
      title: 'O Windows registrou erros de Bluetooth',
      detail: `${top}. Erros repetidos de ${errors[0]!.provider} costumam indicar driver ou adaptador instável; atualizar o driver é o primeiro passo.`,
    });
  } else if (total) {
    findings.push({ level: 'info', title: 'Avisos de Bluetooth no registro do Windows', detail: r.events.slice(0, 3).map((e) => `${e.count}× ${e.provider} ${e.id}: ${e.message}`).join(' · ') });
  }

  if (!findings.some((f) => f.level === 'bad' || f.level === 'warn')) {
    findings.unshift({ level: 'ok', title: 'Nada de errado no Bluetooth deste PC', detail: 'Adaptador, driver, energia e registros estão em ordem.' });
  }
  const order: Record<FindingLevel, number> = { bad: 0, warn: 1, info: 2, ok: 3 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return { facts, findings };
}

function sameVendor(a: string, b: string): boolean {
  const vendor = /(intel|realtek|mediatek|qualcomm|broadcom|atheros)/i;
  const va = vendor.exec(a)?.[1]?.toLowerCase();
  const vb = vendor.exec(b)?.[1]?.toLowerCase();
  return va !== undefined && va === vb;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}
