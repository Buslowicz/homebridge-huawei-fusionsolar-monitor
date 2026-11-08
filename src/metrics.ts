import type { MetricMap, MetricValue } from './contracts.js';

export interface MetricDescription {
  readonly label: string;
  readonly unit?: string;
  readonly numeric: boolean;
}

const common: Readonly<Record<string, readonly [string, string?]>> = {
  day_power: ['Production today', 'kWh'], month_power: ['Production this month', 'kWh'],
  total_power: ['Total production', 'kWh'], day_income: ['Income today'], total_income: ['Total income'],
  day_on_grid_energy: ['Energy exported today', 'kWh'], day_use_energy: ['Consumption today', 'kWh'],
  real_health_state: ['Plant state - code'], inverter_state: ['Inverter state - code'],
  run_state: ['Device connection - code'], meter_status: ['Meter state - code'],
  efficiency: ['Inverter efficiency', '%'], temperature: ['Internal temperature', '°C'],
  power_factor: ['Power factor'], elec_freq: ['Grid frequency', 'Hz'],
  grid_frequency: ['Grid frequency', 'Hz'], day_cap: ['Production today', 'kWh'],
  total_cap: ['Total production', 'kWh'], mppt_power: ['MPPT input power', 'kW'],
  mppt_total_cap: ['Total DC input energy', 'kWh'],
  open_time: ['Startup time - Unix', 'ms'], close_time: ['Shutdown time - Unix', 'ms'],
  active_cap: ['Positive active energy', 'kWh'], reverse_active_cap: ['Negative active energy', 'kWh'],
  forward_reactive_cap: ['Positive reactive energy', 'kvarh'], reverse_reactive_cap: ['Negative reactive energy', 'kvarh'],
  total_apparent_power: ['Apparent power', 'kVA'], meter_u: ['Phase A voltage', 'V'], meter_i: ['Phase A current', 'A'],
  battery_soc: ['Battery state of charge', '%'], battery_soh: ['Battery state of health', '%'],
  ch_discharge_power: ['Charge and discharge power', 'W'], busbar_u: ['Battery voltage', 'V'],
  max_charge_power: ['Maximum charge power', 'W'], max_discharge_power: ['Maximum discharge power', 'W'],
  pv_temperature: ['Panel temperature', '°C'], wind_speed: ['Wind speed', 'm/s'],
  wind_direction: ['Wind direction', '°'], radiant_total: ['Irradiation today', 'MJ/m²'],
  radiant_line: ['Irradiance', 'W/m²']
};

export function describeMetric(key: string, typeId: number | 'plant', value: MetricValue): MetricDescription {
  if (key === 'api_received_at') {
    return { label: 'API received at', numeric: false };
  }
  if (key.endsWith('_text')) {
    const source = common[key.slice(0, -5)];
    if (source) {
      return { label: source[0].replace(' - code', ' - description'), numeric: false };
    }
  }
  if (key === 'alarm_count') {
    return { label: 'Active alarms', numeric: true };
  }
  const alarmLevel = /^alarm_count_level_([1-4])$/u.exec(key);
  if (alarmLevel) {
    const levels: Readonly<Record<string, string>> = { '1': 'critical', '2': 'major', '3': 'minor', '4': 'warning' };
    return { label: `Alarms ${levels[alarmLevel[1] ?? '']}`, numeric: true };
  }
  const alarmField = /^alarm_(\d+)_(name|id|severity|raised_at|cause|suggestion)$/u.exec(key);
  if (alarmField) {
    const fields: Readonly<Record<string, string>> = { name: 'name', id: 'code', severity: 'severity 1 to 4', raised_at: 'raised at', cause: 'cause', suggestion: 'suggestion' };
    return { label: `Alarm ${alarmField[1]} - ${fields[alarmField[2] ?? '']}`, numeric: alarmField[2] === 'id' || alarmField[2] === 'severity' };
  }
  const entry = common[key];
  if (entry) {
    // The same Huawei key uses different units depending on device type.
    const unit = typeId === 47 && ['forward_reactive_cap', 'reverse_reactive_cap'].includes(key) ? 'kWh' : entry[1];
    return { label: entry[0], ...(unit ? { unit } : {}), numeric: true };
  }
  if (key === 'active_power') {
    return { label: 'Active power', unit: typeId === 17 || typeId === 47 ? 'W' : 'kW', numeric: true };
  }
  if (key === 'reactive_power') {
    return { label: 'Reactive power', unit: typeId === 17 || typeId === 47 ? 'var' : 'kvar', numeric: true };
  }
  const phase = /^([abc])_([ui])$/u.exec(key);
  if (phase) {
    return { label: `${phase[2] === 'u' ? 'Voltage' : 'Current'} phase ${phase[1]?.toUpperCase()}`, unit: phase[2] === 'u' ? 'V' : 'A', numeric: true };
  }
  if (/^(ab|bc|ca)_u$/u.test(key)) {
    return { label: `Line voltage ${key.slice(0, 2).toUpperCase()}`, unit: 'V', numeric: true };
  }
  const pv = /^pv(\d+)_([ui])$/u.exec(key);
  if (pv) {
    return { label: `PV${pv[1]} ${pv[2] === 'u' ? 'voltage' : 'current'}`, unit: pv[2] === 'u' ? 'V' : 'A', numeric: true };
  }
  const mppt = /^mppt_(\d+)_cap$/u.exec(key);
  if (mppt) {
    return { label: `MPPT ${mppt[1]} DC energy`, unit: 'kWh', numeric: true };
  }
  if (/^active_power_[abc]$/u.test(key)) {
    return { label: `Active power phase ${key.slice(-1).toUpperCase()}`, unit: typeId === 17 || typeId === 47 ? 'W' : 'kW', numeric: true };
  }
  if (/^reactive_power_[abc]$/u.test(key)) {
    return { label: `Reactive power phase ${key.slice(-1).toUpperCase()}`, unit: 'kvar', numeric: true };
  }
  return { label: key.replaceAll('_', ' '), numeric: typeof value === 'number' };
}

const inverterStates: Readonly<Record<number, string>> = {
  0: 'Standby: initialization', 1: 'Standby: insulation test', 2: 'Standby: irradiance',
  3: 'Standby: grid', 7: 'Initialization after storage', 256: 'Starting',
  512: 'Grid connected', 513: 'Grid connected: power limited', 514: 'Grid connected: derating',
  768: 'Shutdown: fault', 769: 'Shutdown: command', 770: 'Shutdown: OVGR',
  771: 'Shutdown: communication', 772: 'Shutdown: power limited',
  773: 'Manual startup required', 774: 'Shutdown: DC switches',
  1025: 'Grid regulation: curve cosφ-P', 1026: 'Grid regulation: curve Q-U',
  1280: 'Terminal test ready', 1281: 'Terminal test',
  1536: 'Insulation check', 1792: 'AFCI check', 2048: 'I-V scan', 2304: 'DC check',
  40960: 'Standby: no irradiance', 45056: 'Communication lost - SmartLogger', 49152: 'Loading - SmartLogger'
};

export function withStateLabels(values: MetricMap): MetricMap {
  const result: Record<string, MetricValue> = { ...values };
  for (const key of ['real_health_state', 'inverter_state', 'run_state', 'meter_status']) {
    const value = values[key];
    if (typeof value !== 'number') {
      continue;
    }
    let label: string | undefined;
    if (key === 'inverter_state') {
      label = inverterStates[value];
    } else if (key === 'real_health_state') {
      label = ({ 1: 'Disconnected', 2: 'Fault', 3: 'Healthy' } as Readonly<Record<number, string>>)[value];
    } else {
      label = ({ 0: 'Disconnected', 1: 'Connected' } as Readonly<Record<number, string>>)[value];
    }
    result[`${key}_text`] = label ?? `Unknown state: ${value}`;
  }
  return result;
}

export { productionWatts } from './power.js';
