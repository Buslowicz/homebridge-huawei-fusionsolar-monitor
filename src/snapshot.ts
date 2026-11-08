import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Fixed storage location, owner-only files, no arbitrary paths or HTTP server. */
export async function writeSnapshot(storagePath: string, instanceId: string, value: unknown): Promise<void> {
  if (!/^[a-f0-9]{16}$/u.test(instanceId)) {
    throw new Error('Invalid snapshot instance identifier.');
  }
  const directory = join(storagePath, 'huawei-fusionsolar-monitor');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${instanceId}.json`);
  const temporary = join(directory, `${instanceId}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
