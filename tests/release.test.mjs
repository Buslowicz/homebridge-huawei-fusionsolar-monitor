import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { githubClient, planRelease, publishRelease, selectVersion, validateArchive } from '../.github/scripts/release.mjs';

const execute = promisify(execFile);
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const name = '@buslowicz/homebridge-huawei-fusionsolar-monitor';
const filename = 'buslowicz-homebridge-huawei-fusionsolar-monitor-0.1.2.tgz';
const repo = '/repos/example/monitor';
const env = { GITHUB_SHA: sha, GITHUB_REPOSITORY: 'example/monitor', RELEASE_TAG: 'v0.1.2', RELEASE_VERSION: '0.1.2' };
const hash = (data) => createHash('sha256').update(data).digest('hex');

function archive(version = '0.1.2', runtime = true) {
  const entries = [['package/package.json', JSON.stringify({ name, version })], ...(runtime ? [['package/dist/index.js', 'export default () => {};']] : [])];
  const blocks = [];
  for (const [path, content] of entries) {
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
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

async function fixture(t, data = archive()) {
  const cwd = await mkdtemp(join(tmpdir(), 'fusionsolar-release-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'release'));
  // Publication runs from a fresh source checkout whose version is intentionally older.
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name, version: '0.1.1' }));
  await writeFile(join(cwd, 'release', filename), data);
  return cwd;
}

function apiFixture({ draft, reference = sha, failUpload = false, badUpload = false, immutable = false } = {}) {
  const calls = [];
  let release = draft === undefined ? null : { id: 10, tag_name: 'v0.1.2', draft, prerelease: false, immutable };
  const bytes = archive();
  const sums = Buffer.from(`${hash(bytes)}  ${filename}\n`);
  let assets = draft === false ? [
    { id: 20, name: filename, size: bytes.length }, { id: 21, name: 'SHA256SUMS', size: sums.length },
  ] : draft ? [{ id: 22, name: filename, size: 1 }, { id: 23, name: 'unrelated.txt', size: 1 }] : [];
  const request = async (method, path, options = {}) => {
    calls.push({ method, path, ...options });
    if (method === 'GET' && path === `${repo}/git/ref/tags/v0.1.2`) return reference ? { object: { type: 'commit', sha: reference } } : null;
    if (method === 'POST' && path === `${repo}/git/refs`) return { object: { type: 'commit', sha } };
    if (method === 'GET' && path === `${repo}/releases/tags/v0.1.2`) return release?.draft ? null : release;
    if (method === 'GET' && path === `${repo}/releases?per_page=100&page=1`) return release ? [release] : [];
    if (method === 'POST' && path === `${repo}/releases`) return (release = { id: 10, ...options.body });
    if (method === 'GET' && path === `${repo}/releases/10/assets?per_page=100&page=1`) return assets;
    if (method === 'DELETE' && /\/releases\/assets\/\d+$/u.test(path)) {
      const id = Number(path.split('/').at(-1));
      assets = assets.filter((asset) => asset.id !== id);
      return null;
    }
    if (method === 'POST' && path.startsWith(`${repo}/releases/10/assets?`)) {
      if (failUpload) throw new Error('simulated upload failure');
      const asset = { id: 30 + assets.length, name: new URL(`https://uploads.github.com${path}`).searchParams.get('name'), size: options.bytes.length, state: 'uploaded', digest: `sha256:${badUpload ? '0'.repeat(64) : hash(options.bytes)}` };
      assets.push(asset);
      return asset;
    }
    if (method === 'PATCH' && path === `${repo}/releases/10`) return (release = { ...release, ...options.body });
    if (method === 'GET' && path === `${repo}/releases/assets/20`) return bytes;
    if (method === 'GET' && path === `${repo}/releases/assets/21`) return sums;
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return { request, calls, assets };
}

test('version selection starts from package base and monotonically increments the highest stable tag', () => {
  const select = (baseVersion, tags) => selectVersion({ baseVersion, commit: sha, tags });
  assert.equal(select('0.1.1', []), '0.1.1');
  assert.equal(select('0.1.1', [{ name: 'v0.1.9', sha: otherSha }]), '0.1.10');
  assert.equal(select('2.0.0', [{ name: 'v0.1.9', sha: otherSha }]), '2.0.0');
  assert.equal(select('0.1.1', [{ name: 'v9.2.7', sha: otherSha }, { name: 'v10.0.0-beta.1', sha }]), '9.2.8');
  assert.equal(select('0.1.1', [{ name: 'v0.1.1', sha }, { name: 'v0.1.2', sha }, { name: 'v1.0.0', sha: otherSha }]), '0.1.2');
});

test('version selection rejects unsafe or invalid inputs and ignores nonstable tag formats', () => {
  for (const baseVersion of ['1.01.0', 'v1.0.0', '1.0.0\n', '1.0.0-beta', '9007199254740992.0.0']) {
    assert.throws(() => selectVersion({ baseVersion, commit: sha, tags: [] }));
  }
  assert.throws(() => selectVersion({ baseVersion: '1.0.0', commit: 'bad', tags: [] }));
  assert.throws(() => selectVersion({ baseVersion: '1.0.0', commit: sha, tags: [{ name: 'v1.0.0', sha: 'bad' }] }));
  assert.throws(() => selectVersion({ baseVersion: '1.0.0', commit: sha, tags: [{ name: 'v1.0.9007199254740991', sha: otherSha }] }), /safely/u);
  assert.equal(selectVersion({ baseVersion: '1.0.0', commit: sha, tags: [{ name: 'v01.1.1', sha: 'ignored' }, { name: '1.2.3', sha: 'ignored' }] }), '1.0.0');
});

test('plan resolves actual annotated and lightweight tags, reuses same-commit versions, and refuses a different checkout', async (t) => {
  const cwd = await fixture(t);
  const git = async (...args) => (await execute('git', args, { cwd, timeout: 10_000 })).stdout.trim();
  await git('init', '--quiet', '--initial-branch=main');
  await git('add', '--', 'package.json');
  const message = join(cwd, 'message.txt');
  await writeFile(message, 'test: release fixture\n');
  const identity = ['-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'core.hooksPath=/dev/null'];
  await git(...identity, 'commit', '--quiet', '-F', message);
  const first = await git('rev-parse', 'HEAD');
  assert.deepEqual(await planRelease({ cwd, env: { GITHUB_SHA: first } }), { version: '0.1.1', tag: 'v0.1.1' });
  await git(...identity, 'tag', '-a', 'v0.1.5', '-F', message);
  await git('tag', 'v0.1.4');
  await git('tag', 'v99.0.0-beta');
  assert.equal((await planRelease({ cwd, env: { GITHUB_SHA: first } })).version, '0.1.5');
  await writeFile(join(cwd, 'second.txt'), 'second');
  await git('add', '--', 'second.txt');
  await git(...identity, 'commit', '--quiet', '-F', message);
  const second = await git('rev-parse', 'HEAD');
  assert.equal((await planRelease({ cwd, env: { GITHUB_SHA: second } })).version, '0.1.6');
  await assert.rejects(planRelease({ cwd, env: { GITHUB_SHA: first } }), /does not match/u);
});

test('archive validation checks gzip, tar integrity, manifest version and built runtime', () => {
  assert.doesNotThrow(() => validateArchive(archive(), '0.1.2'));
  assert.throws(() => validateArchive(Buffer.from('not an archive'), '0.1.2'), /gzip/u);
  assert.throws(() => validateArchive(archive('0.1.1'), '0.1.2'), /does not match/u);
  assert.throws(() => validateArchive(archive('0.1.2', false), '0.1.2'), /does not match/u);
  assert.throws(() => validateArchive(gzipSync(Buffer.alloc(512, 1)), '0.1.2'), /tar/u);
});

test('publisher reserves the exact tag, creates draft, uploads archive and checksum, then publishes latest', async (t) => {
  const cwd = await fixture(t);
  const api = apiFixture({ reference: null });
  const result = await publishRelease({ cwd, env, request: api.request });
  assert.equal(result.reused, false);
  assert.equal(result.url, 'https://github.com/example/monitor/releases/tag/v0.1.2');
  const mutations = api.calls.filter((call) => call.method !== 'GET');
  assert.deepEqual(mutations.map((call) => call.method), ['POST', 'POST', 'POST', 'POST', 'PATCH']);
  assert.deepEqual(mutations[0].body, { ref: 'refs/tags/v0.1.2', sha });
  assert.equal(mutations[1].body.draft, true);
  assert.equal(mutations[1].body.target_commitish, sha);
  assert.equal(mutations[2].upload, true);
  assert.equal(mutations[3].bytes.toString(), `${hash(archive())}  ${filename}\n`);
  assert.deepEqual(mutations[4].body, { draft: false, make_latest: 'true' });
  assert.equal(await readFile(join(cwd, 'release', 'SHA256SUMS'), 'utf8'), mutations[3].bytes.toString());
});

test('publisher resumes an unpublished draft replacing only its known assets', async (t) => {
  const cwd = await fixture(t);
  const api = apiFixture({ draft: true });
  await publishRelease({ cwd, env, request: api.request });
  assert.deepEqual(api.calls.filter(({ method }) => method === 'DELETE').map(({ path }) => path), [`${repo}/releases/assets/22`]);
  assert.equal(api.calls.some(({ method, path }) => method === 'POST' && path === `${repo}/releases`), false);
  assert.equal(api.calls.at(-1).method, 'PATCH');
});

test('publisher verifies immutable published archives and checksums without mutations', async (t) => {
  const cwd = await fixture(t);
  const api = apiFixture({ draft: false, immutable: true });
  const result = await publishRelease({ cwd, env, request: api.request });
  assert.equal(result.reused, true);
  assert.ok(api.calls.every(({ method }) => method === 'GET'));
  assert.equal(api.calls.filter(({ binary }) => binary).length, 2);
});

test('publisher refuses missing, size-mismatched or corrupted published assets without mutations', async (t) => {
  const cwd = await fixture(t);
  for (const fault of ['missing', 'size', 'content']) {
    const api = apiFixture({ draft: false });
    const request = async (method, path, options) => {
      const response = await api.request(method, path, options);
      if (fault === 'missing' && Array.isArray(response)) return response.filter((asset) => asset.name !== 'SHA256SUMS');
      if (fault === 'size' && Array.isArray(response)) return response.map((asset) => ({ ...asset, size: 1 }));
      if (fault === 'content' && options?.binary) return Buffer.from('corrupted');
      return response;
    };
    await assert.rejects(publishRelease({ cwd, env, request }), /Published release/u);
    assert.ok(api.calls.every(({ method }) => method === 'GET'));
  }
});

test('failed or unconfirmed uploads leave the release unpublished', async (t) => {
  const cwd = await fixture(t);
  for (const options of [{ failUpload: true }, { badUpload: true }]) {
    const api = apiFixture(options);
    await assert.rejects(publishRelease({ cwd, env, request: api.request }));
    assert.equal(api.calls.some(({ method }) => method === 'PATCH'), false);
  }
});

test('publisher never changes a tag on another commit and resolves annotated remote tags', async (t) => {
  const cwd = await fixture(t);
  const wrong = apiFixture({ reference: otherSha });
  await assert.rejects(publishRelease({ cwd, env, request: wrong.request }), /different commit/u);
  assert.ok(wrong.calls.every(({ method }) => method === 'GET'));
  const api = apiFixture();
  const request = async (method, path, options) => {
    if (path === `${repo}/git/ref/tags/v0.1.2`) return { object: { type: 'tag', sha: otherSha } };
    if (path === `${repo}/git/tags/${otherSha}`) return { object: { type: 'commit', sha } };
    return api.request(method, path, options);
  };
  assert.equal((await publishRelease({ cwd, env, request })).reused, false);
});

test('publisher rejects invalid inputs and stale artifacts before any API request', async (t) => {
  const cwd = await fixture(t);
  let requests = 0;
  const request = async () => { requests++; throw new Error('unexpected request'); };
  for (const overrides of [{ RELEASE_VERSION: '1.2.03' }, { RELEASE_TAG: 'v0.1.2\n' }, { GITHUB_SHA: 'bad' }, { GITHUB_REPOSITORY: 'example/monitor/../other' }]) {
    await assert.rejects(publishRelease({ cwd, env: { ...env, ...overrides }, request }));
  }
  await writeFile(join(cwd, 'release', filename), archive('0.1.1'));
  await assert.rejects(publishRelease({ cwd, env, request }), /does not match/u);
  assert.equal(requests, 0);
});

test('GitHub client distinguishes genuine missing resources from permission and network failures without leaking secrets', async () => {
  const token = 'secret-test-token';
  const route = `${repo}/git/ref/tags/v0.1.2`;
  const missing = githubClient(token, async () => new Response('', { status: 404 }));
  assert.equal(await missing('GET', route, { allow404: true }), null);
  for (const status of [401, 403, 409, 422, 500]) {
    const client = githubClient(token, async () => new Response(token, { status }));
    await assert.rejects(client('GET', route, { allow404: true }), (error) => error.message.includes(`HTTP ${status}`) && !String(error.stack).includes(token));
  }
  const client = githubClient(token, async () => { throw new Error(token); });
  await assert.rejects(client('GET', route), (error) => !String(error.stack).includes(token) && /request failed/u.test(error.message));
  assert.throws(() => githubClient(''), /GH_TOKEN/u);
});

test('GitHub client fixes API origins, supplies a timeout, and uploads exact bytes', async () => {
  const calls = [];
  const client = githubClient('token', async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await client('GET', `${repo}/releases`);
  const bytes = Buffer.from('payload');
  await client('POST', `${repo}/releases/10/assets?name=test`, { bytes, upload: true });
  assert.equal(calls[0].url, 'https://api.github.com/repos/example/monitor/releases');
  assert.equal(calls[1].url, 'https://uploads.github.com/repos/example/monitor/releases/10/assets?name=test');
  assert.equal(calls[1].body, bytes);
  assert.equal(calls[1].headers.Authorization, 'Bearer token');
  assert.ok(calls[0].signal instanceof AbortSignal);
});
