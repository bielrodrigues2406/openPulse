/** Contract shared by the real Web Bluetooth adapter and the simulator. */

export type SensorEvent =
  | { readonly kind: 'hr'; readonly bpm: number; readonly rrMs: readonly number[]; readonly contact: boolean | null; readonly receivedAt: number }
  | { readonly kind: 'ecg'; readonly samplesUv: Int32Array; readonly receivedAt: number }
  | { readonly kind: 'acc'; readonly samplesMg: Int16Array; readonly receivedAt: number } // interleaved x,y,z
  | { readonly kind: 'battery'; readonly percent: number };

export type SensorStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'connecting'; readonly detail?: string }
  | { readonly state: 'streaming'; readonly deviceName: string }
  | { readonly state: 'error'; readonly message: string };

/** Timestamped connection steps, for the 'copy diagnostics' button. */
export interface DiagnosticsSource {
  diagnostics(): readonly string[];
}

/** A sensor whose Bluetooth pairing the app can remove and redo (desktop, Windows). */
export interface RepairableSensor {
  repairPairing(): Promise<void>;
}

export interface PolarSensor {
  readonly label: string;
  connect(): Promise<void>;
  disconnect(): void;
  onEvent(listener: (event: SensorEvent) => void): () => void;
  onStatus(listener: (status: SensorStatus) => void): () => void;
}
