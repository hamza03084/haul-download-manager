import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DownloadManager, type ManagerOptions } from '../../src/main/engine/manager';
import { SqliteStore } from '../../src/main/engine/store';
import { SETTINGS_DEFAULTS, type DownloadView } from '../../src/shared/types';

const created: string[] = [];
// Test folders are removed when the test process ends, so repeated runs do not fill up %TEMP%.
process.once('exit', () => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

export function tempDir(prefix = 'haul-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export interface Harness {
  manager: DownloadManager;
  dir: string;
  dbFile: string;
  events: DownloadView[];
}

export function createHarness(opts: Partial<ManagerOptions> & { dir?: string; dbFile?: string; maxConcurrent?: number } = {}): Harness {
  const dir = opts.dir ?? tempDir();
  const dbFile = opts.dbFile ?? path.join(dir, '.state', 'test.db');
  const manager = new DownloadManager({
    store: new SqliteStore(dbFile),
    defaultSettings: { ...SETTINGS_DEFAULTS, downloadDirectory: dir, maxConcurrent: opts.maxConcurrent ?? 3 },
    timeoutMs: 5_000,
    retryDelaysMs: [50, 100, 150],
    progressIntervalMs: 50,
    persistIntervalMs: 100,
    ...opts,
  });
  const events: DownloadView[] = [];
  manager.on('changed', (v: DownloadView) => events.push(v));
  manager.init();
  return { manager, dir, dbFile, events };
}

/** Resolves with the download once `pred` holds, rejecting after `timeoutMs`. */
export function waitFor(
  manager: DownloadManager,
  id: string,
  pred: (d: DownloadView) => boolean,
  timeoutMs = 15_000,
): Promise<DownloadView> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const d = manager.get(id);
      if (d && pred(d)) {
        cleanup();
        resolve(d);
        return true;
      }
      return false;
    };
    const onChange = (v: DownloadView) => {
      if (v.id === id) check();
    };
    const timer = setTimeout(() => {
      cleanup();
      const d = manager.get(id);
      reject(new Error(`timeout waiting for ${id}; state=${d?.state} bytes=${d?.downloadedBytes} error=${d?.error} notice=${d?.notice}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      manager.off('changed', onChange);
    };
    manager.on('changed', onChange);
    check();
  });
}

export const isState = (...states: DownloadView['state'][]) => (d: DownloadView) => states.includes(d.state);
