import type { PolarSensor, SensorEvent, SensorStatus } from '../domain/ports/polar-sensor.port';

/** Listener bookkeeping shared by both adapters. */
export abstract class SensorBase implements PolarSensor {
  abstract readonly label: string;
  abstract connect(): Promise<void>;
  abstract disconnect(): void;

  private readonly eventListeners = new Set<(e: SensorEvent) => void>();
  private readonly statusListeners = new Set<(s: SensorStatus) => void>();

  onEvent(listener: (e: SensorEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (s: SensorStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  protected emit(event: SensorEvent): void {
    for (const l of this.eventListeners) l(event);
  }

  protected setStatus(status: SensorStatus): void {
    for (const l of this.statusListeners) l(status);
  }
}
