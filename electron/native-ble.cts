import type { Characteristic, Noble, Peripheral } from '@stoprocent/noble';
import { listPairedH10, unpairH10 } from './windows-bt.cjs';

/**
 * Bluetooth through Windows' own stack (WinRT, via @stoprocent/noble) instead of Chromium's
 * Web Bluetooth. What it fixes on Windows:
 * - a strap Windows already holds a link to stops advertising, so the browser chooser never
 *   finds it; here it is opened by address, straight from Windows' pairing list;
 * - pairing is done by the app (Just Works, accepted in code), not by a system toast;
 * - a stale pairing (Windows kept keys the strap dropped) can be removed and redone in place.
 *
 * This is a thin transport: connection policy (HR first, ECG after the first beat, when to
 * repair) lives in the renderer's NativeH10Adapter, where it is unit-tested.
 */

export type CharKey = 'hr' | 'battery' | 'pmdControl' | 'pmdData';

const PMD = (n: string) => `fb005c${n}02e7f3871cad8acd2d8df0c8`;
const CHARS: Record<CharKey, string> = { hr: '2a37', battery: '2a19', pmdControl: PMD('81'), pmdData: PMD('82') };
/**
 * GATT is discovered per service, on demand: HR first (all the app needs to start), battery and
 * ECG only when used. A small discovery finishes fast; a full one on a busy link was seen to
 * stall for 15 s in a field log.
 */
const GROUPS: Record<'hr' | 'battery' | 'pmd', { service: string; chars: CharKey[] }> = {
  hr: { service: '180d', chars: ['hr'] },
  battery: { service: '180f', chars: ['battery'] },
  pmd: { service: PMD('80'), chars: ['pmdControl', 'pmdData'] },
};
const SCAN_MS = 12_000;
const CONNECT_MS = 12_000;
const DISCOVER_MS = 8000;
/** Fresh connections tried per address when GATT discovery stalls. */
const OPEN_TRIES = 2;
const PAIR_MS = 30_000;
/** WinRT DevicePairingKinds.ConfirmOnly / DevicePairingProtectionLevel.Encryption. */
const CONFIRM_ONLY = 0x08;
const ENCRYPTION = 2;

export interface StrapInfo {
  readonly name: string;
  readonly address: string;
}

export interface NativeBleHost {
  emit(channel: 'ble:data', key: CharKey, bytes: Uint8Array): void;
  emit(channel: 'ble:disconnected', reason: string): void;
  emit(channel: 'ble:log', line: string): void;
  remembered(): StrapInfo | null;
  remember(info: StrapInfo): void;
}

export class NativeBle {
  private peripheral: Peripheral | null = null;
  private readonly chars = new Map<CharKey, Characteristic>();
  private readonly wired = new WeakSet<object>();
  private info: StrapInfo | null = null;
  private closing = false;
  /** Bumped by close(); an open() from an older generation stops at its next step. */
  private gen = 0;

  private constructor(
    private readonly noble: Noble,
    private readonly host: NativeBleHost,
  ) {}

  /** Null when the native binding cannot load (not Windows, or a broken install). */
  static load(host: NativeBleHost): NativeBle | null {
    if (process.platform !== 'win32') return null;
    try {
      // resolve-bindings, not the package root: the root also builds a default instance.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const withBindings = require('@stoprocent/noble/lib/resolve-bindings') as (type: 'win') => Noble;
      return new NativeBle(withBindings('win'), host);
    } catch (err) {
      console.error('openPulse: native Bluetooth unavailable', err);
      return null;
    }
  }

  private log(line: string): void {
    this.host.emit('ble:log', `[nativo] ${line}`);
  }

  /**
   * Remembered strap first, then Windows' pairing list (works while Windows holds the link).
   * A scan only when neither knows a strap: one connected to Windows does not advertise, so
   * scanning for it just costs time.
   */
  async open(): Promise<StrapInfo> {
    const gen = ++this.gen;
    this.closing = false;
    this.progress('ligando o Bluetooth do Windows');
    await within(this.noble.waitForPoweredOnAsync(8000), 9000, 'Bluetooth do Windows desligado ou indisponível');
    const tried = new Set<string>();
    let last: unknown = null;
    const attempt = async (c: StrapInfo): Promise<StrapInfo | null> => {
      this.checkCancelled(gen);
      const id = normalize(c.address);
      if (tried.has(id)) return null;
      tried.add(id);
      try {
        return await this.openAddress(c, gen);
      } catch (err) {
        if (err instanceof Cancelled) throw err;
        last = err;
        this.log(`${c.name} (${id}) não abriu: ${text(err)}`);
        return null;
      }
    };
    const known = this.host.remembered();
    if (known) {
      const ok = await attempt(known);
      if (ok) return ok;
    }
    this.progress('consultando a cinta pareada no Windows');
    const paired = await listPairedH10().catch((err: unknown) => {
      this.log(`lista de pareados falhou: ${text(err)}`);
      return [];
    });
    for (const c of paired) {
      const ok = await attempt(c);
      if (ok) return ok;
    }
    if (!known && !paired.length) {
      for (const c of await this.scan(gen)) {
        const ok = await attempt(c);
        if (ok) return ok;
      }
    }
    this.checkCancelled(gen);
    if (last) throw last instanceof Error ? last : new Error(text(last));
    throw new Error('Nenhuma Polar H10 encontrada. Vista a cinta (eletrodos úmidos) e tente de novo.');
  }

  private progress(line: string): void {
    this.host.emit('ble:log', `[etapa] ${line}`);
  }

  private checkCancelled(gen: number): void {
    if (gen !== this.gen) throw new Cancelled('Conexão cancelada');
  }

  private async scan(gen: number): Promise<StrapInfo[]> {
    this.progress('procurando a cinta por perto');
    const found = new Map<string, StrapInfo>();
    const onDiscover = (p: Peripheral) => {
      const name = p.advertisement.localName ?? '';
      if (name.startsWith('Polar H10')) found.set(p.id, { name, address: p.id });
    };
    this.noble.on('discover', onDiscover);
    try {
      await this.noble.startScanningAsync([], false);
      const until = Date.now() + SCAN_MS;
      while (!found.size && Date.now() < until && gen === this.gen) await sleep(250);
    } finally {
      this.noble.removeListener('discover', onDiscover);
      await this.noble.stopScanningAsync().catch(() => undefined);
    }
    return [...found.values()];
  }

  /** Connects and discovers HR. A stalled discovery gets a fresh connection, not a longer wait. */
  private async openAddress(c: StrapInfo, gen: number): Promise<StrapInfo> {
    const id = normalize(c.address);
    let last: unknown = null;
    for (let i = 1; i <= OPEN_TRIES; i++) {
      this.checkCancelled(gen);
      try {
        const p = await this.connectPeripheral(id, c.name, i);
        this.checkCancelled(gen);
        this.progress('lendo a frequência cardíaca da cinta');
        await this.discover(p, 'hr');
        this.checkCancelled(gen);
        const name = p.advertisement?.localName || c.name;
        this.info = { name, address: id };
        this.host.remember(this.info);
        this.log(`aberta: ${name}`);
        return this.info;
      } catch (err) {
        if (err instanceof Cancelled) throw err;
        last = err;
        this.log(`tentativa ${i}/${OPEN_TRIES}: ${text(err)}`);
        await this.drop();
        if (i < OPEN_TRIES) await sleep(1000);
      }
    }
    throw last instanceof Error ? last : new Error(text(last));
  }

  private async connectPeripheral(id: string, name: string, attempt: number): Promise<Peripheral> {
    this.progress(attempt === 1 ? `conectando a ${name}` : `conectando a ${name} (nova tentativa)`);
    let p: Peripheral;
    try {
      p = await within(this.noble.connectAsync(id), CONNECT_MS, 'A cinta não respondeu ao conectar', () => this.noble.cancelConnect(id));
    } catch (err) {
      // A link left over from a previous open counts as success.
      if (!/already connected/i.test(text(err)) || !this.peripheral) throw err;
      p = this.peripheral;
    }
    this.peripheral = p;
    this.chars.clear();
    if (!this.wired.has(p)) {
      this.wired.add(p);
      p.on('disconnect', (reason: unknown) => {
        this.chars.clear();
        if (!this.closing) this.host.emit('ble:disconnected', text(reason) || 'link caiu');
      });
    }
    return p;
  }

  private async discover(p: Peripheral, group: keyof typeof GROUPS): Promise<void> {
    const { service, chars } = GROUPS[group];
    const { characteristics } = await within(
      p.discoverSomeServicesAndCharacteristicsAsync([service], chars.map((k) => CHARS[k])),
      DISCOVER_MS,
      group === 'hr' ? 'A cinta conectou mas não respondeu à leitura de serviços' : `A cinta não listou o serviço ${group === 'pmd' ? 'de ECG' : 'de bateria'}`,
    );
    for (const key of chars) {
      const ch = characteristics.find((x) => x.uuid === CHARS[key]);
      if (!ch) continue;
      this.chars.set(key, ch);
      if (!this.wired.has(ch)) {
        this.wired.add(ch);
        ch.on('data', (data: Buffer) => this.host.emit('ble:data', key, new Uint8Array(data)));
      }
    }
    if (group === 'hr' && !this.chars.has('hr')) throw new Error('A cinta não expôs o serviço de frequência cardíaca');
  }

  /** Discovers the service a characteristic belongs to the first time it is used. */
  private async ensure(key: CharKey): Promise<Characteristic> {
    if (!this.chars.has(key) && this.peripheral) {
      await this.discover(this.peripheral, key === 'battery' ? 'battery' : key === 'hr' ? 'hr' : 'pmd');
    }
    return this.char(key);
  }

  private char(key: CharKey): Characteristic {
    const ch = this.chars.get(key);
    if (!ch) throw new Error(key.startsWith('pmd') ? 'A cinta não expôs o serviço de ECG' : `Característica ${key} ausente`);
    return ch;
  }

  async subscribe(key: CharKey): Promise<void> {
    await within((await this.ensure(key)).subscribeAsync(), 10_000, `assinatura ${key} sem resposta`);
  }

  async write(key: CharKey, bytes: Uint8Array): Promise<void> {
    await within((await this.ensure(key)).writeAsync(Buffer.from(bytes), false), 10_000, `escrita ${key} sem resposta`);
  }

  async read(key: CharKey): Promise<Uint8Array> {
    return new Uint8Array(await within((await this.ensure(key)).readAsync(), 10_000, `leitura ${key} sem resposta`));
  }

  /** Pairs in code (Just Works, accepted here). Resolves at once when already paired. */
  async pair(): Promise<void> {
    if (!this.peripheral) throw new Error('Cinta não conectada');
    this.log('pareando');
    await within(this.peripheral.pairAsync(CONFIRM_ONLY, ENCRYPTION), PAIR_MS, 'O Windows não concluiu o pareamento');
    this.log('pareada');
  }

  /** Drops Windows' pairing record for the strap, reconnects and pairs again. */
  async repair(): Promise<StrapInfo> {
    const target = this.info ?? this.host.remembered();
    await this.close();
    for (const line of await unpairH10().catch((err: unknown) => [`remoção falhou: ${text(err)}`])) this.log(line);
    await sleep(2500);
    const info = target ? await this.openAddress(target, ++this.gen) : await this.open();
    await this.pair();
    return info;
  }

  /** Ends the link and cancels an open() in progress. */
  async close(): Promise<void> {
    this.gen++;
    this.closing = true;
    await this.drop();
  }

  /** Releases the WinRT device object; the next connect starts from a fresh one. */
  private async drop(): Promise<void> {
    const p = this.peripheral;
    const wasClosing = this.closing;
    this.closing = true; // a drop we cause is not a link loss
    this.chars.clear();
    if (p && p.state !== 'disconnected') await within(p.disconnectAsync(), 5000, 'desconexão sem resposta').catch(() => undefined);
    this.closing = wasClosing;
  }
}

class Cancelled extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function within<T>(p: Promise<T>, ms: number, message: string, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          onTimeout?.();
        } catch {
          // cancelling is best effort
        }
        reject(new Error(message));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function normalize(address: string): string {
  return address.replace(/[^0-9a-f]/gi, '').toLowerCase();
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '');
}
