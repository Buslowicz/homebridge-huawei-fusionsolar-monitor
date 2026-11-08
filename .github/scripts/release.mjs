import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const execute = promisify(execFile);
const packageName = 'homebridge-huawei-fusionsolar-monitor';
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const shaPattern = /^[a-f0-9]{40}$/u;
const digest = (data) => createHash('sha256').update(data).digest('hex');

function parts(version) {
  if (typeof version !== 'string' || !stable.test(version)) throw new Error('Invalid stable release version');
  const result = version.split('.').map(Number);
  if (!result.every(Number.isSafeInteger)) throw new Error('Release version exceeds safe integer bounds');
  return result;
}

function compare(left, right) {
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

function requireSha(sha) {
  if (typeof sha !== 'string' || !shaPattern.test(sha)) throw new Error('Invalid release commit SHA');
  return sha;
}

/** Select an immutable version from stable tags resolved to their commit SHAs. */
export function selectVersion({ baseVersion, commit, tags }) {
  parts(baseVersion);
  requireSha(commit);
  const versions = tags.filter(({ name }) => typeof name === 'string' && /^v/u.test(name) && stable.test(name.slice(1)))
    .map(({ name, sha }) => ({ version: name.slice(1), sha: requireSha(sha) }));
  for (const { version } of versions) parts(version);
  versions.sort((a, b) => compare(b.version, a.version));
  const existing = versions.find(({ sha }) => sha === commit);
  if (existing) return existing.version;
  if (!versions.length) return baseVersion;
  const highest = parts(versions[0].version);
  if (highest[2] === Number.MAX_SAFE_INTEGER) throw new Error('Cannot increment release patch version safely');
  highest[2]++;
  const next = highest.join('.');
  return compare(baseVersion, next) > 0 ? baseVersion : next;
}

export async function planRelease({ cwd = process.cwd(), env = process.env } = {}) {
  const commit = requireSha(env.GITHUB_SHA);
  const git = async (args) => (await execute('git', args, { cwd, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
  if (await git(['rev-parse', 'HEAD']) !== commit) throw new Error('Checked out commit does not match GITHUB_SHA');
  const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  const names = (await git(['tag', '--list'])).split('\n').filter((name) => /^v/u.test(name) && stable.test(name.slice(1)));
  if (names.length > 10_000) throw new Error('Too many release tags to plan safely');
  const tags = [];
  for (const name of names) tags.push({ name, sha: await git(['rev-parse', `refs/tags/${name}^{commit}`]) });
  const version = selectVersion({ baseVersion: manifest.version, commit, tags });
  return { version, tag: `v${version}` };
}

function identifier(value, description) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid GitHub ${description} identifier`);
  return value;
}

export function githubClient(token, fetcher = fetch) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('GH_TOKEN is required for release publication');
  return async (method, route, { body, bytes, binary = false, upload = false, allow404 = false } = {}) => {
    const origin = upload ? 'https://uploads.github.com' : 'https://api.github.com';
    if (!route.startsWith('/repos/') || /[\r\n]/u.test(route)) throw new Error('Invalid GitHub API route');
    let response;
    try {
      response = await fetcher(`${origin}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'fusionsolar-release',
          ...(bytes ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: bytes ?? (body ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404 && allow404) return null;
      if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
      if (response.status === 204) return null;
      return binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
    } catch {
      // Do not expose response bodies, request headers, remote errors or credentials.
      const status = response && !response.ok ? ` HTTP ${response.status}` : '';
      throw new Error(`GitHub ${method} request failed${status} for ${route.split('?')[0]}`, { cause: undefined });
    }
  };
}

async function resolveRemoteTag(request, repo, object) {
  for (let depth = 0; depth < 8; depth++) {
    if (!object || typeof object !== 'object') throw new Error('Invalid GitHub tag object');
    const sha = requireSha(object.sha);
    if (object.type === 'commit') return sha;
    if (object.type !== 'tag') throw new Error('Release tag does not resolve to a commit');
    const tag = await request('GET', `${repo}/git/tags/${sha}`);
    object = tag?.object;
  }
  throw new Error('Release tag nesting exceeds safe limit');
}

async function findRelease(request, repo, tag) {
  const release = await request('GET', `${repo}/releases/tags/${tag}`, { allow404: true });
  if (release) return release;
  // Drafts are not guaranteed to be returned by the published release-by-tag endpoint.
  for (let page = 1; page <= 100; page++) {
    const releases = await request('GET', `${repo}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases)) throw new Error('Invalid GitHub releases response');
    const matches = releases.filter((entry) => entry.tag_name === tag);
    if (matches.length > 1) throw new Error('Multiple releases use the selected tag');
    if (matches.length) return matches[0];
    if (releases.length < 100) return null;
  }
  throw new Error('Release list exceeds safe pagination limit');
}

async function assetsFor(request, repo, releaseId) {
  const assets = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await request('GET', `${repo}/releases/${releaseId}/assets?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Invalid GitHub assets response');
    assets.push(...batch);
    if (batch.length < 100) return assets;
  }
  throw new Error('Release assets exceed safe pagination limit');
}

export function validateArchive(archive, version) {
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 }); } catch { throw new Error('Release archive is not valid bounded gzip data'); }
  let manifest;
  let runtime = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
    const octal = (start, length) => {
      const value = field(start, length).trim();
      if (!/^[0-7]+$/u.test(value)) throw new Error('Release archive has invalid tar metadata');
      const number = Number.parseInt(value, 8);
      if (!Number.isSafeInteger(number)) throw new Error('Release archive tar value exceeds safe bounds');
      return number;
    };
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (octal(148, 8) !== checksum) throw new Error('Release archive tar checksum is invalid');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const size = octal(124, 12);
    const type = field(156, 1);
    if (offset + 512 + size > tar.length) throw new Error('Release archive has truncated tar data');
    if (name === 'package/package.json') {
      if (manifest || !['', '0'].includes(type) || size > 1024 * 1024) throw new Error('Release archive has invalid package manifest');
      try { manifest = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString('utf8')); } catch { throw new Error('Release archive package manifest is invalid JSON'); }
    }
    if (name === 'package/dist/index.js' && ['', '0'].includes(type) && size > 0) runtime = true;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!manifest || manifest.name !== packageName || manifest.version !== version || !runtime) throw new Error('Release archive package identity, version or built runtime does not match release');
}

export async function publishRelease({ cwd = process.cwd(), env = process.env, request } = {}) {
  const version = env.RELEASE_VERSION;
  parts(version);
  if (env.RELEASE_TAG !== `v${version}`) throw new Error('Release tag does not match version');
  const tag = env.RELEASE_TAG;
  const commit = requireSha(env.GITHUB_SHA);
  const repository = env.GITHUB_REPOSITORY;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(repository)) throw new Error('Invalid GitHub repository');
  const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  if (manifest.name !== packageName) throw new Error('Source package identity does not match release');
  const filename = `${packageName}-${version}.tgz`;
  const archivePath = join(cwd, 'release', filename);
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile() || archiveStat.size < 3 || archiveStat.size > 50 * 1024 * 1024) throw new Error('Release archive is missing or has an unsafe size');
  const archive = await readFile(archivePath);
  validateArchive(archive, version);
  const checksums = Buffer.from(`${digest(archive)}  ${filename}\n`);
  await writeFile(join(cwd, 'release', 'SHA256SUMS'), checksums);
  const expected = new Map([[filename, archive], ['SHA256SUMS', checksums]]);
  const api = request ?? githubClient(env.GH_TOKEN);
  const repo = `/repos/${repository}`;
  const reference = await api('GET', `${repo}/git/ref/tags/${tag}`, { allow404: true });
  if (reference) {
    if (await resolveRemoteTag(api, repo, reference.object) !== commit) throw new Error('Release tag already points to a different commit');
  } else {
    await api('POST', `${repo}/git/refs`, { body: { ref: `refs/tags/${tag}`, sha: commit } });
  }
  let release = await findRelease(api, repo, tag);
  if (!release) {
    release = await api('POST', `${repo}/releases`, { body: {
      tag_name: tag, target_commitish: commit, name: tag, draft: true, prerelease: false,
      body: `Verified Homebridge package from commit ${commit}.\n\nInstall the attached ${filename} archive. SHA256SUMS contains its SHA-256 checksum.\n\nSource: https://github.com/${repository}/tree/${commit}`,
    } });
  }
  const releaseId = identifier(release.id, 'release');
  if (release.tag_name !== tag || typeof release.draft !== 'boolean' || release.prerelease !== false) throw new Error('GitHub release metadata does not match stable release');
  const assets = await assetsFor(api, repo, releaseId);
  if (!release.draft) {
    for (const [name, bytes] of expected) {
      const matching = assets.filter((asset) => asset.name === name);
      if (matching.length !== 1) throw new Error(`Published release has missing or duplicate asset: ${name}`);
      const asset = matching[0];
      const id = identifier(asset.id, 'asset');
      if (asset.size !== bytes.length) throw new Error(`Published release asset differs: ${name}`);
      const existing = await api('GET', `${repo}/releases/assets/${id}`, { binary: true });
      if (!Buffer.isBuffer(existing) || digest(existing) !== digest(bytes)) throw new Error(`Published release asset differs: ${name}`);
    }
    return { version, tag, url: `https://github.com/${repository}/releases/tag/${tag}`, reused: true };
  }
  for (const [name, bytes] of expected) {
    for (const asset of assets.filter((entry) => entry.name === name)) {
      await api('DELETE', `${repo}/releases/assets/${identifier(asset.id, 'asset')}`);
    }
    const uploaded = await api('POST', `${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, { bytes, upload: true });
    if (uploaded?.name !== name || uploaded?.size !== bytes.length || uploaded?.state !== 'uploaded') throw new Error(`GitHub did not confirm uploaded asset: ${name}`);
    if (uploaded.digest && uploaded.digest !== `sha256:${digest(bytes)}`) throw new Error(`Uploaded asset checksum differs: ${name}`);
  }
  const published = await api('PATCH', `${repo}/releases/${releaseId}`, { body: { draft: false, make_latest: 'true' } });
  if (published?.draft !== false || published?.tag_name !== tag) throw new Error('GitHub did not confirm release publication');
  return { version, tag, url: `https://github.com/${repository}/releases/tag/${tag}`, reused: false };
}

async function main() {
  if (process.argv[2] === 'plan') {
    const { version, tag } = await planRelease();
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`);
    console.log(`Release plan: ${tag}`);
  } else if (process.argv[2] === 'publish') {
    const result = await publishRelease();
    console.log(`Release ${result.reused ? 'verified' : 'published'}: ${result.url}`);
  } else throw new Error('Usage: release.mjs plan|publish');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Release command failed');
    process.exitCode = 1;
  });
}
