import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import v1Api from '../node_modules/homebridge-v1/lib/api.js';
import { PowerMeters, POWER_SERVICE_UUID, POWER_CHARACTERISTIC_UUID } from '../dist/power-meter.js';
import { homeConsumptionWatts } from '../dist/power.js';
import { TelemetryAccessory } from '../dist/accessory.js';
import { DemoApi } from '../dist/demo.js';
import { HuaweiFusionSolarPlatform, PLATFORM_NAME, PLUGIN_NAME } from '../dist/platform.js';

const options = { powerMeters: true, gridPowerDirection: 'positiveImport', advancedTelemetry: true };
const device = (id, typeId, stationCode = 'P1') => ({ id, typeId, stationCode, name: id, serial: id, model: '', softwareVersion: '' });
const devices = [device('1', 38), device('2', 47)];
const samples = (pv, grid) => new Map([['1', { active_power: pv, run_state: 1 }], ['2', { active_power: grid, meter_status: 1 }]]);
const settings = { gridPowerDirection: 'positiveImport', gridMeterId: undefined };
const reading = (accessory, subtype) => accessory.services.find((s) => s.UUID === POWER_SERVICE_UUID && s.subtype === `power-${subtype}`)?.characteristics.find((c) => c.UUID === POWER_CHARACTERISTIC_UUID);

test('household estimate accounts for bidirectional grid power, both signs, night and genuine zero', () => {
  assert.equal(homeConsumptionWatts(devices, samples(3.9, -1100), settings), 2800);
  assert.equal(homeConsumptionWatts(devices, samples(3.9, -1100), { ...settings, gridPowerDirection: 'positiveExport' }), 5000);
  assert.equal(homeConsumptionWatts(devices, samples(0, 1500), settings), 1500);
  assert.equal(homeConsumptionWatts(devices, samples(0, 0), settings), 0);
  const multiple = [...devices, device('3', 1)];
  assert.equal(homeConsumptionWatts(multiple, new Map([...samples(3.9, -1100), ['3', { active_power: 1.1 }]]), settings), 3900);
  assert.equal(homeConsumptionWatts(multiple, samples(3.9, -1100), settings), undefined);
});

test('unconfirmed topology, ambiguous meters, batteries and invalid source data never fabricate consumption', () => {
  assert.equal(homeConsumptionWatts(devices, samples(3.9, -1100), { ...settings, gridPowerDirection: 'unconfigured' }), undefined);
  for (const typeId of [39, 41]) assert.equal(homeConsumptionWatts([...devices, device('3', typeId)], samples(3.9, -1100), settings), undefined);
  const ambiguous = [...devices, device('3', 17)];
  assert.equal(homeConsumptionWatts(ambiguous, samples(3.9, -1100), settings), undefined);
  assert.equal(homeConsumptionWatts(ambiguous, samples(3.9, -1100), { ...settings, gridMeterId: '2' }), 2800);
  assert.equal(homeConsumptionWatts(devices, samples(3.9, -1100), { ...settings, gridMeterId: 'missing' }), undefined);
  assert.equal(homeConsumptionWatts([], samples(3.9, -1100), settings), undefined);
  assert.equal(homeConsumptionWatts([devices[1]], samples(3.9, -1100), settings), undefined);
  for (const value of [undefined, null, NaN, Infinity, '3.9', Number.MAX_SAFE_INTEGER]) {
    assert.equal(homeConsumptionWatts(devices, samples(value, -1100), settings), undefined);
  }
  for (const values of [{ active_power: 500, run_state: 0 }, { active_power: 500, meter_status: 0 }, {}, { active_power: null }]) {
    assert.equal(homeConsumptionWatts(devices, new Map([...samples(3.9, -1100), ['2', values]]), settings), undefined);
  }
  assert.equal(homeConsumptionWatts(devices, samples(0, -1100), settings), undefined, 'negative estimates are unavailable, not clamped');
  assert.equal(homeConsumptionWatts(devices, new Map([['1', { active_power: 3.9 }]]), settings), undefined);
});

for (const [version, Api] of [['2.5.0', HomebridgeAPI], ['1.11.4', v1Api.HomebridgeAPI]]) {
  test(`Homebridge ${version} publishes read-only power meters in watts with import/export and safe restoration`, async () => {
    const api = new Api();
    let now = Date.now();
    const accessory = new api.platformAccessory('Power test', api.hap.uuid.generate(`power-${version}`));
    api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    const meter = new PowerMeters(accessory, api, 47, 600_000, () => now, options);
    const grid = reading(accessory, 'grid');
    await assert.rejects(grid.handleGetRequest());
    meter.update({ active_power: -1100.125, meter_status: 1 }, now);
    assert.equal(await grid.handleGetRequest(), -1100.125);
    assert.equal(grid.props.unit, 'W');
    assert.deepEqual(grid.props.perms.sort(), ['ev', 'pr']);
    assert.equal(await reading(accessory, 'import').handleGetRequest(), 0);
    assert.equal(await reading(accessory, 'export').handleGetRequest(), 1100.125);
    const restored = api.platformAccessory.deserialize(api.platformAccessory.serialize(accessory));
    meter.close();
    const second = new PowerMeters(restored, api, 47, 600_000, () => now, options);
    assert.deepEqual(restored.services.map((s) => s.getServiceId()), accessory.services.map((s) => s.getServiceId()));
    await assert.rejects(reading(restored, 'grid').handleGetRequest());
    second.update({ active_power: 1234.5 }, now);
    assert.equal(await reading(restored, 'import').handleGetRequest(), 1234.5);
    assert.equal(await reading(restored, 'export').handleGetRequest(), 0);
    now += 600_001;
    await assert.rejects(reading(restored, 'import').handleGetRequest());
    second.update({ active_power: 1234.5, run_state: 0 }, now);
    await assert.rejects(reading(restored, 'grid').handleGetRequest());
    assert.equal(restored.services.find((s) => s.subtype === 'power-grid').getCharacteristic(api.hap.Characteristic.StatusFault).value, 1);
    second.close();
    const disabled = new PowerMeters(restored, api, 47, 600_000, () => now, { ...options, powerMeters: false });
    assert.ok(restored.services.every((s) => s.UUID !== POWER_SERVICE_UUID));
    disabled.close();
  });

  test(`Homebridge ${version} converts inverter kW precisely and migrates English labels without changing identities`, async () => {
    const api = new Api();
    const accessory = new api.platformAccessory('My inverter', api.hap.uuid.generate('english-migration'));
    api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    const first = new TelemetryAccessory(accessory, api, 38, 600_000, true, undefined, options);
    first.update({ active_power: 3.900125, temperature: 42 }, Date.now());
    assert.equal(await reading(accessory, 'production').handleGetRequest(), 3900.125);
    const uuid = first.metricUuid('active_power');
    const metricService = accessory.services.find((s) => s.characteristics.some((c) => c.UUID === uuid));
    metricService.getCharacteristic(api.hap.Characteristic.Name).updateValue('Huawei pomiary 1');
    metricService.characteristics.find((c) => c.UUID === uuid).displayName = 'Moc czynna [kW]';
    const restored = api.platformAccessory.deserialize(api.platformAccessory.serialize(accessory));
    const ids = accessory.services.map((s) => s.getServiceId());
    first.close();
    const second = new TelemetryAccessory(restored, api, 38, 600_000, true, undefined, options);
    second.update({ active_power: 3.9, temperature: 42 }, Date.now());
    assert.equal(restored.displayName, 'My inverter');
    assert.deepEqual(restored.services.map((s) => s.getServiceId()), ids);
    assert.equal(restored.services.flatMap((s) => s.characteristics).find((c) => c.UUID === uuid).displayName, 'Active power [kW]');
    assert.ok(restored.services.some((s) => s.displayName.startsWith('Huawei metrics')));
    assert.equal(restored.getServiceById(api.hap.Service.ContactSensor, 'production').displayName, 'Huawei PV Production');
    second.close();
  });
}

function harness(config = {}, client = new DemoApi()) {
  const api = new HomebridgeAPI();
  const accessories = [];
  const log = () => {};
  for (const level of ['info', 'warn', 'error', 'debug', 'success']) log[level] = log;
  api.on('registerPlatformAccessories', (items) => accessories.push(...items));
  const platform = new HuaweiFusionSolarPlatform(log, { platform: PLATFORM_NAME, demo: true, writeSnapshot: false, gridPowerDirection: 'positiveImport', ...config }, api, { client });
  return { api, platform, accessories };
}

test('platform derives household power only from this cycle and propagates failures, omissions and disconnections', async () => {
  const client = new DemoApi();
  const original = client.deviceKpis.bind(client);
  let failedType;
  let emptyType;
  let offlineType;
  client.deviceKpis = async (type, ids) => {
    if (type === failedType) throw new Error('network');
    if (type === emptyType) return [];
    const records = await original(type, ids);
    return type === offlineType ? records.map((r) => ({ ...r, values: { ...r.values, run_state: 0 } })) : records;
  };
  const h = harness({}, client);
  try {
    await h.platform.pollOnce();
    const plant = h.accessories.find((a) => a.context.kind === 'plant');
    const consumption = reading(plant, 'consumption');
    assert.equal(await consumption.handleGetRequest(), 2800);
    assert.ok(!reading(h.accessories.find((a) => a.context.kind === 'alarms'), 'consumption'));
    for (const type of [38, 47]) {
      failedType = type;
      await h.platform.pollOnce();
      await assert.rejects(consumption.handleGetRequest());
      failedType = undefined;
      await h.platform.pollOnce();
      assert.equal(await consumption.handleGetRequest(), 2800);
      emptyType = type;
      await h.platform.pollOnce();
      await assert.rejects(consumption.handleGetRequest());
      emptyType = undefined;
      offlineType = type;
      await h.platform.pollOnce();
      await assert.rejects(consumption.handleGetRequest());
      offlineType = undefined;
    }
    client.plantKpis = async () => [{ id: 'DEMO', values: { real_health_state: 1 } }];
    await h.platform.pollOnce();
    await assert.rejects(consumption.handleGetRequest());
    client.plantKpis = async () => { throw new Error('network'); };
    await h.platform.pollOnce();
    await assert.rejects(consumption.handleGetRequest());
  } finally { h.platform.stop(); }
});

test('selected meter survives platform cache restoration; household reads do not depend on daily KPI freshness', async () => {
  const h = harness({ gridMeterId: '1002' });
  let second;
  try {
    await h.platform.pollOnce();
    const restored = h.accessories.map((a) => h.api.platformAccessory.deserialize(h.api.platformAccessory.serialize(a)));
    h.platform.stop();
    second = harness({ gridMeterId: '1002' });
    for (const accessory of restored) second.platform.configureAccessory(accessory);
    const plant = restored.find((a) => a.context.kind === 'plant');
    await assert.rejects(reading(plant, 'consumption').handleGetRequest());
    await second.platform.pollOnce();
    assert.equal(await reading(plant, 'consumption').handleGetRequest(), 2800);
    assert.equal(await reading(restored.find((a) => a.context.typeId === 47), 'export').handleGetRequest(), 1100);
  } finally { h.platform.stop(); second?.platform.stop(); }
});

test('home power has independent expiry and rejects stale estimates without a new poll', async () => {
  const api = new HomebridgeAPI();
  const accessory = new api.platformAccessory('Home', api.hap.uuid.generate('home-expiry'));
  const wrapper = new TelemetryAccessory(accessory, api, 'plant', 10, false, Date.now, options);
  try {
    wrapper.updateHomeConsumption(2800, Date.now());
    assert.equal(await reading(accessory, 'consumption').handleGetRequest(), 2800);
    await new Promise((resolve) => setTimeout(resolve, 30));
    wrapper.update({ real_health_state: 3, day_power: 18.4 }, Date.now());
    await assert.rejects(reading(accessory, 'consumption').handleGetRequest());
    wrapper.updateHomeConsumption(2800, Date.now() - 11);
    await assert.rejects(reading(accessory, 'consumption').handleGetRequest());
  } finally { wrapper.close(); }
});

test('unknown direction exposes signed grid power and PV but no invented household/import/export service', async () => {
  const h = harness({ gridPowerDirection: 'unconfigured' });
  try {
    await h.platform.pollOnce();
    const plant = h.accessories.find((a) => a.context.kind === 'plant');
    const meter = h.accessories.find((a) => a.context.typeId === 47);
    assert.equal(reading(plant, 'consumption'), undefined);
    assert.equal(reading(meter, 'import'), undefined);
    assert.equal(reading(meter, 'export'), undefined);
    assert.equal(await reading(meter, 'grid').handleGetRequest(), -1100);
    assert.equal(await reading(h.accessories.find((a) => a.context.typeId === 38), 'production').handleGetRequest(), 3900);
  } finally { h.platform.stop(); }
  const disabled = harness({ powerMeters: false });
  try {
    await disabled.platform.pollOnce();
    assert.ok(disabled.accessories.every((a) => a.services.every((s) => s.UUID !== POWER_SERVICE_UUID)));
  } finally { disabled.platform.stop(); }
});

test('platform keeps power estimates isolated between plants and refuses ambiguous meters or attached storage', async () => {
  const client = new DemoApi();
  client.listPlants = async () => [{ code: 'P1', name: 'One' }, { code: 'P2', name: 'Two' }];
  client.listDevices = async () => [device('1', 38), device('2', 47), device('3', 38, 'P2'), device('4', 47, 'P2')];
  client.plantKpis = async () => ['P1', 'P2'].map((id) => ({ id, values: { real_health_state: 3 } }));
  client.deviceKpis = async (type) => type === 38
    ? [{ id: '1', values: { active_power: 3.9 } }, { id: '3', values: { active_power: 1 } }]
    : [{ id: '2', values: { active_power: -1100 } }, { id: '4', values: { active_power: 500 } }];
  const h = harness({}, client);
  try {
    await h.platform.pollOnce();
    for (const [id, watts] of [['P1', 2800], ['P2', 1500]]) {
      const plant = h.accessories.find((a) => a.context.kind === 'plant' && a.context.sourceId === id);
      assert.equal(await reading(plant, 'consumption').handleGetRequest(), watts);
    }
  } finally { h.platform.stop(); }
  for (const typeId of [17, 39, 41]) {
    const base = new DemoApi();
    const original = base.listDevices.bind(base);
    base.listDevices = async () => [...await original(), device('1003', typeId, 'DEMO')];
    const scenario = harness({}, base);
    try {
      await scenario.platform.pollOnce();
      const plant = scenario.accessories.find((a) => a.context.kind === 'plant');
      await assert.rejects(reading(plant, 'consumption').handleGetRequest());
    } finally { scenario.platform.stop(); }
  }
});
