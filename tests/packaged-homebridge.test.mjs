import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

test('installable archive loads in real Homebridge 1/2, publishes precise read-only data, then restores cache', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fusionsolar-packaged-'));
  let child;
  try {
    const { stdout } = await execute('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], { cwd: root });
    const [pack] = JSON.parse(stdout);
    assert.equal(pack.name, 'homebridge-huawei-fusionsolar-monitor');
    assert.ok(pack.files.some((file) => file.path === 'dist/index.js'));
    assert.ok(pack.files.some((file) => file.path === 'config.schema.json'));
    assert.ok(pack.files.every((file) => !/node_modules|tests\/|fixtures\/|\.pem$|\.env/u.test(file.path)));
    await execute('tar', ['-xzf', join(directory, pack.filename), '-C', directory]);
    const plugin = join(directory, 'package');
    const manifest = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'));
    assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
    for (const [version, binary] of [
      ['1.11.4', join(root, 'node_modules/homebridge-v1/bin/homebridge')],
      ['2.5.0', join(root, 'node_modules/homebridge/bin/homebridge.js')]
    ]) {
      const storage = join(directory, `storage-${version}`);
      await mkdir(storage);
      const port = await freePort();
      const pin = '142-83-957';
      await writeFile(join(storage, 'config.json'), JSON.stringify({
        bridge: { name: `Huawei test ${version}`, username: version.startsWith('1') ? '0E:AA:BB:CC:11:42' : '0E:AA:BB:CC:22:42', port, pin, bind: ['127.0.0.1'], advertiser: 'ciao' },
        plugins: ['homebridge-huawei-fusionsolar-monitor'],
        platforms: [{ platform: 'HuaweiFusionSolarMonitor', demo: true, writeSnapshot: true }],
        accessories: []
      }));
      let previousIds;
      for (let run = 0; run < 2; run++) {
        let logs = '';
        child = spawn(process.execPath, [binary, '-U', storage, '-P', plugin, '--strict-plugin-resolution', '-Q', '-I', '-T'], { cwd: directory, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
            if (response.ok && current.accessories?.length === 5 && logs.includes('Wykryto instalacje: 1; urządzenia: 2')) {
              payload = current;
              break;
            }
          } catch { /* Local listener may not be ready yet. */ }
          await sleep(100);
        }
        assert.ok(payload, `Homebridge ${version} did not publish telemetry: ${logs}`);
        assert.match(logs, /Tryb DEMO/);
        assert.ok(!/Cannot add a Service|plugin threw|Unhandled|Nieprawidłowe|Odczyt danych:|characteristic.*warning/iu.test(logs), logs);
        const readings = payload.accessories.flatMap((accessory) => accessory.services.flatMap((service) => service.characteristics.map((characteristic) => ({ aid: accessory.aid, ...characteristic }))));
        const power = readings.find((reading) => reading.description === 'Moc czynna [kW]');
        const meter = readings.find((reading) => reading.description === 'Moc czynna [W]');
        const daily = readings.find((reading) => reading.description === 'Produkcja dzisiaj [kWh]');
        assert.ok(power, `No inverter power in real HAP response: ${JSON.stringify(payload)}`);
        assert.equal(power.value, 3.9);
        assert.equal(meter.value, -1100);
        assert.equal(daily.value, 18.4);
        assert.ok(!power.perms.includes('pw'));
        const ids = { aid: power.aid, iid: power.iid };
        if (previousIds) assert.deepEqual(ids, previousIds, 'pairing/automation identifiers remain stable after restart');
        previousIds = ids;
        const write = await fetch(`http://127.0.0.1:${port}/characteristics`, {
          method: 'PUT', headers: { authorization: pin, 'content-type': 'application/hap+json' },
          body: JSON.stringify({ characteristics: [{ aid: power.aid, iid: power.iid, value: 0 }] })
        });
        assert.equal(write.status, 207);
        assert.equal((await write.json()).characteristics[0].status, -70404, 'HomeKit rejects write to a read-only KPI');
        const snapshots = await readdir(join(storage, 'huawei-fusionsolar-monitor'));
        assert.equal(snapshots.length, 1);
        const snapshot = JSON.parse(await readFile(join(storage, 'huawei-fusionsolar-monitor', snapshots[0]), 'utf8'));
        assert.equal(snapshot.demo, true);
        assert.equal(snapshot.sources['devices-38'].data[0].values.active_power, 3.9);
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
