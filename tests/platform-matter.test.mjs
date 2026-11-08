import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import v1Api from '../node_modules/homebridge-v1/lib/api.js';
import { HuaweiFusionSolarPlatform, PLATFORM_NAME } from '../dist/platform.js';
import { DemoApi } from '../dist/demo.js';
import { POWER_SERVICE_UUID, POWER_CHARACTERISTIC_UUID } from '../dist/power-meter.js';

async function harness({ Api = HomebridgeAPI, matter = true, config = {}, client = new DemoApi() } = {}) {
  const api = new Api();
  if (matter && api.loadMatterAPI) {
    await api.loadMatterAPI();
    // The facade requires the bridge lifecycle to be active; engine behavior is covered separately.
    api._setMatterManager({ hasActiveMatter: () => true, isBridgeServerStarting: () => false, getExternalServer: () => undefined });
  }
  const native = [];
  const hap = [];
  const updates = [];
  const removed = [];
  const logs = [];
  // A state store for these platform-wiring tests; the adapter suite uses the real Matter engine.
  if (api.matter) api._setMatterServer({ getAccessoryState: (uuid, cluster) => native.find((a) => a.UUID === uuid)?.clusters?.[cluster] });
  api.on('registerMatterPlatformAccessories', (plugin, platform, accessories) => native.push(...accessories));
  api.on('registerPlatformAccessories', (accessories) => hap.push(...accessories));
  api.on('updateMatterAccessoryState', (uuid, cluster, attributes) => {
    updates.push({ uuid, cluster, ...attributes });
    const accessory = native.find((a) => a.UUID === uuid);
    if (accessory) accessory.clusters[cluster] = { ...accessory.clusters[cluster], ...attributes };
  });
  api.on('unregisterMatterPlatformAccessories', (plugin, platform, accessories) => removed.push(...accessories));
  const log = (message) => logs.push(message);
  for (const level of ['info', 'warn', 'error', 'debug', 'success']) log[level] = log;
  const platform = new HuaweiFusionSolarPlatform(log, { platform: PLATFORM_NAME, demo: true, writeSnapshot: false, matterEnergy: true, gridPowerDirection: 'positiveExport', ...config }, api, { client });
  return { api, platform, native, hap, updates, removed, logs };
}
const nativeValue = (h) => h.updates.filter((u) => u.cluster === 'electricalPowerMeasurement').at(-1)?.activePower;
const home = (h) => h.hap.find((a) => a.context.kind === 'plant').services.find((s) => s.UUID === POWER_SERVICE_UUID).characteristics.find((c) => c.UUID === POWER_CHARACTERISTIC_UUID);

test('platform publishes only whole-home Matter power and honors negative-import convention consistently with HAP', async () => {
  const client = new DemoApi();
  const read = client.deviceKpis.bind(client);
  let fail = false;
  client.deviceKpis = async (type, ids) => {
    if (fail && type === 47) throw new Error('network');
    return read(type, ids);
  };
  const h = await harness({ client });
  try {
    await h.platform.pollOnce();
    assert.equal(h.native.length, 1);
    assert.equal(h.native[0].deviceType, h.api.matter.deviceTypes.ElectricalSensor);
    assert.equal(h.native[0].handlers, undefined);
    assert.ok(!Object.hasOwn(h.native[0].clusters, 'onOff'));
    assert.equal(nativeValue(h), 5_000_000);
    assert.equal(await home(h).handleGetRequest(), 5000);
    fail = true;
    await h.platform.pollOnce();
    assert.equal(nativeValue(h), null);
    await assert.rejects(home(h).handleGetRequest());
    fail = false;
    await h.platform.pollOnce();
    assert.equal(nativeValue(h), 5_000_000);
    assert.equal(await home(h).handleGetRequest(), 5000);
  } finally { h.platform.stop(); }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nativeValue(h), null, 'shutdown invalidates native power');
});

test('disabled native option, disabled Matter and Homebridge 1 keep HAP monitoring operational', async () => {
  for (const settings of [{ config: { matterEnergy: false } }, { matter: false }, { Api: v1Api.HomebridgeAPI, matter: false }]) {
    const h = await harness(settings);
    try {
      await h.platform.pollOnce();
      assert.equal(h.native.length, 0);
      assert.equal(await home(h).handleGetRequest(), 5000);
    } finally { h.platform.stop(); }
  }
});

test('unconfirmed direction produces unavailable native power rather than an invented zero', async () => {
  const h = await harness({ config: { gridPowerDirection: 'unconfigured' } });
  try {
    await h.platform.pollOnce();
    assert.equal(h.native.length, 1);
    assert.equal(nativeValue(h), null);
    assert.ok(h.updates.some((u) => u.cluster === 'bridgedDeviceBasicInformation' && u.reachable === false));
    assert.ok(h.logs.some((message) => message.includes('gridPowerDirection')));
  } finally { h.platform.stop(); }
});

test('turning native energy off removes restored Matter endpoints without touching HAP accessories', async () => {
  const enabled = await harness();
  let disabled;
  try {
    await enabled.platform.pollOnce();
    const cached = enabled.native[0];
    enabled.platform.stop();
    disabled = await harness({ config: { matterEnergy: false } });
    disabled.platform.configureMatterAccessory(cached);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disabled.removed.length, 1);
    assert.equal(disabled.removed[0].UUID, cached.UUID);
    assert.equal(nativeValue(disabled), undefined, 'no fire-and-forget state update races endpoint removal');
    await disabled.platform.pollOnce();
    assert.equal(disabled.native.length, 0);
    assert.equal(await home(disabled).handleGetRequest(), 5000);
  } finally { enabled.platform.stop(); disabled?.platform.stop(); }
});

test('a native registration failure does not invalidate independent HAP readings', async () => {
  const h = await harness();
  h.api.on('registerMatterPlatformAccessories', () => { throw new Error('native unavailable'); });
  try {
    await h.platform.pollOnce();
    assert.equal(await home(h).handleGetRequest(), 5000);
    assert.ok(h.logs.some((message) => message.includes('Native energy')));
  } finally { h.platform.stop(); }
});
