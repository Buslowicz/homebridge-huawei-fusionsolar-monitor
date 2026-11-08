/** Validated, deliberately minimal models. No account/contact/location payloads. */
export type MetricValue = number | string | boolean | null;
export type MetricMap = Readonly<Record<string, MetricValue>>;

export interface Plant {
  readonly code: string;
  readonly name: string;
  readonly capacityKwP?: number;
}

export interface Device {
  /** Decimal string: Huawei Long IDs must never lose precision. */
  readonly id: string;
  readonly stationCode: string;
  readonly name: string;
  readonly typeId: number;
  readonly serial: string;
  readonly model: string;
  readonly softwareVersion: string;
}

export interface KpiRecord {
  /** plantCode for plants; devId for devices. */
  readonly id: string;
  readonly values: MetricMap;
}

export interface Alarm {
  readonly stationCode: string;
  readonly serial: string;
  readonly name: string;
  readonly id: number;
  readonly severity: number;
  readonly raisedAt: number;
  readonly cause: string;
  readonly suggestion: string;
}

export interface FusionSolarApi {
  listPlants(): Promise<readonly Plant[]>;
  listDevices(stationCodes: readonly string[]): Promise<readonly Device[]>;
  plantKpis(stationCodes: readonly string[]): Promise<readonly KpiRecord[]>;
  deviceKpis(typeId: number, ids: readonly string[]): Promise<readonly KpiRecord[]>;
  activeAlarms(stationCodes: readonly string[]): Promise<readonly Alarm[]>;
  close(): void;
}

export const SUPPORTED_DEVICE_TYPES: readonly number[] = [1, 10, 17, 38, 39, 41, 47, 23070];
