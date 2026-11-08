import { createHash } from 'node:crypto';
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { FusionSolarClient, ApiError } from './api-client.js';
import { TelemetryAccessory, accessoryName } from './accessory.js';
import { parseConfig } from './config.js';
import type { MonitorConfig } from './config.js';
import type { Alarm, Device, FusionSolarApi, KpiRecord, Plant } from './contracts.js';
import { SUPPORTED_DEVICE_TYPES } from './contracts.js';
import { DemoApi } from './demo.js';
import { writeSnapshot } from './snapshot.js';

export const PLUGIN_NAME = 'homebridge-huawei-fusionsolar-monitor';
export const PLATFORM_NAME = 'HuaweiFusionSolarMonitor';
type Accessory = PlatformAccessory<Record<string, unknown>>;
type Kind = 'plant' | 'device' | 'alarms';

interface SourceState {
  receivedAt: string | null;
  available: boolean;
  data: unknown;
}

export interface PlatformDependencies {
  readonly client?: FusionSolarApi;
  readonly now?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export class HuaweiFusionSolarPlatform implements DynamicPlatformPlugin {
  private readonly config: MonitorConfig | undefined;
  private readonly client: FusionSolarApi | undefined;
  private readonly now: () => number;
  private readonly instanceId: string;
  private readonly accessories = new Map<string, Accessory>();
  private readonly telemetry = new Map<string, TelemetryAccessory>();
  private readonly sources = new Map<string, SourceState>();
  private plants: readonly Plant[] = [];
  private devices: readonly Device[] = [];
  private discoveryDue = 0;
  private alarmsDue = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private running = false;
  private launched = false;
  private nextDelayMs = 300_000;

  constructor(private readonly log: Logging, rawConfig: PlatformConfig, private readonly api: API, dependencies: PlatformDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    try {
      this.config = parseConfig(rawConfig, dependencies.env);
      this.client = dependencies.client ?? (this.config.demo ? new DemoApi() : new FusionSolarClient({
        baseUrl: this.config.baseUrl, username: this.config.username, password: this.config.password
      }));
    } catch (error: unknown) {
      // Only our local validation messages; never stringify raw configuration or API errors.
      this.log.error(error instanceof Error && !(error instanceof ApiError) ? error.message : 'Nieprawidłowa konfiguracja FusionSolar.');
    }
    this.instanceId = createHash('sha256').update(`${this.config?.baseUrl ?? ''}\0${this.config?.username ?? ''}`).digest('hex').slice(0, 16);
    this.api.on('didFinishLaunching', () => this.start());
    this.api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory: Accessory): void {
    this.accessories.set(accessory.UUID, accessory);
    const rawType: unknown = accessory.context.typeId;
    const typeId = typeof rawType === 'number' && Number.isInteger(rawType) ? rawType : 'plant';
    const isAlarms = accessory.context.kind === 'alarms';
    const wrapper = new TelemetryAccessory(accessory, this.api, typeId, isAlarms ? 3_660_000 : this.maxAgeMs(), !isAlarms && (this.config?.statusSensors ?? false), this.now);
    wrapper.unavailable();
    this.telemetry.set(accessory.UUID, wrapper);
  }

  private maxAgeMs(): number {
    return ((this.config?.pollIntervalSeconds ?? 300) * 2 + 60) * 1000;
  }

  private start(): void {
    if (this.launched || this.stopped || !this.client || !this.config) {
      return;
    }
    this.launched = true;
    if (this.config.demo) {
      this.log.warn('Tryb DEMO: wszystkie odczyty są symulowane. Brak połączenia z Huawei.');
    }
    void this.loop();
  }

  private async loop(): Promise<void> {
    await this.pollOnce();
    if (!this.stopped) {
      // Long server cooldowns remain enforced by the client; avoid Node timer overflow.
      this.timer = setTimeout(() => { void this.loop(); }, Math.min(this.nextDelayMs, 86_400_000));
      this.timer.unref();
    }
  }

  /** One non-overlapping read cycle; event loop owns scheduling. */
  async pollOnce(): Promise<void> {
    if (this.running || this.stopped || !this.client || !this.config) {
      return;
    }
    this.running = true;
    this.nextDelayMs = this.config.pollIntervalSeconds * 1000;
    try {
      if (this.now() >= this.discoveryDue) {
        try {
          await this.discover();
          this.discoveryDue = this.now() + 86_400_000;
        } catch (error: unknown) {
          this.discoveryDue = this.now() + Math.max(3_600_000, this.report(error, 'Wykrywanie urządzeń'));
        }
      }
      if (this.stopped || this.plants.length === 0) {
        return;
      }
      const codes = this.plants.map((plant) => plant.code);
      await this.updateSource('plants', () => this.client!.plantKpis(codes), (records) => {
        for (const plant of this.plants) {
          this.applyRecord('plant', plant.code, records);
        }
      }, this.plants.map((plant) => this.uuid('plant', plant.code)));
      const byType = new Map<number, string[]>();
      for (const device of this.devices) {
        if (SUPPORTED_DEVICE_TYPES.includes(device.typeId)) {
          const group = byType.get(device.typeId) ?? [];
          group.push(device.id);
          byType.set(device.typeId, group);
        }
      }
      for (const [typeId, ids] of byType) {
        if (this.stopped) {
          return;
        }
        await this.updateSource(`devices-${typeId}`, () => this.client!.deviceKpis(typeId, ids), (records) => {
          for (const id of ids) {
            this.applyRecord('device', id, records);
          }
        }, ids.map((id) => this.uuid('device', id)));
      }
      if (!this.stopped && this.config.alarms && this.now() >= this.alarmsDue) {
        this.alarmsDue = this.now() + 1_800_000;
        await this.updateSource('alarms', () => this.client!.activeAlarms(codes), (alarms) => this.applyAlarms(alarms), this.plants.map((plant) => this.uuid('alarms', plant.code)));
      }
      if (!this.stopped && this.config.writeSnapshot) {
        try {
          await writeSnapshot(this.api.user.storagePath(), this.instanceId, {
            schemaVersion: 1, demo: this.config.demo, savedAt: new Date(this.now()).toISOString(),
            plants: this.plants, devices: this.devices, sources: Object.fromEntries(this.sources)
          });
        } catch {
          this.log.warn('Nie udało się zapisać lokalnego zestawu odczytów FusionSolar.');
        }
      }
    } catch (error: unknown) {
      this.report(error, 'Odczyt FusionSolar');
    } finally {
      this.running = false;
    }
  }

  private async discover(): Promise<void> {
    if (!this.client || !this.config) {
      return;
    }
    const all = await this.client.listPlants();
    if (this.stopped) {
      return;
    }
    const plants = this.config.stationCodes.length ? all.filter((plant) => this.config!.stationCodes.includes(plant.code)) : all;
    if (plants.length === 0 || plants.length > 100 || (this.config.stationCodes.length && plants.length !== this.config.stationCodes.length)) {
      throw new Error('Nie znaleziono wybranych instalacji albo konto obejmuje ponad 100 instalacji. Sprawdź uprawnienia i stationCodes.');
    }
    const devices = await this.client.listDevices(plants.map((plant) => plant.code));
    if (this.stopped) {
      return;
    }
    const counts = new Map<number, number>();
    for (const device of devices) {
      counts.set(device.typeId, (counts.get(device.typeId) ?? 0) + 1);
    }
    if ([...counts.values()].some((count) => count > 100)) {
      throw new Error('Wybrano ponad 100 urządzeń jednego typu. Ogranicz stationCodes do domowej instalacji.');
    }
    this.plants = plants;
    this.devices = devices;
    const wanted = new Set<string>();
    for (const plant of plants) {
      wanted.add(this.ensureAccessory('plant', plant.code, plant.name, 'plant', 'FusionSolar plant', plant.code, ''));
      if (this.config.alarms) {
        wanted.add(this.ensureAccessory('alarms', plant.code, `${plant.name} alarmy`, 'plant', 'FusionSolar alarms', plant.code, ''));
      }
    }
    for (const device of devices) {
      if (SUPPORTED_DEVICE_TYPES.includes(device.typeId)) {
        wanted.add(this.ensureAccessory('device', device.id, device.name, device.typeId, device.model, device.serial || device.id, device.softwareVersion));
      }
    }
    for (const [uuid, accessory] of this.accessories) {
      if (!wanted.has(uuid)) {
        this.telemetry.get(uuid)?.close();
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.telemetry.delete(uuid);
        this.accessories.delete(uuid);
      }
    }
    this.api.updatePlatformAccessories([...this.accessories.values()]);
    this.log.info(`Wykryto instalacje: ${plants.length}; urządzenia: ${devices.length}. Odczyt bez sterowania.`);
  }

  private uuid(kind: Kind, id: string): string {
    return this.api.hap.uuid.generate(`${PLUGIN_NAME}:${this.instanceId}:${kind}:${id}`);
  }

  private ensureAccessory(kind: Kind, id: string, name: string, typeId: number | 'plant', model: string, serial: string, firmware: string): string {
    const uuid = this.uuid(kind, id);
    let accessory = this.accessories.get(uuid);
    const isNew = !accessory;
    if (!accessory) {
      accessory = new this.api.platformAccessory<Record<string, unknown>>(accessoryName(name), uuid);
      this.accessories.set(uuid, accessory);
    }
    accessory.context = { schemaVersion: 1, sourceId: id, kind, typeId, instanceId: this.instanceId };
    const info = accessory.getService(this.api.hap.Service.AccessoryInformation);
    info?.setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'Huawei')
      .setCharacteristic(this.api.hap.Characteristic.Model, accessoryName(model || 'FusionSolar'))
      .setCharacteristic(this.api.hap.Characteristic.SerialNumber, `${kind}-${serial}`.slice(0, 64))
      .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, firmware.slice(0, 64) || 'unknown');
    if (!this.telemetry.has(uuid)) {
      this.telemetry.set(uuid, new TelemetryAccessory(accessory, this.api, typeId, kind === 'alarms' ? 3_660_000 : this.maxAgeMs(), this.config?.statusSensors === true && kind !== 'alarms', this.now));
    }
    if (isNew) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    return uuid;
  }

  private applyRecord(kind: 'plant' | 'device', id: string, records: readonly KpiRecord[]): void {
    const wrapper = this.telemetry.get(this.uuid(kind, id));
    const record = records.find((item) => item.id === id);
    if (!record) {
      wrapper?.unavailable();
      return;
    }
    wrapper?.update(record.values, this.now());
  }

  private applyAlarms(alarms: readonly Alarm[]): void {
    for (const plant of this.plants) {
      const selected = alarms.filter((alarm) => alarm.stationCode === plant.code)
        .sort((a, b) => a.severity - b.severity || b.raisedAt - a.raisedAt);
      const values: Record<string, number | string | null> = { alarm_count: selected.length };
      for (let level = 1; level <= 4; level++) {
        values[`alarm_count_level_${level}`] = selected.filter((alarm) => alarm.severity === level).length;
      }
      // Fixed slots prevent unbounded HomeKit schema growth as new alarms appear.
      for (let index = 0; index < 20; index++) {
        const alarm = selected[index];
        const prefix = `alarm_${index + 1}`;
        values[`${prefix}_name`] = alarm?.name ?? null;
        values[`${prefix}_id`] = alarm?.id ?? null;
        values[`${prefix}_severity`] = alarm?.severity ?? null;
        values[`${prefix}_raised_at`] = alarm ? new Date(alarm.raisedAt).toISOString() : null;
        values[`${prefix}_cause`] = alarm?.cause ?? null;
        values[`${prefix}_suggestion`] = alarm?.suggestion ?? null;
      }
      this.telemetry.get(this.uuid('alarms', plant.code))?.update(values, this.now());
    }
  }

  private async updateSource<T>(key: string, load: () => Promise<readonly T[]>, apply: (records: readonly T[]) => void, uuids: readonly string[]): Promise<void> {
    try {
      const data = await load();
      if (this.stopped) {
        return;
      }
      apply(data);
      this.sources.set(key, { receivedAt: new Date(this.now()).toISOString(), available: true, data });
      this.api.updatePlatformAccessories([...this.accessories.values()]);
    } catch (error: unknown) {
      for (const uuid of uuids) {
        this.telemetry.get(uuid)?.unavailable();
      }
      const previous = this.sources.get(key);
      this.sources.set(key, { receivedAt: previous?.receivedAt ?? null, available: false, data: previous?.data ?? null });
      this.report(error, 'Odczyt danych');
    }
  }

  private report(error: unknown, context: string): number {
    const delay = error instanceof ApiError ? (error.retryAfterMs ?? 0) : 0;
    this.nextDelayMs = Math.max(this.nextDelayMs, delay);
    const reason = error instanceof ApiError ? `${error.kind}${error.code !== undefined ? ` (${error.code})` : ''}` : 'nieprawidłowe dane lub konfiguracja';
    this.log.warn(`${context}: ${reason}. Kolejna próba zgodnie z limitami API.`);
    return delay;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.client?.close();
    for (const wrapper of this.telemetry.values()) {
      wrapper.close();
    }
  }
}
