import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Size of a file in bytes, or null when it does not exist. */
export async function fileSize(file: string): Promise<number | null> {
  try {
    return (await fsp.stat(file)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export function fileSizeSync(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

export async function removeIfExists(file: string): Promise<void> {
  await fsp.rm(file, { force: true });
}

/** Free bytes available to the current user on the volume containing `dir`, or null if unknown. */
export async function freeSpace(dir: string): Promise<number | null> {
  try {
    const s = await fsp.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Renames a file, retrying for a few seconds on Windows sharing violations
 * (antivirus scanners and indexers often hold freshly written files briefly).
 */
export async function renameWithRetry(from: string, to: string, attempts = 12): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_RENAME_CODES.has(code) || i >= attempts - 1) throw e;
      await delay(Math.min(100 * 2 ** i, 1000));
    }
  }
}

export function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}
