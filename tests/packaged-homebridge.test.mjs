import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const packageName = '@buslowicz/homebridge-huawei-fusionsolar-monitor';
const legacyName = 'homebridge-huawei-fusionsolar-monitor';
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

test('scoped archive loads in Homebridge 1/2, migrates full telemetry to minimal, then restores pairing', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fusionsolar-packaged-'));
  let child;
  try {
    const { stdout } = await execute('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], { cwd: root });
    const [pack] = JSON.parse(stdout);
    assert.equal(pack.name, packageName);
    assert.ok(pack.files.some((file) => file.path === 'dist/index.js'));
    assert.ok(pack.files.some((file) => file.path === 'config.schema.json'));
    assert.ok(pack.files.every((file) => !/node_modules|tests\/|fixtures\/|\.pem$|\.env/u.test(file.path)));
    await execute('tar', ['-xzf', join(directory, pack.filename), '-C', directory]);
    const plugin = join(directory, 'package');
    const manifest = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'));
    assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
    const globalPrefix = join(directory, 'global');
    await execute('npm', ['install', '--global', '--prefix', globalPrefix, '--no-audit', '--no-fund', join(directory, pack.filename)], { cwd: directory });
    const modulesDirectory = join(globalPrefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules');
    // Start the previous package identity first, then replace it with the actual scoped archive.
    // The fixture retains the same platform contract and original HomeKit UUID seeds.
    const legacyPlugin = join(directory, 'legacy');
    await cp(plugin, legacyPlugin, { recursive: true });
    await writeFile(join(legacyPlugin, 'package.json'), JSON.stringify({ ...manifest, name: legacyName }));
    const platformPath = join(legacyPlugin, 'dist/identifiers.js');
    const platformSource = await readFile(platformPath, 'utf8');
    assert.ok(platformSource.includes(`export const PLUGIN_NAME = '${packageName}'`));
    await writeFile(platformPath, platformSource.replace(`export const PLUGIN_NAME = '${packageName}'`, `export const PLUGIN_NAME = '${legacyName}'`));
    for (const [version, binary] of [
      ['1.11.4', join(root, 'node_modules/homebridge-v1/bin/homebridge')],
      ['2.5.0', join(root, 'node_modules/homebridge/bin/homebridge.js')]
    ]) {
      const storage = join(directory, `storage-${version}`);
      await mkdir(storage);
      const port = await freePort();
      const pin = '142-83-957';
      const configuration = {
        bridge: { name: `Huawei test ${version}`, username: version.startsWith('1') ? '0E:AA:BB:CC:11:42' : '0E:AA:BB:CC:22:42', port, pin, bind: ['127.0.0.1'], advertiser: 'ciao' },
        plugins: [packageName],
        platforms: [{ platform: 'HuaweiFusionSolarMonitor', demo: true, writeSnapshot: true, gridPowerDirection: 'positiveExport', gridMeterId: '1002' }],
        accessories: []
      };
      let previousIds;
      for (let run = 0; run < 4; run++) {
        const advanced = run < 2;
        await writeFile(join(storage, 'config.json'), JSON.stringify({
          ...configuration, plugins: [run === 0 ? legacyName : packageName],
          platforms: configuration.platforms.map((platform) => advanced ? { ...platform, advancedTelemetry: true } : platform)
        }));
        let logs = '';
        child = spawn(process.execPath, [binary, '-U', storage, '-P', run === 0 ? legacyPlugin : modulesDirectory, '--strict-plugin-resolution', '-Q', '-I', '-T'], { cwd: directory, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
        child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
        const exited = once(child, 'exit');
        let payload;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          if (child.exitCode !== null) assert.fail(`Homebridge ${version} stopped early: ${logs}`);
          try {
            const response = await fetch(`http://127.0.0.1:${port}/accessories`, { headers: { authorization: pin }, signal: AbortSignal.timeout(500) });
            const current = await response.json();
            if (response.ok && current.accessories?.length === 5 && logs.includes('Discovered plants: 1; devices: 2')) {
              payload = current;
              break;
            }
          } catch { /* Local listener may not be ready yet. */ }
          await sleep(100);
        }
        assert.ok(payload, `Homebridge ${version} did not publish telemetry: ${logs}`);
        assert.match(logs, /DEMO mode/);
        assert.ok(logs.includes(`Loaded plugin: ${run === 0 ? legacyName : packageName}@`), logs);
        assert.ok(!/Removing orphaned accessory|Could not restore cached accessory|Failed to find plugin to handle|incorrect plugin identifier/iu.test(logs), logs);
        if (run === 1) {
          assert.ok(logs.includes(`plugin name changed from '${legacyName}' to '${packageName}'`), logs);
        }
        assert.ok(!/Cannot add a Service|plugin threw|Unhandled|Invalid|Data polling:|characteristic.*warning/iu.test(logs), logs);
        const readings = payload.accessories.flatMap((accessory) => accessory.services.flatMap((service) => service.characteristics.map((characteristic) => ({ aid: accessory.aid, ...characteristic }))));
        const power = readings.find((reading) => reading.description === 'Active power [kW]');
        const meter = readings.find((reading) => reading.description === 'Active power [W]');
        const daily = readings.find((reading) => reading.description === 'Production today [kWh]');
        if (advanced) {
          assert.ok(power, `No inverter power in diagnostic HAP response: ${JSON.stringify(payload)}`);
          assert.equal(power.value, 3.9);
          assert.equal(meter.value, -1100);
          assert.equal(daily.value, 18.4);
          assert.ok(!power.perms.includes('pw'));
        } else {
          assert.equal(power, undefined);
          assert.equal(meter, undefined);
          assert.equal(daily, undefined);
          assert.ok(!readings.some((r) => /API received at|Internal temperature|PV1 voltage|Alarm 1 -|Alarms critical/u.test(r.description ?? '')));
          const ownServices = payload.accessories.filter((a) => a.aid !== 1).flatMap((a) => a.services)
            .filter((s) => !['3E', '0000003E-0000-1000-8000-0026BB765291'].includes(s.type.toUpperCase()));
          assert.equal(ownServices.length, 8, 'only five power readings, two status sensors and one alarm count remain');
        }
        const productionMeter = readings.find((r) => r.description === 'PV Production [W]');
        const homeMeter = readings.find((r) => r.description === 'Home Consumption [W]');
        const gridMeter = readings.find((r) => r.description === 'Grid Power [W]');
        const importMeter = readings.find((r) => r.description === 'Grid Import [W]');
        const exportMeter = readings.find((r) => r.description === 'Grid Export [W]');
        assert.equal(gridMeter.value, 1100, 'signed grid power is positive import in both profiles');
        for (const [reading, expected] of [[productionMeter, 3900], [homeMeter, 5000], [importMeter, 1100], [exportMeter, 0]]) {
          assert.ok(reading, 'electrical meter is present in the actual HAP response');
          assert.equal(reading.type.toUpperCase(), 'E863F10D-079E-48FF-8F27-9C2605A29F52');
          assert.equal(reading.value, expected);
          assert.equal(reading.unit, 'W');
          assert.ok(!reading.perms.includes('pw'));
        }
        const alarmCount = readings.find((r) => r.description === 'Active alarms');
        assert.equal(alarmCount.value, 0);
        const contacts = payload.accessories.flatMap((accessory) => accessory.services
          .filter((s) => ['80', '00000080-0000-1000-8000-0026BB765291'].includes(s.type.toUpperCase()))
          .flatMap((s) => s.characteristics.filter((r) => ['6A', '0000006A-0000-1000-8000-0026BB765291'].includes(r.type.toUpperCase())).map((r) => ({ aid: accessory.aid, ...r }))));
        assert.equal(contacts.length, 2);
        const ids = [productionMeter, homeMeter, gridMeter, importMeter, exportMeter, alarmCount, ...contacts].map((r) => ({ aid: r.aid, iid: r.iid }));
        if (previousIds) assert.deepEqual(ids, previousIds, 'retained power/status/alarm identifiers survive minimal mode migration and restart');
        previousIds = ids;
        const write = await fetch(`http://127.0.0.1:${port}/characteristics`, {
          method: 'PUT', headers: { authorization: pin, 'content-type': 'application/hap+json' },
          body: JSON.stringify({ characteristics: [productionMeter, homeMeter, alarmCount, ...(advanced ? [power] : [])].map((r) => ({ aid: r.aid, iid: r.iid, value: 0 })) })
        });
        assert.equal(write.status, 207);
        assert.ok((await write.json()).characteristics.every((r) => r.status === -70404), 'HomeKit rejects writes to KPIs and power meters');
        const snapshots = await readdir(join(storage, 'huawei-fusionsolar-monitor'));
        assert.equal(snapshots.length, 1);
        const snapshot = JSON.parse(await readFile(join(storage, 'huawei-fusionsolar-monitor', snapshots[0]), 'utf8'));
        assert.equal(snapshot.demo, true);
        assert.equal(snapshot.sources['devices-38'].data[0].values.active_power, 3.9);
        assert.equal(snapshot.sources['power-DEMO'].data.homeConsumptionW, 5000);
        child.kill('SIGTERM');
        await exited;
        // HB1 retains a 5s exit(143) fallback; HB2 unrefs it and cleanly exits(0).
        assert.match(logs, /Got SIGTERM, shutting down Homebridge/u);
        assert.equal(child.exitCode, version.startsWith('1') ? 143 : 0, 'normal shutdown contract for this Homebridge version');
        child = undefined;
      }
    }
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(3000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await rm(directory, { recursive: true, force: true });
  }
});
