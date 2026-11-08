import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginName = 'homebridge-huawei-fusionsolar-monitor';

function environment(directory) {
  const env = {
    ...process.env,
    PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    npm_config_cache: process.env.FUSIONSOLAR_TEST_NPM_CACHE ?? process.env.npm_config_cache ?? join(directory, 'npm-cache'),
    npm_config_ignore_scripts: 'false',
    npm_config_foreground_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_fetch_retries: '0',
    npm_config_fetch_timeout: '25000',
    npm_config_global: 'false',
  };
  // Each test chooses its own working directory/prefix; inherited source-build configuration must not redirect installs.
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  return env;
}

async function assertRuntime(installed, modulesDirectory) {
  const entry = join(installed, 'dist/index.js');
  await assert.doesNotReject(access(entry), 'installation must provide dist/index.js from the prepared or prebuilt package');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, pluginName);
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, 'the monitor has no runtime dependency bundle');
  assert.equal((await readdir(installed)).includes('node_modules'), false, 'build-time Homebridge, TypeScript and lint dependencies must not be bundled');
  const packages = await readdir(modulesDirectory);
  assert.deepEqual(packages.filter((name) => !name.startsWith('.')), [pluginName], 'preparation must not install Homebridge or any build dependency into the runtime directory');
  const { default: register } = await import(pathToFileURL(entry).href);
  assert.equal(typeof register, 'function');
  const { HomebridgeAPI } = await import(new URL('./api.js', import.meta.resolve('homebridge')).href);
  const api = new HomebridgeAPI();
  const registrations = [];
  api.on('registerPlatform', (name, constructor, identifier) => registrations.push({ name, constructor, identifier }));
  register(api);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, 'HuaweiFusionSolarMonitor');
  assert.equal(registrations[0].identifier, pluginName);
  assert.equal(typeof registrations[0].constructor, 'function');
  assert.equal(typeof registrations[0].constructor.prototype.configureAccessory, 'function');
}

test('a clean local Git dependency install builds the runtime and registers its platform without bundled development dependencies', { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fusionsolar-git-install-'));
  const fixture = join(directory, 'source');
  const consumer = join(directory, 'consumer');
  const env = environment(directory);
  const run = (command, args, cwd = fixture, timeout = 15_000) => execute(command, args, {
    cwd, env, timeout, signal: t.signal, maxBuffer: 8 * 1024 * 1024,
  });
  try {
    await mkdir(fixture);
    // Enumerate real build/package inputs explicitly so the source ZIP needs no enclosing .git repository.
    const paths = ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'config.schema.json', 'README.md', 'LICENSE', 'docs'];
    for (const path of paths) await cp(join(root, path), join(fixture, path), { recursive: true });
    await assert.rejects(access(join(fixture, 'dist/index.js')), { code: 'ENOENT' });
    await assert.rejects(access(join(fixture, 'node_modules')), { code: 'ENOENT' });
    await run('git', ['init', '--quiet', '--initial-branch=fixture']);
    await run('git', ['add', '--', ...paths]);
    const commitMessage = join(directory, 'fixture-commit.txt');
    await writeFile(commitMessage, 'test: create clean Git dependency fixture\n');
    await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=FusionSolar test', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-F', commitMessage]);
    const { stdout: commit } = await run('git', ['rev-parse', 'HEAD']);
    const dependency = `git+${pathToFileURL(fixture).href}#${commit.trim()}`;
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'fusionsolar-local-install-fixture', private: true }));
    // Match the user's local npm install command; Homebridge must search this configured plugin directory.
    await run('npm', ['install', '--no-audit', '--no-fund', dependency], consumer, 70_000);
    const modulesDirectory = join(consumer, 'node_modules');
    await assertRuntime(join(modulesDirectory, pluginName), modulesDirectory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the prebuilt archive installs globally and registers its platform without installing build tools', { timeout: 45_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fusionsolar-global-archive-'));
  const prefix = join(directory, 'global');
  const env = environment(directory);
  const run = (args, cwd = directory) => execute('npm', args, { cwd, env, timeout: 30_000, signal: t.signal, maxBuffer: 8 * 1024 * 1024 });
  try {
    const { stdout } = await run(['pack', '--json', '--ignore-scripts', '--pack-destination', directory], root);
    const [pack] = JSON.parse(stdout);
    assert.ok(pack.files.some((file) => file.path === 'dist/index.js'));
    assert.ok(pack.files.every((file) => !/node_modules|tests\/|fixtures\/|\.pem$|\.env/u.test(file.path)));
    await run(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', join(directory, pack.filename)]);
    const modulesDirectory = join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules');
    await assertRuntime(join(modulesDirectory, pluginName), modulesDirectory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
