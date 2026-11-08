import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import v1Api from '../node_modules/homebridge-v1/lib/api.js';
import { MatterEnergy } from '../dist/matter-energy.js';

function logger() {
  const messages = [];
  const log = Object.assign(() => {}, Object.fromEntries(['info', 'warn', 'error', 'debug', 'success'].map((level) => [level, (message) => messages.push(message)])));
  return { log, messages };
}

test('HAP-only Homebridge 1 and 2 do not load Matter or publish endpoints', async () => {
  for (const Api of [HomebridgeAPI, v1Api.HomebridgeAPI]) {
    const api = new Api();
    const { log, messages } = logger();
    const energy = new MatterEnergy(api, 'test', 1000, log);
    await energy.discover([{ code: 'P1', name: 'House' }]);
    await energy.update('P1', 1, Date.now());
    energy.close();
    assert.equal(api.matter, undefined);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /enable Matter/);
  }
});

test('real Homebridge 2.5 Matter engine registers only a read-only ElectricalSensor, updates raw mW and expires independently', async () => {
  const { MatterServer } = await import('../node_modules/homebridge/dist/matter/server.js');
  const { User } = await import('../node_modules/homebridge/dist/user.js');
  const storage = await mkdtemp(join(tmpdir(), 'fusionsolar-matter-engine-'));
  User.setStoragePath(storage);
  const api = new HomebridgeAPI();
  await api.loadMatterAPI();
  const config = { uniqueId: 'AA:BB:CC:DD:EE:91', storagePath: storage, deferOnline: true, port: 55591 };
  let server;
  let energy;
  const work = new Set();
  const failures = [];
  const registrations = [];
  const removed = [];
  // Wire the public Homebridge facade to its real Matter server, as the bridge manager does.
  api._matterManager = { hasActiveMatter: () => true, isBridgeServerStarting: () => false, getExternalServer: () => undefined };
  function track(promise) {
    work.add(promise);
    promise.catch((error) => failures.push(error)).finally(() => work.delete(promise));
    return promise;
  }
  async function settled() {
    for (let pass = 0; pass < 4; pass++) {
      while (work.size) await Promise.allSettled([...work]);
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(failures, [], 'real engine rejected a state update');
  }
  api.on('registerMatterPlatformAccessories', (plugin, platform, accessories, tracker) => {
    registrations.push(accessories.map((item) => item.UUID));
    tracker(track(server.registerPlatformAccessories(plugin, platform, accessories)));
  });
  api.on('unregisterMatterPlatformAccessories', (plugin, platform, accessories, tracker) => {
    removed.push(...accessories.map((item) => item.UUID));
    tracker(track(server.unregisterPlatformAccessories(plugin, platform, accessories)));
  });
  api.on('updateMatterAccessoryState', (uuid, cluster, attributes, partId) => {
    track(server.updateAccessoryState(uuid, cluster, attributes, partId));
  });
  const power = (uuid) => server.getAccessoryState(uuid, 'electricalPowerMeasurement').activePower;
  const reachable = (uuid) => server.getAccessoryState(uuid, 'bridgedDeviceBasicInformation').reachable;
  const plants = [{ code: 'P1', name: 'House' }, { code: 'P2', name: '🏠 Dom źółć'.repeat(20) }];
  const { log } = logger();
  try {
    server = new MatterServer(config);
    api._matterServer = server;
    await server.start();
    energy = new MatterEnergy(api, 'account-hash', 120, log);
    await energy.discover(plants);
    await settled();
    assert.equal(server.getAccessories().length, 2);
    for (const endpoint of server.getAccessories()) {
      assert.ok(Buffer.byteLength(endpoint.displayName) <= 32);
      assert.equal(endpoint.displayName.includes('\uFFFD'), false);
    }
    const uuid = api.hap.uuid.generate('huawei-fusionsolar-monitor:matter-home-consumption:v1:account-hash:P1');
    const accessory = server.getAccessory(uuid);
    assert.ok(accessory);
    assert.equal(accessory.deviceType.deviceType, api.matter.deviceTypes.ElectricalSensor.deviceType);
    assert.equal(server.accessories.get(uuid).endpoint.state.onOff, undefined);
    assert.equal(accessory.clusters.onOff, undefined);
    assert.deepEqual(accessory.handlers ?? {}, {});
    assert.equal(power(uuid), null);
    assert.equal(reachable(uuid), false);
    await energy.update('P1', 2800.1254, Date.now());
    await settled();
    assert.equal(power(uuid), 2800125);
    assert.equal(reachable(uuid), true);
    await energy.update('P2', 10, Date.now());
    await delay(135);
    await settled();
    assert.equal(power(uuid), null, 'expiry pushes null without another API sample');
    assert.equal(reachable(uuid), false);
    for (const watts of [undefined, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
      await energy.update('P1', watts, Date.now());
      await settled();
      assert.equal(power(uuid), null);
      assert.equal(reachable(uuid), false);
    }
    await energy.update('P1', 0, Date.now());
    await settled();
    assert.equal(power(uuid), 0, 'genuine zero remains available');
    assert.equal(reachable(uuid), true);
    await energy.update('P1', 100, Date.now() - 121);
    await settled();
    assert.equal(power(uuid), null);
    await energy.update('P1', 100, Date.now() + 1000);
    await settled();
    assert.equal(power(uuid), null, 'future receive time is invalid');

    // Leave a real persisted measurement to prove startup never trusts cached power.
    await energy.update('P1', 42, Date.now());
    await settled();
    energy.close();
    await settled();
    await server.updateAccessoryState(uuid, 'electricalPowerMeasurement', { activePower: 42000 });
    // A deferred node never goes online: explicitly persist using Homebridge's real cache writer.
    await server.accessoryCache.save(server.accessories);
    await server.stop();
    server = new MatterServer(config);
    api._matterServer = server;
    await server.start();
    const cached = server.getAccessory(uuid);
    assert.ok(cached, 'real server restored the cached endpoint');
    assert.equal(power(uuid), 42000);
    energy = new MatterEnergy(api, 'account-hash', 120, log);
    for (const restored of server.getAccessories()) energy.restore(restored);
    await settled();
    assert.equal(power(uuid), null);
    assert.equal(reachable(uuid), false);
    await energy.discover(plants);
    await settled();
    assert.equal(server.getAccessories().length, 2, 'restart creates no duplicate endpoints');
    assert.ok(registrations.length >= 2, 'cached endpoints were re-registered');
    assert.equal(power(uuid), null, 'explicit reset overrides state retained on re-registration');
    assert.deepEqual(server.getAccessory(uuid).context, { kind: 'home-consumption-v1', sourceId: 'P1' });
    await energy.discover([plants[0]]);
    await settled();
    assert.equal(server.getAccessories().length, 1);
    assert.equal(removed.length, 1);
    await energy.update('P1', 12.5, Date.now());
    await settled();
    energy.close();
    await settled();
    assert.equal(power(uuid), null);
    assert.equal(reachable(uuid), false);
    await energy.update('P1', 500, Date.now());
    await settled();
    assert.equal(power(uuid), null);
  } finally {
    energy?.close();
    try {
      await settled();
    } finally {
      await server?.stop();
      await rm(storage, { recursive: true, force: true });
    }
  }
});

function fakeMatter() {
  const api = new HomebridgeAPI();
  const calls = [];
  const matter = {
    deviceTypes: { ElectricalSensor: { deviceType: 1296 } },
    registerPlatformAccessories: async (...args) => { calls.push(['register', ...args]); },
    unregisterPlatformAccessories: async (...args) => { calls.push(['remove', ...args]); },
    getAccessoryState: async () => ({ activePower: null }),
    updateAccessoryState: async (...args) => { calls.push(['update', ...args]); }
  };
  Object.defineProperty(api, 'matter', { value: matter });
  return { api, matter, calls };
}

test('failed or slow optional Matter work cannot reject polling, delete cached endpoints or leak raw errors', async () => {
  const { api, matter, calls } = fakeMatter();
  const { log, messages } = logger();
  const energy = new MatterEnergy(api, 'identity', 1000, log);
  await energy.discover([{ code: 'P1', name: 'House' }]);
  matter.registerPlatformAccessories = async () => { throw new Error('SECRET raw payload'); };
  await assert.doesNotReject(energy.discover([{ code: 'P2', name: 'Other House' }]));
  assert.equal(calls.filter(([kind]) => kind === 'remove').length, 0);
  matter.updateAccessoryState = async () => { throw new Error('SECRET raw payload'); };
  await assert.doesNotReject(energy.update('P1', 10, Date.now()));
  assert.ok(messages.length >= 2);
  assert.ok(messages.every((message) => !message.includes('SECRET')));
  energy.close();

  const stalled = fakeMatter();
  let release;
  stalled.matter.registerPlatformAccessories = () => new Promise((resolve) => { release = resolve; });
  const slow = new MatterEnergy(stalled.api, 'identity', 1000, log);
  const started = Date.now();
  await slow.discover([{ code: 'P1', name: 'House' }]);
  assert.ok(Date.now() - started < 2000, 'registration wait is bounded');
  slow.close();
  release();
  await delay(10);
  const updates = stalled.calls.filter(([kind]) => kind === 'update');
  assert.ok(updates.some(([, , cluster, state]) => cluster === 'electricalPowerMeasurement' && state.activePower === null));
  assert.ok(updates.every(([, , cluster, state]) => cluster !== 'electricalPowerMeasurement' || state.activePower === null));
});

test('a failed registration retries on the next sample without resetting an already fresh sibling', async () => {
  const { api, matter, calls } = fakeMatter();
  const { log } = logger();
  const energy = new MatterEnergy(api, 'identity', 1000, log);
  const first = { code: 'P1', name: 'House' };
  const second = { code: 'P2', name: 'Other House' };
  await energy.discover([first]);
  await energy.update('P1', 42, Date.now());
  const register = matter.registerPlatformAccessories;
  matter.registerPlatformAccessories = async () => { throw new Error('temporary registration failure'); };
  await energy.discover([first, second]);
  const checkpoint = calls.length;
  matter.registerPlatformAccessories = register;
  await energy.update('P2', 12, Date.now());
  const retried = calls.slice(checkpoint);
  assert.deepEqual(retried.filter(([kind]) => kind === 'register').map(([, , , endpoints]) => endpoints.map((endpoint) => endpoint.context.sourceId)), [['P2']]);
  const firstUuid = api.hap.uuid.generate('huawei-fusionsolar-monitor:matter-home-consumption:v1:identity:P1');
  assert.ok(retried.filter(([kind]) => kind === 'update').every(([, uuid]) => uuid !== firstUuid));
  assert.ok(retried.some(([kind, , cluster, state]) => kind === 'update' && cluster === 'electricalPowerMeasurement' && state.activePower === 12000));
  energy.close();
});

test('a stalled update has bounded callers, coalesces samples and eventually clears on close', async () => {
  const { api, matter, calls } = fakeMatter();
  const { log } = logger();
  const energy = new MatterEnergy(api, 'identity', 25, log);
  await energy.discover([{ code: 'P1', name: 'House' }]);
  let release;
  const update = matter.updateAccessoryState;
  matter.updateAccessoryState = async (...args) => {
    await new Promise((resolve) => { release = resolve; });
    await update(...args);
  };
  const checkpoint = calls.length;
  const started = Date.now();
  await Promise.all([energy.update('P1', 10, Date.now()), energy.update('P1', 11, Date.now())]);
  assert.ok(Date.now() - started < 2000);
  energy.close();
  matter.updateAccessoryState = update;
  release();
  await delay(10);
  const delivered = calls.slice(checkpoint);
  assert.ok(delivered.some(([, , cluster, state]) => cluster === 'electricalPowerMeasurement' && state.activePower === null));
  const lastPower = delivered.filter(([, , cluster]) => cluster === 'electricalPowerMeasurement').at(-1);
  assert.equal(lastPower[3].activePower, null);
  const lastReachable = delivered.filter(([, , cluster]) => cluster === 'bridgedDeviceBasicInformation').at(-1);
  assert.equal(lastReachable[3].reachable, false);
});

test('an older optional Matter API without ElectricalSensor safely preserves HAP telemetry', async () => {
  const { api, matter, calls } = fakeMatter();
  matter.deviceTypes = {};
  const { log, messages } = logger();
  const energy = new MatterEnergy(api, 'identity', 1000, log);
  await energy.discover([{ code: 'P1', name: 'House' }]);
  await energy.update('P1', 10, Date.now());
  energy.close();
  assert.deepEqual(calls, []);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Homebridge 2\.5 or newer/);
});

test('a swallowed engine registration failure is detected through the public state probe and retries next sample', async () => {
  for (const invalid of [undefined, null, [], {}, { activePower: undefined }, { activePower: '10' }, { activePower: NaN }]) {
    const { api, matter, calls } = fakeMatter();
    matter.getAccessoryState = async () => invalid;
    const { log } = logger();
    const energy = new MatterEnergy(api, 'identity', 1000, log);
    await assert.doesNotReject(energy.discover([{ code: 'P1', name: 'House' }]));
    assert.equal(calls.filter(([kind]) => kind === 'register').length, 1);
    assert.equal(calls.filter(([kind]) => kind === 'update').length, 0, 'missing or malformed endpoint cannot accept a fresh reading');
    matter.getAccessoryState = async () => ({ activePower: null });
    await energy.update('P1', 10, Date.now());
    assert.equal(calls.filter(([kind]) => kind === 'register').length, 2);
    assert.ok(calls.some(([kind, , cluster, state]) => kind === 'update' && cluster === 'electricalPowerMeasurement' && state.activePower === 10000));
    energy.close();
  }
});
