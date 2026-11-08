import type { Device, MetricMap } from './contracts.js';
import type { MonitorConfig } from './config.js';

export function connectedPower(values: MetricMap | undefined): number | undefined {
  const power = values?.active_power;
  return values?.run_state !== 0 && values?.meter_status !== 0
    && typeof power === 'number' && Number.isFinite(power) && Math.abs(power) <= Number.MAX_SAFE_INTEGER
    ? power : undefined;
}

/** The inverter API reports kW; meter readings already use W and are not converted. */
export function productionWatts(values: MetricMap, typeId: number): number | undefined {
  const power = connectedPower(values);
  const watts = power === undefined ? undefined : power * 1000;
  return [1, 38].includes(typeId) && watts !== undefined && Math.abs(watts) <= Number.MAX_SAFE_INTEGER ? watts : undefined;
}

export function gridImportWatts(power: number, direction: MonitorConfig['gridPowerDirection']): number | undefined {
  return direction === 'unconfigured' ? undefined : direction === 'positiveImport' ? power : -power;
}

/** Only the current poll's validated records may participate; never reuse a successful old sample. */
export function homeConsumptionWatts(
  devices: readonly Device[],
  samples: ReadonlyMap<string, MetricMap>,
  config: Pick<MonitorConfig, 'gridMeterId' | 'gridPowerDirection'>
): number | undefined {
  if (config.gridPowerDirection === 'unconfigured' || devices.some((device) => [39, 41].includes(device.typeId))) {
    return undefined;
  }
  const inverters = devices.filter((device) => [1, 38].includes(device.typeId));
  const meters = devices.filter((device) => [17, 47].includes(device.typeId)
    && (config.gridMeterId === undefined || device.id === config.gridMeterId));
  if (!inverters.length || meters.length !== 1) {
    return undefined;
  }
  const meter = meters[0];
  const grid = meter && connectedPower(samples.get(meter.id));
  if (grid === undefined) {
    return undefined;
  }
  let production = 0;
  for (const inverter of inverters) {
    const power = productionWatts(samples.get(inverter.id) ?? {}, inverter.typeId);
    if (power === undefined) {
      return undefined;
    }
    production += power;
  }
  const consumption = production + (gridImportWatts(grid, config.gridPowerDirection) ?? NaN);
  // Inconsistent asynchronous cloud samples/sign settings are unavailable, never clamped to a fake zero.
  return Number.isFinite(consumption) && consumption >= 0 && consumption <= Number.MAX_SAFE_INTEGER ? consumption : undefined;
}
