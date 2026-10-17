// Minimal Web Bluetooth typings for what this app uses (not in lib.dom).
interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly value: DataView | null;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  writeValueWithResponse(value: BufferSource): Promise<void>;
  readValue(): Promise<DataView>;
}
interface BluetoothRemoteGATTService {
  getCharacteristic(uuid: string | number): Promise<BluetoothRemoteGATTCharacteristic>;
}
interface BluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(uuid: string | number): Promise<BluetoothRemoteGATTService>;
}
interface BluetoothDevice extends EventTarget {
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServer;
}
interface Bluetooth {
  requestDevice(options: {
    filters: { namePrefix?: string; services?: (string | number)[] }[];
    optionalServices?: (string | number)[];
  }): Promise<BluetoothDevice>;
}
interface Navigator {
  readonly bluetooth?: Bluetooth;
}
