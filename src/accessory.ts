import { createHash } from 'node:crypto';
import type { API, Characteristic, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { MetricMap, MetricValue } from './contracts.js';
import { describeMetric, withStateLabels } from './metrics.js';
import { PowerMeters } from './power-meter.js';
import type { PowerMeterOptions } from './power-meter.js';

type Accessory = PlatformAccessory<Record<string, unknown>>;
export const METRIC_SERVICE_SEED = 'huawei-fusionsolar-monitor:metrics:v1';

/** HomeKit limits strings by UTF-8 bytes, not JavaScript UTF-16 code units. */
export function hapText(value: string, maxBytes = 256): string {
  let result = '';
  for (const original of value) {
    const char = original.charCodeAt(0) < 32 || original.charCodeAt(0) === 127 ? ' ' : original;
    if (Buffer.byteLength(result + char, 'utf8') > maxBytes) {
      break;
    }
    result += char;
  }
  return result;
}

export function accessoryName(value: string): string {
  return hapText(value.replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/gu, ' ').trim(), 60) || 'Huawei';
}

export class TelemetryAccessory {
  private values = new Map<string, CharacteristicValue>();
  private available = false;
  private receivedAt = 0;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private readonly serviceUuid: string;
  private readonly metricChars = new Set<Characteristic>();
  private readonly contactServices = new Map<string, Service>();
  private readonly temperatureService: Service | undefined;
  private readonly powerMeters: PowerMeters;

  constructor(
    readonly accessory: Accessory,
    private readonly api: API,
    private readonly typeId: number | 'plant',
    private readonly maxAgeMs: number,
    statusSensors: boolean,
    private readonly now: () => number = Date.now,
    powerOptions?: PowerMeterOptions
  ) {
    const hap = api.hap;
    this.powerMeters = new PowerMeters(accessory, api, typeId, maxAgeMs, now, powerOptions);
    this.serviceUuid = hap.uuid.generate(METRIC_SERVICE_SEED);
    for (const service of accessory.services) {
      if (service.UUID === this.serviceUuid) {
        const bucket = /^metrics-(\d+)$/u.exec(service.subtype ?? '');
        if (bucket) {
          this.nameService(service, `Huawei metrics ${Number(bucket[1]) + 1}`);
        }
        for (const characteristic of service.characteristics) {
          if (![hap.Characteristic.Name.UUID, hap.Characteristic.StatusFault.UUID].includes(characteristic.UUID)) {
            characteristic.onGet(() => this.read(characteristic.UUID));
            characteristic.updateValue(this.error());
            this.metricChars.add(characteristic);
          }
        }
        service.getCharacteristic(hap.Characteristic.StatusFault).updateValue(1);
      }
    }
    if (statusSensors && typeId === 'plant') {
      this.addContact('health', 'Huawei Plant Fault');
    }
    if (statusSensors && (typeId === 1 || typeId === 38)) {
      this.addContact('production', 'Huawei PV Production');
    }
    // Restored sensors remain unavailable until data is received, even after a restart.
    for (const service of accessory.services) {
      if (service.UUID === hap.Service.ContactSensor.UUID && service.subtype) {
        const label = service.subtype === 'health' ? 'Huawei Plant Fault' : service.subtype === 'production' ? 'Huawei PV Production' : undefined;
        if (label) {
          this.nameService(service, label);
        }
        this.contactServices.set(service.subtype, service);
        this.bindContact(service, service.subtype);
      }
    }
    if (!statusSensors) {
      for (const service of this.contactServices.values()) {
        accessory.removeService(service);
      }
      this.contactServices.clear();
    }
    if (typeof typeId === 'number' && [1, 38].includes(typeId)) {
      this.temperatureService = accessory.getService(hap.Service.TemperatureSensor)
        ?? accessory.addService(hap.Service.TemperatureSensor, 'Huawei Inverter Temperature', 'temperature');
      this.nameService(this.temperatureService, 'Huawei Inverter Temperature');
      this.temperatureService.getCharacteristic(hap.Characteristic.CurrentTemperature)
        .setProps({ minValue: -100, maxValue: 200, minStep: null })
        .onGet(() => {
          const value = this.read(this.metricUuid('temperature'));
          if (typeof value !== 'number' || value < -100 || value > 200) {
            throw this.error();
          }
          return value;
        });
      this.temperatureService.getCharacteristic(hap.Characteristic.StatusFault).updateValue(1);
      this.temperatureService.getCharacteristic(hap.Characteristic.CurrentTemperature).updateValue(this.error());
    }
  }

  private error(): Error {
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private nameService(service: Service, label: string): void {
    service.displayName = label;
    service.setCharacteristic(this.api.hap.Characteristic.Name, label);
  }

  updateHomeConsumption(value: number | undefined, receivedAt: number): void {
    this.powerMeters.updateHome(value, receivedAt);
  }

  private read(uuid: string): CharacteristicValue {
    const value = this.values.get(uuid);
    if (!this.available || this.now() - this.receivedAt > this.maxAgeMs || value === undefined) {
      throw this.error();
    }
    return value;
  }

  metricUuid(key: string): string {
    return this.api.hap.uuid.generate(`huawei-fusionsolar-monitor:metric:v1:${this.typeId}:${key}`);
  }

  private addContact(subtype: string, name: string): void {
    const service = this.accessory.getServiceById(this.api.hap.Service.ContactSensor, subtype)
      ?? this.accessory.addService(this.api.hap.Service.ContactSensor, name, subtype);
    this.contactServices.set(subtype, service);
    this.bindContact(service, subtype);
  }

  private bindContact(service: Service, subtype: string): void {
    service.getCharacteristic(this.api.hap.Characteristic.ContactSensorState)
      .onGet(() => this.read(this.metricUuid(`contact:${subtype}`))).updateValue(this.error());
    service.getCharacteristic(this.api.hap.Characteristic.StatusFault).updateValue(1);
  }

  update(metrics: MetricMap, receivedAt: number): void {
    this.powerMeters.update(metrics, receivedAt);
    const expanded = withStateLabels(metrics);
    const disconnected = expanded.run_state === 0 || expanded.meter_status === 0
      || (this.typeId === 'plant' && expanded.real_health_state === 1);
    this.values = new Map();
    this.receivedAt = receivedAt;
    this.available = true;
    for (const [key, value] of Object.entries(expanded)) {
      if (disconnected && !['run_state', 'run_state_text', 'meter_status', 'meter_status_text', 'real_health_state', 'real_health_state_text', 'inverter_state', 'inverter_state_text'].includes(key)) {
        continue;
      }
      this.updateMetric(key, value);
    }
    // Receive time is deliberately not labelled as a device measurement timestamp.
    this.updateMetric('api_received_at', new Date(receivedAt).toISOString());
    for (const characteristic of this.metricChars) {
      if (!this.values.has(characteristic.UUID)) {
        characteristic.updateValue(this.error());
      }
    }
    for (const service of this.accessory.services) {
      if (service.UUID === this.serviceUuid) {
        service.getCharacteristic(this.api.hap.Characteristic.StatusFault).updateValue(disconnected ? 1 : 0);
      }
    }
    const health = expanded.real_health_state;
    this.updateContact('health', typeof health === 'number' && [1, 2, 3].includes(health) ? (health === 3 ? 0 : 1) : undefined);
    const power = expanded.active_power;
    this.updateContact('production', !disconnected && typeof power === 'number' ? (power > 0 ? 1 : 0) : undefined);
    if (this.temperatureService) {
      const temperature = expanded.temperature;
      const valid = !disconnected && typeof temperature === 'number' && temperature >= -100 && temperature <= 200;
      this.temperatureService.getCharacteristic(this.api.hap.Characteristic.CurrentTemperature).updateValue(valid ? temperature : this.error());
      this.temperatureService.getCharacteristic(this.api.hap.Characteristic.StatusFault).updateValue(valid ? 0 : 1);
    }
    if (this.expiry) {
      clearTimeout(this.expiry);
    }
    this.expiry = setTimeout(() => this.unavailable(), Math.max(1, this.maxAgeMs - (this.now() - receivedAt) + 1));
    this.expiry.unref();
  }

  private updateContact(subtype: string, value: number | undefined): void {
    const service = this.contactServices.get(subtype);
    if (!service) {
      return;
    }
    if (value !== undefined) {
      this.values.set(this.metricUuid(`contact:${subtype}`), value);
    }
    service.getCharacteristic(this.api.hap.Characteristic.ContactSensorState).updateValue(value ?? this.error());
    service.getCharacteristic(this.api.hap.Characteristic.StatusFault).updateValue(value === undefined ? 1 : 0);
  }

  private updateMetric(key: string, value: MetricValue): void {
    if (value === null) {
      return;
    }
    const hap = this.api.hap;
    const description = describeMetric(key, this.typeId, value);
    const uuid = this.metricUuid(key);
    // Stable hash buckets ensure adding a new KPI does not move existing characteristics.
    const bucket = (createHash('sha256').update(key).digest()[0] ?? 0) % 16;
    const subtype = `metrics-${bucket}`;
    // Homebridge's string overload matches a service NAME, not its UUID.
    let service = this.accessory.services.find((candidate) => candidate.UUID === this.serviceUuid && candidate.subtype === subtype);
    if (!service) {
      service = new hap.Service(`Huawei metrics ${bucket + 1}`, this.serviceUuid, subtype);
      this.accessory.addService(service);
      service.addCharacteristic(hap.Characteristic.StatusFault);
    }
    let characteristic = service.characteristics.find((candidate) => candidate.UUID === uuid);
    const label = `${description.label}${description.unit ? ` [${description.unit}]` : ''}`;
    if (!characteristic) {
      if (service.characteristics.length >= 90) {
        throw new Error('Too many metric characteristics in a HomeKit service.');
      }
      characteristic = new hap.Characteristic(hapText(label, 64), uuid, {
        format: description.numeric ? hap.Formats.FLOAT : hap.Formats.STRING,
        perms: [hap.Perms.PAIRED_READ, hap.Perms.NOTIFY],
        ...(description.numeric ? { minValue: -Number.MAX_SAFE_INTEGER, maxValue: Number.MAX_SAFE_INTEGER } : { maxLen: 256 })
      });
      service.addCharacteristic(characteristic);
      this.metricChars.add(characteristic);
    }
    characteristic.displayName = hapText(label, 64);
    characteristic.onGet(() => this.read(uuid));
    let converted: CharacteristicValue | undefined;
    if (String(characteristic.props.format) === String(hap.Formats.FLOAT)) {
      if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
        converted = value;
      }
    } else {
      converted = hapText(String(value));
    }
    if (converted !== undefined) {
      this.values.set(uuid, converted);
      characteristic.updateValue(converted);
    } else {
      characteristic.updateValue(this.error());
    }
  }

  unavailable(): void {
    this.powerMeters.unavailable();
    this.available = false;
    for (const characteristic of this.metricChars) {
      characteristic.updateValue(this.error());
    }
    for (const service of this.accessory.services) {
      if (service.UUID === this.serviceUuid || service.UUID === this.api.hap.Service.ContactSensor.UUID || service === this.temperatureService) {
        service.getCharacteristic(this.api.hap.Characteristic.StatusFault).updateValue(1);
      }
    }
    for (const service of this.contactServices.values()) {
      service.getCharacteristic(this.api.hap.Characteristic.ContactSensorState).updateValue(this.error());
    }
    this.temperatureService?.getCharacteristic(this.api.hap.Characteristic.CurrentTemperature).updateValue(this.error());
  }

  close(): void {
    this.powerMeters.close();
    if (this.expiry) {
      clearTimeout(this.expiry);
    }
    this.unavailable();
  }
}
