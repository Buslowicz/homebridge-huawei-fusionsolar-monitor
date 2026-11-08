import type { API, Characteristic, PlatformAccessory, Service } from 'homebridge';
import type { MonitorConfig } from './config.js';
import type { MetricMap } from './contracts.js';
import { connectedPower, gridImportWatts, productionWatts } from './power.js';

// Interoperable electrical service/characteristic IDs, also understood by third-party HomeKit viewers.
// https://github.com/ebaauw/homebridge-lib/blob/master/lib/EveHomeKitTypes.js
export const POWER_SERVICE_UUID = 'E863F008-079E-48FF-8F27-9C2605A29F52';
export const POWER_CHARACTERISTIC_UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';
export type PowerMeterOptions = Pick<MonitorConfig, 'powerMeters' | 'gridPowerDirection'> & {
  readonly advancedTelemetry?: boolean;
};
const defaults: PowerMeterOptions = { powerMeters: true, gridPowerDirection: 'unconfigured' };

interface Reading {
  readonly service: Service;
  readonly characteristic: Characteristic;
  value: number | undefined;
}

/** Independent freshness from plant KPIs: a successful daily energy read must not refresh household power. */
export class PowerMeters {
  private readonly readings = new Map<string, Reading>();
  private receivedAt = 0;
  private expiry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    accessory: PlatformAccessory<Record<string, unknown>>,
    private readonly api: API,
    private readonly typeId: number | 'plant',
    private readonly maxAgeMs: number,
    private readonly now: () => number,
    private readonly options: PowerMeterOptions = defaults
  ) {
    const definitions: readonly (readonly [string, string])[] = !options.powerMeters ? []
      : typeId === 1 || typeId === 38 ? [['production', 'PV Production']]
        : typeId === 17 || typeId === 47 ? [
          ['grid', 'Grid Power'],
          ...(options.gridPowerDirection === 'unconfigured' ? [] : [['import', 'Grid Import'], ['export', 'Grid Export']] as const)
        ] : typeId === 'plant' && options.gridPowerDirection !== 'unconfigured' ? [['consumption', 'Home Consumption']] : [];
    const wanted = new Set(definitions.map(([key]) => `power-${key}`));
    for (const service of [...accessory.services]) {
      if (service.UUID === POWER_SERVICE_UUID && service.subtype?.startsWith('power-') && !wanted.has(service.subtype)) {
        accessory.removeService(service);
      }
    }
    for (const [key, label] of definitions) {
      const subtype = `power-${key}`;
      let service = accessory.services.find((item) => item.UUID === POWER_SERVICE_UUID && item.subtype === subtype);
      if (!service) {
        service = new api.hap.Service(label, POWER_SERVICE_UUID, subtype);
        accessory.addService(service);
      }
      if (!service.characteristics.some((item) => item.UUID === api.hap.Characteristic.StatusFault.UUID)) {
        service.addCharacteristic(api.hap.Characteristic.StatusFault);
      }
      service.displayName = label;
      service.setCharacteristic(api.hap.Characteristic.Name, label);
      let characteristic = service.characteristics.find((item) => item.UUID === POWER_CHARACTERISTIC_UUID);
      if (!characteristic) {
        characteristic = new api.hap.Characteristic(`${label} [W]`, POWER_CHARACTERISTIC_UUID, {
          format: api.hap.Formats.FLOAT,
          unit: 'W',
          minValue: key === 'grid' || key === 'production' ? -Number.MAX_SAFE_INTEGER : 0,
          maxValue: Number.MAX_SAFE_INTEGER,
          perms: [api.hap.Perms.PAIRED_READ, api.hap.Perms.NOTIFY]
        });
        service.addCharacteristic(characteristic);
      }
      const reading: Reading = { service, characteristic, value: undefined };
      this.readings.set(key, reading);
      characteristic.onGet(() => {
        if (reading.value === undefined || this.now() - this.receivedAt > this.maxAgeMs) {
          throw this.error();
        }
        return reading.value;
      });
    }
    this.unavailable();
  }

  update(metrics: MetricMap, receivedAt: number): void {
    if (this.typeId === 'plant') {
      return;
    }
    const power = connectedPower(metrics);
    if (this.typeId === 1 || this.typeId === 38) {
      this.set('production', productionWatts(metrics, this.typeId));
    } else {
      const imported = power === undefined ? undefined : gridImportWatts(power, this.options.gridPowerDirection);
      // The display convention is positive import / negative export once the raw direction is confirmed.
      this.set('grid', imported === undefined ? power : imported === 0 ? 0 : imported);
      this.set('import', imported === undefined ? undefined : Math.max(0, imported));
      this.set('export', imported === undefined ? undefined : Math.max(0, -imported));
    }
    this.refresh(receivedAt);
  }

  updateHome(value: number | undefined, receivedAt: number): void {
    this.set('consumption', this.now() - receivedAt <= this.maxAgeMs ? value : undefined);
    this.refresh(receivedAt);
  }

  private set(key: string, value: number | undefined): void {
    const reading = this.readings.get(key);
    if (!reading) {
      return;
    }
    reading.value = value !== undefined && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : undefined;
    reading.characteristic.updateValue(reading.value ?? this.error());
    reading.service.getCharacteristic(this.api.hap.Characteristic.StatusFault).updateValue(reading.value === undefined ? 1 : 0);
  }

  private refresh(receivedAt: number): void {
    this.receivedAt = receivedAt;
    if (this.expiry) {
      clearTimeout(this.expiry);
    }
    if (this.readings.size) {
      this.expiry = setTimeout(() => this.unavailable(), Math.max(1, this.maxAgeMs - (this.now() - receivedAt) + 1));
      this.expiry.unref();
    }
  }

  private error(): Error {
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  unavailable(): void {
    for (const key of this.readings.keys()) {
      this.set(key, undefined);
    }
  }

  close(): void {
    if (this.expiry) {
      clearTimeout(this.expiry);
    }
    this.unavailable();
  }
}
