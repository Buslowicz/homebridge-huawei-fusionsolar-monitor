import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import v1Api from '../node_modules/homebridge-v1/lib/api.js';
import { HuaweiFusionSolarPlatform, PLATFORM_NAME } from '../dist/platform.js';
import { METRIC_SERVICE_SEED } from '../dist/accessory.js';
import { POWER_SERVICE_UUID, POWER_CHARACTERISTIC_UUID } from '../dist/power-meter.js';
import { DemoApi } from '../dist/demo.js';

function harness(Api = HomebridgeAPI, config = {}, client = new DemoApi(), now = Date.now) {
  const api = new Api();
  const registered = [];
  const removed = [];
  api.on('registerPlatformAccessories', (items) => registered.push(...items));
  api.on('unregisterPlatformAccessories', (items) => removed.push(...items));
  const log = () => {};
  for (const level of ['info', 'warn', 'error', 'debug', 'success']) log[level] = log;
  const platform = new HuaweiFusionSolarPlatform(log, { platform: PLATFORM_NAME, demo: true, writeSnapshot: false, gridPowerDirection: 'positiveImport', ...config }, api, { client, now });
  return { api, platform, registered, removed };
}
const power = (accessory, key) => accessory?.services.find((s) => s.UUID === POWER_SERVICE_UUID && s.subtype === `power-${key}`)?.characteristics.find((c) => c.UUID === POWER_CHARACTERISTIC_UUID);
const find = (accessory, label) => accessory.services.flatMap((s) => s.characteristics).find((c) => c.displayName === label);
const source = (accessories, kind, id) => accessories.find((a) => a.context.kind === kind && (id === undefined || a.context.sourceId === id));

for (const [version, Api] of [['2.5.0', HomebridgeAPI], ['1.11.4', v1Api.HomebridgeAPI]]) {
  test(`Homebridge ${version} default exposes only automation power, two status sensors and a compact alarm count`, async () => {
    const h = harness(Api);
    try {
      await h.platform.pollOnce();
      assert.equal(h.registered.length, 4);
      const inverter = source(h.registered, 'device', '1001');
      const meter = source(h.registered, 'device', '1002');
      const plant = source(h.registered, 'plant');
      const alarms = source(h.registered, 'alarms');
      assert.equal(inverter.services.length - 1, 2);
      assert.equal(meter.services.length - 1, 3);
      assert.equal(plant.services.length - 1, 2);
      assert.equal(alarms.services.length - 1, 1);
      for (const [accessory, key, watts] of [[inverter, 'production', 3900], [plant, 'consumption', 2800], [meter, 'import', 0], [meter, 'export', 1100]]) {
        const reading = power(accessory, key);
        assert.equal(await reading.handleGetRequest(), watts);
        assert.deepEqual(reading.props.perms.sort(), ['ev', 'pr']);
      }
      assert.equal(await power(meter, 'grid').handleGetRequest(), -1100);
      assert.equal(await find(alarms, 'Active alarms').handleGetRequest(), 0);
      assert.equal(alarms.services[1].displayName, 'Huawei Active Alarms');
      const native = (a, subtype) => a.getServiceById(h.api.hap.Service.ContactSensor, subtype).getCharacteristic(h.api.hap.Characteristic.ContactSensorState);
      assert.equal(await native(inverter, 'production').handleGetRequest(), 1);
      assert.equal(await native(plant, 'health').handleGetRequest(), 0);
      for (const accessory of h.registered) {
        assert.equal(accessory.getService(h.api.hap.Service.TemperatureSensor), undefined);
        for (const label of ['API received at', 'Production today [kWh]', 'Active power [kW]', 'Device connection - code', 'PV1 voltage [V]', 'Alarm 1 - name', 'Alarms critical']) {
          assert.equal(find(accessory, label), undefined);
        }
      }
    } finally { h.platform.stop(); }
  });

  test(`Homebridge ${version} prunes cached diagnostics while preserving retained service identities and alarm count`, async () => {
    const client = new DemoApi();
    const baseList = client.listDevices.bind(client);
    const baseRead = client.deviceKpis.bind(client);
    client.listDevices = async () => [...await baseList(), { id: '1003', stationCode: 'DEMO', name: 'Diagnostic EMI', typeId: 10, serial: 'EMI', model: 'EMI', softwareVersion: 'demo' }];
    const calls = [];
    client.deviceKpis = async (type, ids) => {
      calls.push(type);
      return type === 10 ? [{ id: '1003', values: { pv_temperature: 31 } }] : baseRead(type, ids);
    };
    client.activeAlarms = async () => [{ stationCode: 'DEMO', serial: '', name: 'Test', id: 1, severity: 2, raisedAt: 1, cause: 'cause', suggestion: 'suggestion' }];
    const advanced = harness(Api, { advancedTelemetry: true }, client);
    let minimal;
    try {
      await advanced.platform.pollOnce();
      assert.equal(advanced.registered.length, 5);
      assert.ok(calls.includes(10));
      const ids = new Map(advanced.registered.map((a) => [a.UUID, a.services.filter((s) => s.UUID === POWER_SERVICE_UUID || s.UUID === advanced.api.hap.Service.ContactSensor.UUID || s.characteristics.some((c) => c.displayName === 'Active alarms')).map((s) => s.getServiceId())]));
      const restored = advanced.registered.map((a) => advanced.api.platformAccessory.deserialize(advanced.api.platformAccessory.serialize(a)));
      advanced.platform.stop();
      calls.length = 0;
      minimal = harness(Api, {}, client);
      for (const accessory of restored) minimal.platform.configureAccessory(accessory);
      for (const accessory of restored) {
        assert.equal(find(accessory, 'PV1 voltage [V]'), undefined);
        assert.equal(find(accessory, 'Alarm 1 - name'), undefined);
        assert.equal(accessory.getService(minimal.api.hap.Service.TemperatureSensor), undefined);
      }
      const count = find(source(restored, 'alarms'), 'Active alarms');
      await assert.rejects(count.handleGetRequest(), 'cached count is unavailable until refreshed');
      await minimal.platform.pollOnce();
      assert.deepEqual(calls.sort(), [38, 47]);
      assert.equal(minimal.registered.length, 0, 'remaining accessories are reused');
      assert.deepEqual(minimal.removed.map((a) => a.context.sourceId), ['1003']);
      for (const accessory of restored.filter((a) => a.context.sourceId !== '1003')) {
        assert.deepEqual(accessory.services.filter((s) => s.UUID === POWER_SERVICE_UUID || s.UUID === minimal.api.hap.Service.ContactSensor.UUID || s.characteristics.some((c) => c.displayName === 'Active alarms')).map((s) => s.getServiceId()), ids.get(accessory.UUID));
        const generic = accessory.services.filter((s) => s.UUID === minimal.api.hap.uuid.generate(METRIC_SERVICE_SEED));
        assert.equal(generic.length, accessory.context.kind === 'alarms' ? 1 : 0);
        if (generic.length) assert.deepEqual(generic[0].characteristics.filter((c) => ![minimal.api.hap.Characteristic.Name.UUID, minimal.api.hap.Characteristic.StatusFault.UUID].includes(c.UUID)).map((c) => c.displayName), ['Active alarms']);
      }
      assert.equal(await count.handleGetRequest(), 1);
    } finally { advanced.platform.stop(); minimal?.platform.stop(); }
  });
}

test('unknown direction keeps one signed meter and hides unconfigured derived power', async () => {
  const h = harness(HomebridgeAPI, { gridPowerDirection: 'unconfigured' });
  try {
    await h.platform.pollOnce();
    const meter = source(h.registered, 'device', '1002');
    assert.equal(meter.services.length - 1, 1);
    assert.equal(await power(meter, 'grid').handleGetRequest(), -1100);
    assert.equal(power(meter, 'import'), undefined);
    assert.equal(power(source(h.registered, 'plant'), 'consumption'), undefined);
  } finally { h.platform.stop(); }
});

test('minimal alarm count preserves real empty, active and unavailable states without exposing detail', async () => {
  let now = 1_700_000_000_000;
  const client = new DemoApi();
  let fail = false;
  let active = false;
  client.activeAlarms = async () => {
    if (fail) throw new Error('network');
    return active ? [{ stationCode: 'DEMO', serial: '', name: 'Private details', id: 1, severity: 1, raisedAt: 1, cause: 'cause', suggestion: 'suggestion' }] : [];
  };
  const h = harness(HomebridgeAPI, {}, client, () => now);
  try {
    await h.platform.pollOnce();
    const alarms = source(h.registered, 'alarms');
    const count = find(alarms, 'Active alarms');
    assert.equal(await count.handleGetRequest(), 0);
    active = true;
    now += 1_800_000;
    await h.platform.pollOnce();
    assert.equal(await count.handleGetRequest(), 1);
    assert.equal(find(alarms, 'Alarm 1 - name'), undefined);
    fail = true;
    now += 1_800_000;
    await h.platform.pollOnce();
    await assert.rejects(count.handleGetRequest());
  } finally { h.platform.stop(); }
});

test('minimal mode honors disabled features without creating empty accessories', async () => {
  const h = harness(HomebridgeAPI, { powerMeters: false, alarms: false, statusSensors: false });
  try {
    await h.platform.pollOnce();
    assert.equal(h.registered.length, 0);
  } finally { h.platform.stop(); }
  const status = harness(HomebridgeAPI, { powerMeters: false, alarms: false });
  try {
    await status.platform.pollOnce();
    assert.deepEqual(status.registered.map((a) => a.context.sourceId), ['DEMO', '1001']);
    assert.ok(status.registered.every((a) => a.services.length === 2));
  } finally { status.platform.stop(); }
});

test('minimal mode selects the configured grid meter and still detects storage without polling its diagnostics', async () => {
  const client = new DemoApi();
  const list = client.listDevices.bind(client);
  const read = client.deviceKpis.bind(client);
  client.listDevices = async () => [...await list(), ...[17, 39].map((typeId) => ({ id: String(typeId), stationCode: 'DEMO', name: 'Extra', typeId, serial: '', model: '', softwareVersion: '' }))];
  const calls = [];
  client.deviceKpis = async (type, ids) => { calls.push(type); return type === 17 ? [] : read(type, ids); };
  const h = harness(HomebridgeAPI, { gridMeterId: '1002' }, client);
  try {
    await h.platform.pollOnce();
    assert.ok(!h.registered.some((a) => ['17', '39'].includes(a.context.sourceId)));
    assert.ok(!calls.includes(39));
    await assert.rejects(power(source(h.registered, 'plant'), 'consumption').handleGetRequest(), 'storage discovery prevents unsafe household calculation');
    assert.equal(await power(source(h.registered, 'device', '1001'), 'production').handleGetRequest(), 3900);
  } finally { h.platform.stop(); }
});
