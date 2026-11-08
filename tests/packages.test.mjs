import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { packageName, archiveFilename } from '../.github/scripts/release.mjs';
import { publishPackage, registry, registryClient, validateRegistryPackage, verifyInstalledPackage } from '../.github/scripts/packages.mjs';

const execute = promisify(execFile);
const version = '0.1.2';
const token = 'secret-package-token';
const entry = `export default function register(api) { api.registerPlatform('${packageName}', 'HuaweiFusionSolarMonitor', class Platform {}); }`;
const manifest = { name: packageName, version, type: 'module', main: 'dist/index.js', publishConfig: { registry } };
const hash = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const download = `${registry}/download/${packageName}/${version}/archive`;

function archive(details = manifest, runtime = entry) {
  const blocks = [];
  for (const [path, content] of [['package/package.json', JSON.stringify(details)], ['package/dist/index.js', runtime]]) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(path);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function metadata(bytes = archive()) {
  return { name: packageName, version, dist: { integrity: hash(bytes), tarball: download } };
}

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fusionsolar-packages-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function installed(prefix, details = manifest, runtime = entry) {
  const directory = join(prefix, 'lib', 'node_modules', ...packageName.split('/'));
  await mkdir(join(directory, 'dist'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify(details));
  await writeFile(join(directory, 'dist', 'index.js'), runtime);
  return directory;
}

async function fixture(t, { existing = false, details = manifest, bytes = archive(details), runtime = entry, installManifest = details } = {}) {
  const cwd = await temporary(t);
  await mkdir(join(cwd, 'release'));
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ ...manifest, version: '0.1.1' }));
  await writeFile(join(cwd, 'release', archiveFilename(version)), bytes);
  const calls = [];
  let published = existing;
  const client = {
    metadata: async () => published ? metadata(bytes) : null,
    archive: async () => bytes,
  };
  const run = async (program, args, options) => {
    calls.push({ program, args, options });
    if (program === 'npm' && args[0] === 'publish') published = true;
    if (program === 'npm' && args[0] === 'install') await installed(args[args.indexOf('--prefix') + 1], installManifest, runtime);
    if (program === process.execPath) return execute(program, args, options);
    return { stdout: '', stderr: '' };
  };
  const input = { cwd, env: { ...process.env, RELEASE_VERSION: version, NODE_AUTH_TOKEN: token }, client, run };
  return { input, calls, cwd, bytes };
}

function noSecret(error) {
  return !String(error.stack).includes(token);
}

test('registry client requests bounded package metadata and treats authentication/network failures as fatal', async () => {
  const calls = [];
  const client = registryClient(token, async (url, options) => {
    calls.push({ url, options });
    return new Response('', { status: 404 });
  });
  assert.equal(await client.metadata(version), null);
  assert.equal(calls[0].url, `${registry}/${encodeURIComponent(packageName)}`);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].options.redirect, 'manual');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  for (const status of [401, 403, 409, 429, 500]) {
    const failure = registryClient(token, async () => new Response(token, { status }));
    await assert.rejects(failure.metadata(version), (error) => noSecret(error) && error.message.includes(`HTTP ${status}`));
  }
  const failure = registryClient(token, async () => { throw new Error(token); });
  await assert.rejects(failure.metadata(version), noSecret);
  assert.throws(() => registryClient(''), /NODE_AUTH_TOKEN/u);
  await assert.rejects(client.metadata('1.2.03'), /version/u);
});

test('registry client selects the exact own version from the package document and rejects malformed data', async () => {
  for (const [versions, expected] of [[{ [version]: metadata() }, metadata()], [{ '0.1.1': {} }, null]]) {
    const calls = [];
    const client = registryClient(token, async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ name: packageName, versions }));
    });
    assert.deepEqual(await client.metadata(version), expected);
    assert.deepEqual(calls, [`${registry}/${encodeURIComponent(packageName)}`]);
  }
  for (const body of [{}, { name: packageName, versions: [] }, { name: 'other', versions: {} },
    ...[null, [], 'invalid'].map((selected) => ({ name: packageName, versions: { [version]: selected } })),
  ]) {
    const client = registryClient(token, async () => new Response(JSON.stringify(body)));
    await assert.rejects(client.metadata(version), /version/u);
  }
});

test('registry client bounds response size and rejects malformed metadata and untrusted redirects', async () => {
  for (const response of [
    () => new Response('{invalid-json'),
    () => new Response(token, { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }),
    () => new Response('a'.repeat(8 * 1024 * 1024 + 1)),
    () => new Response('', { status: 302, headers: { location: 'https://attacker.invalid/package' } }),
    () => new Response('', { status: 302, headers: { location: `https://pkg-npm.githubusercontent.com/${token}` } }),
    () => new Response('', { status: 302 }),
    () => new Response('', { status: 302, headers: { location: `${registry}/loop` } }),
  ]) {
    let requests = 0;
    const client = registryClient(token, async () => { requests++; return response(); });
    await assert.rejects(client.metadata(version), noSecret);
    assert.ok(requests <= 4);
  }
});

test('tarball downloads follow bounded GitHub CDN redirects without forwarding credentials', async () => {
  const calls = [];
  const bytes = archive();
  const client = registryClient(token, async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? new Response('', { status: 302, headers: { location: 'https://pkg-npm.githubusercontent.com/blobs/package?signed=opaque' } })
      : new Response(bytes);
  });
  assert.deepEqual(await client.archive(download), bytes);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(calls[0].options.signal, calls[1].options.signal);
  for (const address of ['http://npm.pkg.github.com/download/pkg', 'https://npm.pkg.github.com.evil.invalid/download/pkg', 'https://user:pass@npm.pkg.github.com/download/pkg', `${registry}/not-a-download`, 'https://pkg-npm.githubusercontent.com:444/blobs/pkg']) {
    await assert.rejects(client.archive(address), /Unsafe/u);
  }
  const huge = registryClient(token, async () => new Response('x', { headers: { 'content-length': String(50 * 1024 * 1024 + 1) } }));
  await assert.rejects(huge.archive(download), /failed/u);
  const missing = registryClient(token, async () => new Response('', { status: 404 }));
  await assert.rejects(missing.archive(download), /HTTP 404/u);
});

test('registry metadata must match exact package, stable version, SHA-512 and safe tarball origin', () => {
  const bytes = archive();
  assert.equal(validateRegistryPackage(metadata(bytes), version, bytes), download);
  for (const invalid of [null, [], {}, { ...metadata(), name: 'other' }, { ...metadata(), version: '0.1.3' },
    { ...metadata(), dist: { ...metadata().dist, integrity: 'sha256-incorrect' } },
    { ...metadata(), dist: { ...metadata().dist, integrity: hash(Buffer.from('other')) } },
    { ...metadata(), dist: { ...metadata().dist, tarball: 'https://attacker.invalid/pkg.tgz' } },
  ]) assert.throws(() => validateRegistryPackage(invalid, version, bytes));
});

test('new package publishes exact verified tgz without scripts, then performs real global-install registration probe', async (t) => {
  const { input, calls, cwd } = await fixture(t);
  assert.deepEqual(await publishPackage(input), { version, reused: false });
  assert.equal(calls.length, 3);
  const [publish, install, probe] = calls;
  assert.equal(publish.program, 'npm');
  assert.deepEqual(publish.args.slice(0, 5), ['publish', join(cwd, 'release', archiveFilename(version)), '--ignore-scripts', '--registry', registry]);
  assert.equal(install.program, 'npm');
  assert.deepEqual(install.args.slice(0, 3), ['install', '--global', `${packageName}@${version}`]);
  assert.ok(install.args.includes('--ignore-scripts=false'));
  assert.ok(install.args.includes('--omit=dev'));
  assert.equal(install.args[install.args.indexOf('--registry') + 1], registry);
  assert.equal(probe.program, process.execPath);
  assert.ok(calls.every(({ args, options }) => !args.join(' ').includes(token) && options.env.NODE_AUTH_TOKEN === token && options.cwd !== cwd && options.timeout === 120_000));
  assert.ok(install.options.env.npm_config_cache.startsWith(install.options.cwd));
  assert.notEqual(publish.args[publish.args.indexOf('--cache') + 1], install.args[install.args.indexOf('--cache') + 1]);
  await assert.rejects(readFile(probe.args.at(-2)), /ENOENT/u); // Isolated global installation is cleaned up.
});

test('matching existing version skips publication and still verifies downloaded bytes and global registry install', async (t) => {
  const { input, calls } = await fixture(t, { existing: true });
  assert.deepEqual(await publishPackage(input), { version, reused: true });
  assert.ok(calls.every(({ args }) => args[0] !== 'publish'));
  assert.equal(calls[0].args[0], 'install');
});

test('authentication, malformed metadata and conflicting version block publication without npm calls', async (t) => {
  for (const result of [new Error(token), undefined, {}, { ...metadata(), dist: { ...metadata().dist, integrity: 'sha512-invalid' } }]) {
    const { input, calls } = await fixture(t);
    input.client.metadata = async () => {
      if (result instanceof Error) throw result;
      return result;
    };
    await assert.rejects(publishPackage(input));
    assert.equal(calls.length, 0);
  }
});

test('postpublish integrity and tarball verification fail before global install', async (t) => {
  for (const fault of ['missing', 'metadata', 'tarball']) {
    const { input, calls } = await fixture(t);
    let count = 0;
    input.client.metadata = async () => ++count === 1 ? null : fault === 'missing' ? null : fault === 'metadata' ? {} : metadata();
    if (fault === 'tarball') input.client.archive = async () => Buffer.from('corrupted tarball');
    await assert.rejects(publishPackage(input), /integrity|tarball/u);
    assert.deepEqual(calls.map(({ args }) => args[0]), ['publish']);
  }
});

test('publish and global install subprocess failures are sanitized and prevent later steps', async (t) => {
  for (const failing of ['publish', 'install']) {
    const { input, calls } = await fixture(t);
    const original = input.run;
    input.run = async (...args) => {
      if (args[1][0] === failing) throw new Error(token);
      return original(...args);
    };
    await assert.rejects(publishPackage(input), noSecret);
    assert.equal(calls.some(({ program }) => program === process.execPath), false);
  }
});

test('source identity, archive identity and runtime dependency violations fail before publication', async (t) => {
  for (const details of [{ ...manifest, name: 'other' }, { ...manifest, dependencies: { typescript: '*' } }, { ...manifest, optionalDependencies: { other: '*' } }]) {
    const { input, calls } = await fixture(t, { details });
    await assert.rejects(publishPackage(input));
    assert.equal(calls.length, 0);
  }
  const { input, calls, cwd } = await fixture(t);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ ...manifest, publishConfig: { registry: 'https://registry.npmjs.org' } }));
  await assert.rejects(publishPackage(input), /registry/u);
  assert.equal(calls.length, 0);
});

test('installed package must contain exact identity, compiled entry and no runtime dependencies', async (t) => {
  for (const details of [{ ...manifest, version: '0.1.3' }, { ...manifest, main: 'src/index.ts' }, { ...manifest, dependencies: { other: '*' } }]) {
    const prefix = await temporary(t);
    await installed(prefix, details);
    await assert.rejects(verifyInstalledPackage(prefix, version));
  }
  const prefix = await temporary(t);
  const directory = await installed(prefix);
  await mkdir(join(directory, 'node_modules'));
  await assert.rejects(verifyInstalledPackage(prefix, version), /node_modules/u);
  await rm(join(directory, 'node_modules'), { recursive: true });
  await rm(join(directory, 'dist', 'index.js'));
  await assert.rejects(verifyInstalledPackage(prefix, version));
});

test('actual installed JavaScript must register the scoped plugin and unchanged platform alias', async (t) => {
  const { input } = await fixture(t, { runtime: 'export default () => {};' });
  await assert.rejects(publishPackage(input), /Homebridge registration/u);
});
