import type { MetricMap, MetricValue } from './contracts.js';

export interface MetricDescription {
  readonly label: string;
  readonly unit?: string;
  readonly numeric: boolean;
}

const common: Readonly<Record<string, readonly [string, string?]>> = {
  day_power: ['Produkcja dzisiaj', 'kWh'], month_power: ['Produkcja w miesiącu', 'kWh'],
  total_power: ['Produkcja łącznie', 'kWh'], day_income: ['Przychód dzisiaj'], total_income: ['Przychód łącznie'],
  day_on_grid_energy: ['Oddano do sieci dzisiaj', 'kWh'], day_use_energy: ['Zużycie dzisiaj', 'kWh'],
  real_health_state: ['Stan instalacji - kod'], inverter_state: ['Stan falownika - kod'],
  run_state: ['Połączenie urządzenia - kod'], meter_status: ['Stan licznika - kod'],
  efficiency: ['Sprawność falownika', '%'], temperature: ['Temperatura wewnętrzna', '°C'],
  power_factor: ['Współczynnik mocy'], elec_freq: ['Częstotliwość sieci', 'Hz'],
  grid_frequency: ['Częstotliwość sieci', 'Hz'], day_cap: ['Produkcja dzisiaj', 'kWh'],
  total_cap: ['Produkcja łącznie', 'kWh'], mppt_power: ['Moc wejściowa MPPT', 'kW'],
  mppt_total_cap: ['Energia wejściowa DC łącznie', 'kWh'],
  open_time: ['Czas uruchomienia - Unix', 'ms'], close_time: ['Czas wyłączenia - Unix', 'ms'],
  active_cap: ['Energia czynna dodatnia', 'kWh'], reverse_active_cap: ['Energia czynna ujemna', 'kWh'],
  forward_reactive_cap: ['Energia bierna dodatnia', 'kvarh'], reverse_reactive_cap: ['Energia bierna ujemna', 'kvarh'],
  total_apparent_power: ['Moc pozorna', 'kVA'], meter_u: ['Napięcie fazy A', 'V'], meter_i: ['Prąd fazy A', 'A'],
  battery_soc: ['Naładowanie magazynu', '%'], battery_soh: ['Kondycja magazynu', '%'],
  ch_discharge_power: ['Moc ładowania i rozładowania', 'W'], busbar_u: ['Napięcie magazynu', 'V'],
  max_charge_power: ['Maksymalna moc ładowania', 'W'], max_discharge_power: ['Maksymalna moc rozładowania', 'W'],
  pv_temperature: ['Temperatura paneli', '°C'], wind_speed: ['Prędkość wiatru', 'm/s'],
  wind_direction: ['Kierunek wiatru', '°'], radiant_total: ['Napromienienie dzisiaj', 'MJ/m²'],
  radiant_line: ['Natężenie promieniowania', 'W/m²']
};

export function describeMetric(key: string, typeId: number | 'plant', value: MetricValue): MetricDescription {
  if (key === 'api_received_at') {
    return { label: 'Dane odebrano z API', numeric: false };
  }
  if (key.endsWith('_text')) {
    const source = common[key.slice(0, -5)];
    if (source) {
      return { label: source[0].replace(' - kod', ' - opis'), numeric: false };
    }
  }
  if (key === 'alarm_count') {
    return { label: 'Liczba aktywnych alarmów', numeric: true };
  }
  const alarmLevel = /^alarm_count_level_([1-4])$/u.exec(key);
  if (alarmLevel) {
    const levels: Readonly<Record<string, string>> = { '1': 'krytyczne', '2': 'poważne', '3': 'drobne', '4': 'ostrzeżenia' };
    return { label: `Alarmy ${levels[alarmLevel[1] ?? '']}`, numeric: true };
  }
  const alarmField = /^alarm_(\d+)_(name|id|severity|raised_at|cause|suggestion)$/u.exec(key);
  if (alarmField) {
    const fields: Readonly<Record<string, string>> = { name: 'nazwa', id: 'kod', severity: 'ważność 1 do 4', raised_at: 'czas zgłoszenia', cause: 'przyczyna', suggestion: 'zalecenie' };
    return { label: `Alarm ${alarmField[1]} - ${fields[alarmField[2] ?? '']}`, numeric: alarmField[2] === 'id' || alarmField[2] === 'severity' };
  }
  const entry = common[key];
  if (entry) {
    // The same Huawei key uses different units depending on device type.
    const unit = typeId === 47 && ['forward_reactive_cap', 'reverse_reactive_cap'].includes(key) ? 'kWh' : entry[1];
    return { label: entry[0], ...(unit ? { unit } : {}), numeric: true };
  }
  if (key === 'active_power') {
    return { label: 'Moc czynna', unit: typeId === 17 || typeId === 47 ? 'W' : 'kW', numeric: true };
  }
  if (key === 'reactive_power') {
    return { label: 'Moc bierna', unit: typeId === 17 || typeId === 47 ? 'var' : 'kvar', numeric: true };
  }
  const phase = /^([abc])_([ui])$/u.exec(key);
  if (phase) {
    return { label: `${phase[2] === 'u' ? 'Napięcie' : 'Prąd'} fazy ${phase[1]?.toUpperCase()}`, unit: phase[2] === 'u' ? 'V' : 'A', numeric: true };
  }
  if (/^(ab|bc|ca)_u$/u.test(key)) {
    return { label: `Napięcie międzyfazowe ${key.slice(0, 2).toUpperCase()}`, unit: 'V', numeric: true };
  }
  const pv = /^pv(\d+)_([ui])$/u.exec(key);
  if (pv) {
    return { label: `PV${pv[1]} ${pv[2] === 'u' ? 'napięcie' : 'prąd'}`, unit: pv[2] === 'u' ? 'V' : 'A', numeric: true };
  }
  const mppt = /^mppt_(\d+)_cap$/u.exec(key);
  if (mppt) {
    return { label: `MPPT ${mppt[1]} energia DC`, unit: 'kWh', numeric: true };
  }
  if (/^active_power_[abc]$/u.test(key)) {
    return { label: `Moc czynna fazy ${key.slice(-1).toUpperCase()}`, unit: typeId === 17 || typeId === 47 ? 'W' : 'kW', numeric: true };
  }
  if (/^reactive_power_[abc]$/u.test(key)) {
    return { label: `Moc bierna fazy ${key.slice(-1).toUpperCase()}`, unit: 'kvar', numeric: true };
  }
  return { label: key.replaceAll('_', ' '), numeric: typeof value === 'number' };
}

const inverterStates: Readonly<Record<number, string>> = {
  0: 'Oczekiwanie: inicjalizacja', 1: 'Oczekiwanie: test izolacji', 2: 'Oczekiwanie: nasłonecznienie',
  3: 'Oczekiwanie: sieć', 7: 'Inicjalizacja po przechowywaniu', 256: 'Uruchamianie',
  512: 'Praca z siecią', 513: 'Praca z ograniczeniem mocy', 514: 'Praca z redukcją mocy',
  768: 'Wyłączenie: usterka', 769: 'Wyłączenie: polecenie', 770: 'Wyłączenie: OVGR',
  771: 'Wyłączenie: komunikacja', 772: 'Wyłączenie: ograniczenie mocy',
  773: 'Wymagane ręczne uruchomienie', 774: 'Wyłączenie: przełączniki DC',
  1025: 'Regulacja sieci: krzywa cosφ-P', 1026: 'Regulacja sieci: krzywa Q-U',
  1280: 'Gotowość do testu terminala', 1281: 'Test terminala',
  1536: 'Kontrola izolacji', 1792: 'Kontrola AFCI', 2048: 'Skanowanie I-V', 2304: 'Kontrola DC',
  40960: 'Oczekiwanie: brak nasłonecznienia', 45056: 'Brak komunikacji - SmartLogger', 49152: 'Ładowanie - SmartLogger'
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
      label = ({ 1: 'Rozłączona', 2: 'Usterka', 3: 'Sprawna' } as Readonly<Record<number, string>>)[value];
    } else {
      label = ({ 0: 'Rozłączone', 1: 'Połączone' } as Readonly<Record<number, string>>)[value];
    }
    result[`${key}_text`] = label ?? `Nieznany stan: ${value}`;
  }
  return result;
}

/** Huawei meter sign depends on the installation: never infer household load or import/export here. */
export function productionWatts(values: MetricMap, typeId: number): number | undefined {
  const power = values.active_power;
  return (typeId === 1 || typeId === 38) && typeof power === 'number' ? power * 1000 : undefined;
}
