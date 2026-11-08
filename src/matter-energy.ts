import type { API, Logging, MatterAccessory, MatterAPI } from 'homebridge';
import type { Plant } from './contracts.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './identifiers.js';
import { hapText } from './accessory.js';

const MARKER = 'home-consumption-v1';
const WAIT_MS = 1000;

interface Reading {
  readonly accessory: MatterAccessory;
  registered: boolean;
  desired: number | null;
  revision: number;
  expiry: ReturnType<typeof setTimeout> | undefined;
  work: Promise<void> | undefined;
}

/** Optional, read-only whole-house power. Generation and grid flows must not be summed into it. */
export class MatterEnergy {
  private readonly matter: MatterAPI | undefined;
  private readonly readings = new Map<string, Reading>();
  private closed = false;
  private discovery: Promise<void> | undefined;
  private plants: readonly Plant[] = [];

  constructor(
    private readonly api: API,
    private readonly identity: string,
    private readonly maxAgeMs: number,
    private readonly log: Logging,
    private readonly now: () => number = Date.now
  ) {
    // Type-only Homebridge imports keep Homebridge 1 and HAP-only bridges working.
    const matter = api.matter;
    this.matter = matter?.deviceTypes?.ElectricalSensor ? matter : undefined;
    if (!this.matter) {
      this.log.info('Native energy is unavailable: enable Matter on this Homebridge 2.5 or newer bridge. HomeKit telemetry continues.');
    }
  }

  restore(accessory: MatterAccessory): void {
    if (this.closed || !this.matter || accessory.context.kind !== MARKER
      || typeof accessory.context.sourceId !== 'string'
      || accessory.UUID !== this.uuid(accessory.context.sourceId)) {
      return;
    }
    const code = accessory.context.sourceId;
    const previous = this.readings.get(code);
    if (previous?.expiry) clearTimeout(previous.expiry);
    // Never trust a cached reading, even before the bridge is ready to accept updates.
    accessory.context = { kind: MARKER, sourceId: code };
    accessory.clusters = this.unavailableClusters();
    const reading = this.reading(accessory, true);
    this.readings.set(code, reading);
    void this.push(reading);
    reading.registered = false;
  }

  async discover(plants: readonly Plant[]): Promise<void> {
    if (!this.matter || this.closed) return;
    this.plants = plants;
    // A timed-out registration stays in flight; never build an unbounded work queue.
    this.discovery ??= this.register(plants).catch(() => {
      this.log.warn('Native energy discovery failed; HomeKit telemetry continues.');
    }).finally(() => { this.discovery = undefined; });
    await this.wait(this.discovery);
  }

  private async register(plants: readonly Plant[]): Promise<void> {
    const matter = this.matter!;
    const wanted = new Set(plants.map((plant) => plant.code));
    const selected: Reading[] = [];
    for (const plant of plants) {
      let reading = this.readings.get(plant.code);
      if (!reading) {
        const uuid = this.uuid(plant.code);
        reading = this.reading({
          UUID: uuid,
          displayName: this.name(plant.name),
          deviceType: matter.deviceTypes.ElectricalSensor,
          serialNumber: uuid.replaceAll('-', ''),
          manufacturer: 'Huawei',
          model: 'FusionSolar Home Consumption',
          context: { kind: MARKER, sourceId: plant.code },
          clusters: this.unavailableClusters()
        }, false);
        this.readings.set(plant.code, reading);
      }
      if (!reading.registered) {
        reading.accessory.deviceType = matter.deviceTypes.ElectricalSensor;
        reading.accessory.displayName = this.name(plant.name);
        reading.accessory.clusters = this.unavailableClusters();
        this.setDesired(reading, null);
        selected.push(reading);
      }
    }
    if (selected.length) {
      // Cached accessories must also be registered on every startup (#4015).
      await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, selected.map((reading) => reading.accessory));
      // Homebridge settles tracked registration work without rethrowing every engine
      // failure. Confirm the endpoint actually exists before accepting fresh samples.
      await Promise.all(selected.map(async (reading) => {
        const state: unknown = await matter.getAccessoryState(reading.accessory.UUID, 'electricalPowerMeasurement');
        if (typeof state !== 'object' || state === null || Array.isArray(state)
          || !('activePower' in state)
          || (state.activePower !== null && (typeof state.activePower !== 'number' || !Number.isSafeInteger(state.activePower)))) {
          throw new Error('Native energy endpoint is not ready.');
        }
      }));
      await Promise.all(selected.map(async (reading) => {
        reading.registered = true;
        // Registration preserves cached state: explicitly clear it before any fresh sample.
        await this.write(reading, null);
        if (this.closed) this.setDesired(reading, null);
        await this.push(reading);
      }));
    }
    if (this.closed) return;
    // Only a successful discovery/registration may remove cached endpoints.
    const stale = [...this.readings].filter(([code]) => !wanted.has(code));
    if (stale.length) {
      for (const [, reading] of stale) {
        this.setDesired(reading, null);
        // Removal itself makes the endpoint unavailable. The public update API emits
        // asynchronously, so sending a reset immediately before removal races a closed endpoint.
        reading.registered = false;
      }
      await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale.map(([, reading]) => reading.accessory));
      for (const [code] of stale) this.readings.delete(code);
    }
  }

  async update(plantCode: string, watts: number | undefined, receivedAt: number): Promise<void> {
    const reading = this.readings.get(plantCode);
    if (!reading || this.closed || !this.matter) return;
    // A transient bridge startup failure is retried on the next poll, not the next daily discovery.
    if (!reading.registered) await this.discover(this.plants);
    if (this.closed) return;
    const age = this.now() - receivedAt;
    const milliwatts = watts === undefined ? NaN : Math.round(watts * 1000);
    const valid = watts !== undefined && Number.isFinite(watts) && watts >= 0
      && Number.isSafeInteger(milliwatts) && Number.isFinite(age) && age >= 0 && age <= this.maxAgeMs;
    this.setDesired(reading, valid ? milliwatts : null);
    if (valid) {
      reading.expiry = setTimeout(() => {
        this.setDesired(reading, null);
        void this.push(reading);
      }, Math.min(2_147_483_647, Math.max(1, this.maxAgeMs - age + 1)));
      reading.expiry.unref();
    }
    await this.wait(this.push(reading));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reading of this.readings.values()) {
      this.setDesired(reading, null);
      void this.push(reading);
    }
  }

  private uuid(code: string): string {
    return this.api.hap.uuid.generate(`huawei-fusionsolar-monitor:matter-home-consumption:v1:${this.identity}:${code}`);
  }

  private name(plantName: string): string {
    return `${hapText(plantName, 15) || 'Huawei'} Home Consumption`;
  }

  private unavailableClusters(): NonNullable<MatterAccessory['clusters']> {
    return { electricalPowerMeasurement: { activePower: null }, bridgedDeviceBasicInformation: { reachable: false } };
  }

  private reading(accessory: MatterAccessory, registered: boolean): Reading {
    return { accessory, registered, desired: null, revision: 0, expiry: undefined, work: undefined };
  }

  private setDesired(reading: Reading, value: number | null): void {
    if (reading.expiry) clearTimeout(reading.expiry);
    reading.expiry = undefined;
    reading.desired = value;
    reading.revision++;
  }

  private push(reading: Reading): Promise<void> {
    if (!reading.registered) return Promise.resolve();
    reading.work ??= (async () => {
      let revision: number;
      do {
        revision = reading.revision;
        try {
          await this.write(reading, reading.desired);
        } catch {
          this.setDesired(reading, null);
          this.log.warn('Native energy update failed; its reading is unavailable. HomeKit telemetry continues.');
          // Try the unavailable state once; never loop endlessly on a failed API.
          await this.write(reading, null).catch(() => undefined);
          return;
        }
      } while (reading.registered && revision !== reading.revision);
    })().finally(() => { reading.work = undefined; });
    return reading.work;
  }

  private async write(reading: Reading, activePower: number | null): Promise<void> {
    // Mark unreachable first when invalidating, so an old value is never advertised as fresh.
    if (activePower === null) {
      await this.matter!.updateAccessoryState(reading.accessory.UUID, 'bridgedDeviceBasicInformation', { reachable: false });
    }
    await this.matter!.updateAccessoryState(reading.accessory.UUID, 'electricalPowerMeasurement', { activePower });
    if (activePower !== null) {
      await this.matter!.updateAccessoryState(reading.accessory.UUID, 'bridgedDeviceBasicInformation', { reachable: true });
    }
  }

  private async wait(work: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.log.warn('Native energy is taking longer than expected; HomeKit telemetry continues.');
          resolve();
        }, WAIT_MS);
      })
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }
}
