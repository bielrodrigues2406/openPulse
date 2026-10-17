import type { DiagnosticsSource, PolarSensor, SensorStatus } from '../domain/ports/polar-sensor.port';

export type SourceKind = 'h10' | 'sim';

export interface HubSnapshot {
  readonly source: SourceKind;
  readonly status: SensorStatus;
  readonly battery: number | null;
}

/**
 * Owns the one strap connection the app uses (real H10 or simulator). Screens and the live
 * session observe it; switching source swaps the adapter and tells listeners to re-attach.
 */
export class SensorHub {
  private sensor: PolarSensor;
  private snap: HubSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly swapListeners = new Set<(s: PolarSensor) => void>();
  private detach: (() => void) | null = null;

  constructor(
    source: SourceKind,
    private readonly make: (kind: SourceKind) => PolarSensor,
  ) {
    this.sensor = make(source);
    this.snap = { source, status: { state: 'idle' }, battery: null };
    this.bind();
  }

  current(): PolarSensor {
    return this.sensor;
  }

  diagnostics(): readonly string[] | null {
    const d = this.sensor as Partial<DiagnosticsSource>;
    return typeof d.diagnostics === 'function' ? d.diagnostics() : null;
  }

  connect(): Promise<void> {
    return this.sensor.connect();
  }

  disconnect(): void {
    this.sensor.disconnect();
  }

  setSource(kind: SourceKind): void {
    if (kind === this.snap.source) return;
    this.sensor.disconnect();
    this.detach?.();
    this.sensor = this.make(kind);
    this.snap = { source: kind, status: { state: 'idle' }, battery: null };
    this.bind();
    for (const l of this.swapListeners) l(this.sensor);
    this.emit();
  }

  /** Called with the new adapter whenever the source changes. */
  onSwap(l: (s: PolarSensor) => void): () => void {
    this.swapListeners.add(l);
    return () => this.swapListeners.delete(l);
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): HubSnapshot => this.snap;

  private bind(): void {
    const offStatus = this.sensor.onStatus((status) => {
      this.snap = { ...this.snap, status, battery: status.state === 'streaming' ? this.snap.battery : null };
      this.emit();
    });
    const offEvent = this.sensor.onEvent((e) => {
      if (e.kind === 'battery') {
        this.snap = { ...this.snap, battery: e.percent };
        this.emit();
      }
    });
    this.detach = () => {
      offStatus();
      offEvent();
    };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
