import type { Alarm, Device, FusionSolarApi, KpiRecord, Plant } from './contracts.js';

/** Synthetic data only. Demo mode never constructs the cloud client. */
export class DemoApi implements FusionSolarApi {
  listPlants(): Promise<readonly Plant[]> {
    return Promise.resolve([{ code: 'DEMO', name: 'Huawei Demo', capacityKwP: 10 }]);
  }

  listDevices(): Promise<readonly Device[]> {
    return Promise.resolve([
      { id: '1001', stationCode: 'DEMO', name: 'Demo inverter', typeId: 38, serial: 'DEMO-INVERTER', model: 'SUN2000-10KTL-M1-HC DEMO', softwareVersion: 'demo' },
      { id: '1002', stationCode: 'DEMO', name: 'Demo meter', typeId: 47, serial: 'DEMO-METER', model: 'Power sensor DEMO', softwareVersion: 'demo' }
    ]);
  }

  plantKpis(): Promise<readonly KpiRecord[]> {
    return Promise.resolve([{ id: 'DEMO', values: { real_health_state: 3, day_power: 18.4, month_power: 224.6, total_power: 14560.49, day_use_energy: 9.4, day_on_grid_energy: 6.2 } }]);
  }

  deviceKpis(typeId: number): Promise<readonly KpiRecord[]> {
    return Promise.resolve(typeId === 38 ? [{ id: '1001', values: {
      inverter_state: 512, run_state: 1, active_power: 3.9, reactive_power: 0.02, mppt_power: 4.02,
      day_cap: 18.4, total_cap: 14560.49, temperature: 42.1, efficiency: 97.1, power_factor: 0.999,
      elec_freq: 50.01, a_u: 232.2, b_u: 231.8, c_u: 232.4, a_i: 5.6, b_i: 5.6, c_i: 5.6,
      ab_u: 402.1, bc_u: 401.9, ca_u: 402.4, pv1_u: 420.3, pv2_u: 419.8, pv1_i: 4.8, pv2_i: 4.7,
      pv3_u: null, pv3_i: null, mppt_1_cap: 7310.2, mppt_2_cap: 7520.4
    } }] : [{ id: '1002', values: {
      meter_status: 1, run_state: 1, active_power: -1100, reactive_power: 20,
      active_power_a: -350, active_power_b: -370, active_power_c: -380,
      meter_u: 232.2, meter_i: 1.51, b_u: 231.8, c_u: 232.4, b_i: 1.6, c_i: 1.64,
      power_factor: 0.999, active_cap: 8400.2, reverse_active_cap: 6500.8, grid_frequency: 50.01,
      forward_reactive_cap: null
    } }]);
  }

  activeAlarms(): Promise<readonly Alarm[]> {
    return Promise.resolve([]);
  }

  close(): void { /* No resources or network sessions. */ }
}
