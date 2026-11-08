import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import v1Api from '../node_modules/homebridge-v1/lib/api.js';
import { PowerMeters, POWER_SERVICE_UUID, POWER_CHARACTERISTIC_UUID } from '../dist/power-meter.js';
import { homeConsumptionWatts } from '../dist/power.js';

const meterReading = (a, key) => a.services.find((s) => s.UUID === POWER_SERVICE_UUID && s.subtype === `power-${key}`)?.characteristics.find((c) => c.UUID === POWER_CHARACTERISTIC_UUID);
for (const [version, Api] of [['2.5.0', HomebridgeAPI], ['1.11.4', v1Api.HomebridgeAPI]]) {
  test(`Homebridge ${version} normalizes negative-import meter power to positive import without double inversion`, async () => {
    const api = new Api();
    const accessory = new api.platformAccessory('Grid sign', api.hap.uuid.generate(`grid-sign-${version}`));
    const meter = new PowerMeters(accessory, api, 47, 600_000, Date.now, { powerMeters: true, advancedTelemetry: true, gridPowerDirection: 'positiveExport' });
    try {
      const input = { active_power: -1100, meter_status: 1 };
      meter.update(input, Date.now());
      assert.equal(await meterReading(accessory, 'grid').handleGetRequest(), 1100);
      assert.equal(await meterReading(accessory, 'import').handleGetRequest(), 1100);
      assert.equal(await meterReading(accessory, 'export').handleGetRequest(), 0);
      assert.equal(input.active_power, -1100, 'raw API data remains unchanged');
      meter.update({ active_power: 2500, meter_status: 1 }, Date.now());
      assert.equal(await meterReading(accessory, 'grid').handleGetRequest(), -2500);
      assert.equal(await meterReading(accessory, 'import').handleGetRequest(), 0);
      assert.equal(await meterReading(accessory, 'export').handleGetRequest(), 2500);
      meter.update({ active_power: 0, meter_status: 1 }, Date.now());
      assert.equal(await meterReading(accessory, 'grid').handleGetRequest(), 0);
      meter.update({ active_power: -1100, meter_status: 0 }, Date.now());
      await assert.rejects(meterReading(accessory, 'grid').handleGetRequest());
    } finally { meter.close(); }
  });
}

test('household consumption uses original meter sign once, not its normalized display value', () => {
  const devices = [{ id: '1', typeId: 38 }, { id: '2', typeId: 47 }];
  const samples = new Map([['1', { active_power: 3.9 }], ['2', { active_power: -1100 }]]);
  assert.equal(homeConsumptionWatts(devices, samples, { gridPowerDirection: 'positiveExport', gridMeterId: undefined }), 5000);
  assert.equal(samples.get('2').active_power, -1100);
});
