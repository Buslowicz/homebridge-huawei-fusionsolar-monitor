import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { archiveFilename, packageName, validateArchive } from './release.mjs';

const execute = promisify(execFile);
export const registry = 'https://npm.pkg.github.com';
const maxArchive = 50 * 1024 * 1024;
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const downloadOrigins = new Set([registry, 'https://pkg-npm.githubusercontent.com', 'https://github-registry-files.githubusercontent.com']);

function safeUrl(value, metadata = false) {
  let url;
  try { url = new globalThis.URL(value); } catch { throw new Error('Invalid package registry URL'); }
  if (url.username || url.password || url.hash || !(metadata ? url.origin === registry : downloadOrigins.has(url.origin))) throw new Error('Unsafe package registry origin');
  if (!metadata && url.origin === registry && !url.pathname.startsWith('/download/')) throw new Error('Unsafe package tarball path');
  return url;
}

/** A missing package/version is distinct from authentication, transport and metadata failures. */
export function registryClient(token, fetcher = fetch) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('NODE_AUTH_TOKEN is required for package publication');
  const get = async (address, { metadata = false, allow404 = false } = {}) => {
    let url = safeUrl(address, metadata);
    const signal = AbortSignal.timeout(30_000);
    let response;
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        response = await fetcher(url.href, {
          redirect: 'manual', signal,
          headers: {
            Accept: metadata ? 'application/json' : 'application/octet-stream',
            ...(url.origin === registry ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          if (redirects === 3) throw new Error('Redirect limit');
          const target = response.headers.get('location');
          if (!target) throw new Error('Missing redirect');
          url = safeUrl(new globalThis.URL(target, url).href, metadata);
          continue;
        }
        if (response.status === 404 && allow404) {
          await response.body?.cancel();
          return null;
        }
        if (!response.ok) throw new Error('Registry response failure');
        const limit = metadata ? 8 * 1024 * 1024 : maxArchive;
        const length = response.headers.get('content-length');
        if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) throw new Error('Response exceeds limit');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty response');
        const chunks = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > limit) throw new Error('Response exceeds limit');
            chunks.push(value);
          }
        } finally { await reader.cancel(); }
        const bytes = Buffer.concat(chunks, size);
        return metadata ? JSON.parse(bytes.toString('utf8')) : bytes;
      }
    } catch {
      // Remote bodies, signed download URLs, subprocess output and credentials never reach logs.
      const status = response && !response.ok && ![301, 302, 303, 307, 308].includes(response.status) ? ` HTTP ${response.status}` : '';
      throw new Error(`Package registry request failed${status}`, { cause: undefined });
    }
  };
  return {
    metadata: async (version) => {
      archiveFilename(version);
      // npm clients select exact versions from this supported package document endpoint.
      const document = await get(`${registry}/${encodeURIComponent(packageName)}`, { metadata: true, allow404: true });
      if (document === null) return null;
      if (!document || typeof document !== 'object' || Array.isArray(document) || document.name !== packageName
        || !document.versions || typeof document.versions !== 'object' || Array.isArray(document.versions)) throw new Error('Invalid package registry version document');
      if (!Object.hasOwn(document.versions, version)) return null;
      const selected = document.versions[version];
      if (!selected || typeof selected !== 'object' || Array.isArray(selected)) throw new Error('Invalid package registry selected version');
      return selected;
    },
    archive: (url) => get(url),
  };
}

export function validateRegistryPackage(metadata, version, bytes) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || metadata.name !== packageName || metadata.version !== version
    || typeof metadata.dist?.integrity !== 'string' || metadata.dist.integrity !== integrity(bytes)
    || typeof metadata.dist.tarball !== 'string') throw new Error('Published package identity, version or SHA-512 integrity differs from the verified archive');
  safeUrl(metadata.dist.tarball);
  return metadata.dist.tarball;
}

function requireNoRuntimeDependencies(manifest) {
  for (const key of ['dependencies', 'optionalDependencies']) {
    if (manifest[key] !== undefined && (!manifest[key] || typeof manifest[key] !== 'object' || Array.isArray(manifest[key]) || Object.keys(manifest[key]).length)) throw new Error('Published plugin must not require installed runtime dependencies');
  }
  if ((manifest.bundledDependencies && manifest.bundledDependencies.length) || (manifest.bundleDependencies && manifest.bundleDependencies.length)) throw new Error('Published plugin must not bundle runtime dependencies');
}

export async function verifyInstalledPackage(prefix, version) {
  const directory = join(prefix, 'lib', 'node_modules', ...packageName.split('/'));
  let manifest;
  try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); } catch { throw new Error('Registry global install has no valid package manifest'); }
  if (manifest?.name !== packageName || manifest.version !== version || manifest.main !== 'dist/index.js') throw new Error('Registry global install has incorrect package identity, version or entry point');
  requireNoRuntimeDependencies(manifest);
  const entry = join(directory, 'dist', 'index.js');
  if (!(await stat(entry)).isFile()) throw new Error('Registry global install is missing its built entry point');
  try {
    await lstat(join(directory, 'node_modules'));
  } catch (error) {
    if (error?.code === 'ENOENT') return entry;
    throw new Error('Unable to verify installed runtime dependency boundary', { cause: error });
  }
  throw new Error('Registry global install unexpectedly contains runtime node_modules');
}

const registrationProbe = `
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { default: register } = await import(pathToFileURL(process.argv[1]).href);
assert.equal(typeof register, 'function');
const calls = [];
register({ registerPlatform: (...args) => calls.push(args) });
assert.equal(calls.length, 1);
assert.equal(calls[0][0], process.argv[2]);
assert.equal(calls[0][1], 'HuaweiFusionSolarMonitor');
assert.equal(typeof calls[0][2], 'function');
`;

export async function publishPackage({ cwd = process.cwd(), env = process.env, client, run = execute } = {}) {
  const version = env.RELEASE_VERSION;
  const filename = archiveFilename(version);
  const source = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  if (source.name !== packageName || source.publishConfig?.registry !== registry) throw new Error('Source package identity or publication registry is incorrect');
  const archivePath = join(cwd, 'release', filename);
  const file = await stat(archivePath);
  if (!file.isFile() || file.size < 3 || file.size > maxArchive) throw new Error('Unsafe package archive size');
  const bytes = await readFile(archivePath);
  requireNoRuntimeDependencies(validateArchive(bytes, version));
  const api = client ?? registryClient(env.NODE_AUTH_TOKEN);
  const existing = await api.metadata(version);
  const reused = existing !== null;
  if (reused) validateRegistryPackage(existing, version, bytes);
  const temporary = await mkdtemp(join(tmpdir(), 'fusionsolar-registry-'));
  try {
    const cache = join(temporary, 'install-cache');
    const publishCache = join(temporary, 'publish-cache');
    const prefix = join(temporary, 'prefix');
    await mkdir(cache);
    const options = { cwd: temporary, timeout: 120_000, maxBuffer: 1024 * 1024, env: {
      ...env,
      npm_config_cache: cache,
      npm_config_fetch_retries: '0',
      npm_config_fetch_timeout: '30000',
      npm_config_update_notifier: 'false',
    } };
    const command = async (program, args, description) => {
      try { return await run(program, args, options); } catch { throw new Error(description, { cause: undefined }); }
    };
    if (!reused) await command('npm', ['publish', archivePath, '--ignore-scripts', '--registry', registry, '--cache', publishCache, '--no-audit', '--no-fund'], 'Publishing the verified package archive failed');
    const published = await api.metadata(version);
    const tarball = validateRegistryPackage(published, version, bytes);
    const downloaded = await api.archive(tarball);
    if (!Buffer.isBuffer(downloaded) || integrity(downloaded) !== integrity(bytes)) throw new Error('Registry tarball differs from the verified package archive');
    // Install from the real registry with lifecycle scripts enabled and an empty global prefix/cache.
    await command('npm', ['install', '--global', `${packageName}@${version}`, '--prefix', prefix, '--cache', cache, '--registry', registry, '--omit=dev', '--ignore-scripts=false', '--no-audit', '--no-fund'], 'Global registry package installation failed');
    const entry = await verifyInstalledPackage(prefix, version);
    await command(process.execPath, ['--input-type=module', '--eval', registrationProbe, entry, packageName], 'Globally installed plugin failed Homebridge registration');
    return { version, reused };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  publishPackage().then(({ version, reused }) => {
    console.log(`GitHub Packages ${reused ? 'verified' : 'published'}: ${packageName}@${version}; global registry install and Homebridge registration passed`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Package publication failed');
    process.exitCode = 1;
  });
}
