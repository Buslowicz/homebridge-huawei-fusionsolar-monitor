import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import v1Api from '../node_modules/homebridge-v1/lib/api.js';
import { TelemetryAccessory, hapText, accessoryName } from '../dist/accessory.js';
import { parseConfig } from '../dist/config.js';
import { describeMetric, withStateLabels, productionWatts } from '../dist/metrics.js';
import { DemoApi } from '../dist/demo.js';
import { ApiError } from '../dist/api-client.js';
import { HuaweiFusionSolarPlatform, PLATFORM_NAME, PLUGIN_NAME } from '../dist/platform.js';
import { writeSnapshot } from '../dist/snapshot.js';
import register from '../dist/index.js';

function logger() {
  const entries = [];
  const log = (...args) => entries.push(args.join(' '));
  for (const level of ['info', 'warn', 'error', 'debug', 'success']) log[level] = log;
  return { log, entries };
}

function harness(Api = HomebridgeAPI, config = {}, dependencies = {}) {
  const api = new Api();
  const registered = [];
  const removed = [];
  api.on('registerPlatformAccessories', (accessories) => registered.push(...accessories));
  api.on('unregisterPlatformAccessories', (accessories) => removed.push(...accessories));
  const { log, entries } = logger();
  const platform = new HuaweiFusionSolarPlatform(log, {
    platform: PLATFORM_NAME, demo: true, writeSnapshot: false, ...config
  }, api, dependencies);
  return { api, platform, registered, removed, entries };
}

function custom(accessory, uuid) {
  return accessory.services.flatMap((service) => service.characteristics).find((characteristic) => characteristic.UUID === uuid);
}

test('configuration requires a real Northbound account and a regional HTTPS endpoint', () => {
  const config = parseConfig({ baseUrl: 'https://eu5.fusionsolar.huawei.com/thirdData/', pollIntervalSeconds: 300 }, {
    FUSIONSOLAR_USERNAME: 'api-user', FUSIONSOLAR_PASSWORD: ' secret '
  });
  assert.equal(config.baseUrl, 'https://eu5.fusionsolar.huawei.com');
  assert.equal(config.password, ' secret ');
  assert.equal(config.alarms, true);
  assert.equal(config.writeSnapshot, true);
  assert.throws(() => parseConfig({ baseUrl: config.baseUrl }, {}), /username/);
  for (const baseUrl of ['http://eu5.fusionsolar.huawei.com', 'https://evil.example', 'https://eu5.fusionsolar.huawei.com.evil.example', 'https://name:secret@eu5.fusionsolar.huawei.com', 'https://eu5.fusionsolar.huawei.com/?token=secret', 'https://eu5.fusionsolar.huawei.com/control', 'https://127.0.0.1']) {
    assert.throws(() => parseConfig({ baseUrl, username: 'api', password: 'secret' }), /HTTPS/);
  }
});

test('invalid polling, flags, duplicate IDs and control characters are rejected', () => {
  for (const config of [
    { pollIntervalSeconds: 299 }, { pollIntervalSeconds: 3601 }, { pollIntervalSeconds: 300.5 },
    { alarms: 'true' }, { statusSensors: 1 }, { writeSnapshot: 'false' },
    { stationCodes: ['NE=1', 'NE=1'] }, { stationCodes: ['NE=1,NE=2'] },
    { stationCodes: [' NE=1'] }, { stationCodes: ['NE=1\n'] }, { stationCodes: 'NE=1' }
  ]) assert.throws(() => parseConfig({ demo: true, ...config }));
  assert.equal(parseConfig({ demo: true }, {}).username, '');
});

test('metric units follow device type rather than a key-only guess', () => {
  assert.equal(describeMetric('active_power', 38, 2).unit, 'kW');
  assert.equal(describeMetric('active_power', 17, 2000).unit, 'W');
  assert.equal(describeMetric('reactive_power', 47, 20).unit, 'var');
  assert.equal(describeMetric('pv2_i', 38, 4).unit, 'A');
  assert.equal(describeMetric('day_use_energy', 'plant', 2).unit, 'kWh');
  assert.equal(describeMetric('new_vendor_metric', 38, 7).unit, undefined);
  assert.equal(productionWatts({ active_power: 2.5 }, 38), 2500);
  assert.equal(productionWatts({ active_power: -2000 }, 47), undefined);
});

test('state decoding preserves the original code and explicitly labels unknown states', () => {
  assert.deepEqual(withStateLabels({ inverter_state: 512, run_state: 1 }), {
    inverter_state: 512, run_state: 1, inverter_state_text: 'Praca z siecią', run_state_text: 'Połączone'
  });
  assert.equal(withStateLabels({ inverter_state: 999 }).inverter_state_text, 'Nieznany stan: 999');
});

test('HomeKit strings use UTF-8 byte limits without breaking Unicode', () => {
  const text = hapText('ą🙂'.repeat(100));
  assert.ok(Buffer.byteLength(text) <= 256);
  assert.ok(!text.includes('\ufffd'));
  assert.equal(hapText('a\n\u0000b'), 'a  b');
  assert.equal(accessoryName('<Huawei> / falownik'), 'Huawei falownik');
});

for (const [version, Api] of [['2.5.0', HomebridgeAPI], ['1.11.4', v1Api.HomebridgeAPI]]) {
  test(`real Homebridge ${version} characteristics remain read-only, unavailable on missing/stale data`, async () => {
    const api = new Api();
    let now = 1_700_000_000_000;
    const accessory = new api.platformAccessory('Test Huawei', api.hap.uuid.generate('telemetry-test'));
    const wrapper = new TelemetryAccessory(accessory, api, 38, 600_000, true, () => now);
    wrapper.update({ active_power: 4.5, temperature: 42.1, pv1_u: null, strange_vendor_field: 7 }, now);
    const power = custom(accessory, wrapper.metricUuid('active_power'));
    assert.equal(await power.handleGetRequest(), 4.5);
    assert.match(power.displayName, /kW/);
    assert.deepEqual(power.props.perms.sort(), ['ev', 'pr']);
    assert.equal(custom(accessory, wrapper.metricUuid('pv1_u')), undefined);
    assert.equal(await custom(accessory, wrapper.metricUuid('strange_vendor_field')).handleGetRequest(), 7);
    assert.equal(await accessory.getService(api.hap.Service.TemperatureSensor).getCharacteristic(api.hap.Characteristic.CurrentTemperature).handleGetRequest(), 42.1);
    const production = accessory.getServiceById(api.hap.Service.ContactSensor, 'production').getCharacteristic(api.hap.Characteristic.ContactSensorState);
    assert.equal(await production.handleGetRequest(), 1);
    wrapper.update({ temperature: 43, active_power: null }, now);
    await assert.rejects(power.handleGetRequest());
    await assert.rejects(production.handleGetRequest());
    wrapper.update({ active_power: 0, temperature: 999 }, now);
    assert.equal(await power.handleGetRequest(), 0);
    await assert.rejects(accessory.getService(api.hap.Service.TemperatureSensor).getCharacteristic(api.hap.Characteristic.CurrentTemperature).handleGetRequest());
    wrapper.update({ active_power: 4.5, run_state: 0 }, now);
    await assert.rejects(power.handleGetRequest());
    await assert.rejects(production.handleGetRequest());
    assert.equal(await custom(accessory, wrapper.metricUuid('run_state')).handleGetRequest(), 0);
    wrapper.update({ active_power: 4.5, run_state: 1 }, now);
    assert.equal(await power.handleGetRequest(), 4.5);
    now += 600_001;
    await assert.rejects(power.handleGetRequest());
    wrapper.close();
  });

  test(`Homebridge ${version} restart preserves UUIDs and blocks cached readings until refreshed`, async () => {
    const api = new Api();
    const accessory = new api.platformAccessory('Cache Huawei', api.hap.uuid.generate('cache-test'));
    api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    const first = new TelemetryAccessory(accessory, api, 47, 600_000, false);
    first.update({ active_power: -1234, active_cap: 12.4 }, Date.now());
    const powerUuid = first.metricUuid('active_power');
    const originalService = accessory.services.find((service) => service.characteristics.some((c) => c.UUID === powerUuid));
    const originalServiceId = originalService.getServiceId();
    const restored = api.platformAccessory.deserialize(api.platformAccessory.serialize(accessory));
    first.close();
    const second = new TelemetryAccessory(restored, api, 47, 600_000, false);
    await assert.rejects(custom(restored, powerUuid).handleGetRequest());
    second.update({ active_power: -2234, active_cap: 12.5, a_new_field: 7 }, Date.now());
    assert.equal(restored.services.find((service) => service.characteristics.some((c) => c.UUID === powerUuid)).getServiceId(), originalServiceId);
    assert.equal(await custom(restored, powerUuid).handleGetRequest(), -2234);
    assert.equal(restored.services.flatMap((s) => s.characteristics).filter((c) => c.UUID === powerUuid).length, 1);
    second.close();
  });

  test(`Homebridge ${version} registers and discovers the demo platform`, async () => {
    const h = harness(Api);
    let registeredName;
    h.api.on('registerPlatform', (name) => { registeredName = name; });
    register(h.api);
    assert.equal(registeredName, PLATFORM_NAME);
    await h.platform.pollOnce();
    assert.equal(h.registered.length, 4);
    assert.deepEqual(new Set(h.registered.map((a) => a.context.kind)), new Set(['plant', 'device', 'alarms']));
    assert.ok(h.registered.every((a) => !JSON.stringify(a.context).includes('password')));
    h.platform.stop();
  });
}

test('polling discovers once, samples every device type and alarms only every 30 minutes', async () => {
  let now = 1_700_000_000_000;
  const base = new DemoApi();
  const calls = [];
  const client = Object.fromEntries(['listPlants', 'listDevices', 'plantKpis', 'deviceKpis', 'activeAlarms', 'close'].map((name) => [name, (...args) => { calls.push([name, args]); return base[name](...args); }]));
  const h = harness(HomebridgeAPI, {}, { client, now: () => now });
  await h.platform.pollOnce();
  now += 301_000;
  await h.platform.pollOnce();
  assert.equal(calls.filter(([name]) => name === 'listPlants').length, 1);
  assert.equal(calls.filter(([name]) => name === 'listDevices').length, 1);
  assert.equal(calls.filter(([name]) => name === 'activeAlarms').length, 1);
  assert.equal(calls.filter(([name]) => name === 'deviceKpis').length, 4);
  now += 1_800_000;
  await h.platform.pollOnce();
  assert.equal(calls.filter(([name]) => name === 'activeAlarms').length, 2);
  h.platform.stop();
});

test('a failed meter source does not replace its readings with zero or break the inverter', async () => {
  let fail = false;
  const client = new DemoApi();
  const original = client.deviceKpis.bind(client);
  client.deviceKpis = (type, ids) => fail && type === 47 ? Promise.reject(new ApiError('permission', 401)) : original(type, ids);
  const h = harness(HomebridgeAPI, {}, { client });
  await h.platform.pollOnce();
  fail = true;
  await h.platform.pollOnce();
  const meter = h.registered.find((a) => a.context.typeId === 47);
  const inverter = h.registered.find((a) => a.context.typeId === 38);
  const meterPower = meter.services.flatMap((s) => s.characteristics).find((c) => c.displayName === 'Moc czynna [W]');
  const inverterPower = inverter.services.flatMap((s) => s.characteristics).find((c) => c.displayName === 'Moc czynna [kW]');
  await assert.rejects(meterPower.handleGetRequest());
  assert.equal(await inverterPower.handleGetRequest(), 3.9);
  assert.ok(h.entries.some((entry) => entry.includes('permission (401)')));
  h.platform.stop();
});

test('active alarms are counted by severity and failure never reports a healthy zero', async () => {
  const client = new DemoApi();
  let fail = false;
  client.activeAlarms = () => fail ? Promise.reject(new ApiError('network')) : Promise.resolve([
    { stationCode: 'DEMO', serial: 'DEMO-INVERTER', name: 'Alarm testowy', id: 2064, severity: 2, raisedAt: 1_700_000_000_000, cause: 'Przyczyna', suggestion: 'Zalecenie' }
  ]);
  let now = 1_700_000_000_000;
  const h = harness(HomebridgeAPI, {}, { client, now: () => now });
  await h.platform.pollOnce();
  const alarmAccessory = h.registered.find((a) => a.context.kind === 'alarms');
  const count = alarmAccessory.services.flatMap((s) => s.characteristics).find((c) => c.displayName === 'Liczba aktywnych alarmów');
  const name = alarmAccessory.services.flatMap((s) => s.characteristics).find((c) => c.displayName === 'Alarm 1 - nazwa');
  assert.equal(await count.handleGetRequest(), 1);
  assert.equal(await name.handleGetRequest(), 'Alarm testowy');
  fail = true;
  now += 1_800_000;
  await h.platform.pollOnce();
  await assert.rejects(count.handleGetRequest());
  await assert.rejects(name.handleGetRequest());
  h.platform.stop();
});

test('expiry actively marks HomeKit characteristics faulty without another poll', async () => {
  const api = new HomebridgeAPI();
  const accessory = new api.platformAccessory('Expiry Huawei', api.hap.uuid.generate('expiry-test'));
  const wrapper = new TelemetryAccessory(accessory, api, 47, 10, false);
  wrapper.update({ active_power: 20 }, Date.now());
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(custom(accessory, wrapper.metricUuid('active_power')).handleGetRequest());
  const faults = accessory.services.flatMap((s) => s.characteristics).filter((c) => c.UUID === api.hap.Characteristic.StatusFault.UUID);
  assert.ok(faults.length > 0);
  assert.ok(faults.every((c) => c.value === 1));
  wrapper.close();
});

test('overlapping cycles and shutdown during discovery do not publish late data', async () => {
  let release;
  let plantCalls = 0;
  let closed = false;
  const client = new DemoApi();
  const plants = await client.listPlants();
  client.listPlants = () => { plantCalls++; return new Promise((resolve) => { release = () => resolve(plants); }); };
  client.close = () => { closed = true; };
  const h = harness(HomebridgeAPI, {}, { client });
  const first = h.platform.pollOnce();
  await h.platform.pollOnce();
  assert.equal(plantCalls, 1);
  h.platform.stop();
  release();
  await first;
  assert.equal(closed, true);
  assert.equal(h.registered.length, 0);
});

test('missing device KPI is unavailable and disabled alarms/status sensors are not created', async () => {
  const client = new DemoApi();
  client.deviceKpis = () => Promise.resolve([]);
  const h = harness(HomebridgeAPI, { alarms: false, statusSensors: false }, { client });
  await h.platform.pollOnce();
  assert.equal(h.registered.length, 3);
  assert.ok(h.registered.every((a) => !a.getService(h.api.hap.Service.ContactSensor)));
  const temperature = h.registered.find((a) => a.context.typeId === 38).getService(h.api.hap.Service.TemperatureSensor).getCharacteristic(h.api.hap.Characteristic.CurrentTemperature);
  await assert.rejects(temperature.handleGetRequest());
  h.platform.stop();
});

test('local snapshot is atomic, owner-only and contains no temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fusionsolar-snapshot-'));
  try {
    await writeSnapshot(directory, '0123456789abcdef', { value: 3 });
    await writeSnapshot(directory, '0123456789abcdef', { value: 4 });
    const path = join(directory, 'huawei-fusionsolar-monitor', '0123456789abcdef.json');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { value: 4 });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(directory, 'huawei-fusionsolar-monitor')), ['0123456789abcdef.json']);
    await assert.rejects(writeSnapshot(directory, '../escape', {}));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid configuration never logs credentials or starts a client', async () => {
  const h = harness(HomebridgeAPI, { demo: false, baseUrl: 'https://secret-user:super-secret@evil.example', username: 'secret-user', password: 'super-secret' });
  await h.platform.pollOnce();
  assert.equal(h.registered.length, 0);
  assert.ok(!h.entries.join('\n').includes('super-secret'));
  assert.ok(!h.entries.join('\n').includes('secret-user'));
  h.platform.stop();
});
