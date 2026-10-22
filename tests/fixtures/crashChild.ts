// Child process used by crash.test.ts: starts a download and reports progress on stdout
// until the parent kills it abruptly (no graceful shutdown).
import { DownloadManager } from '../../src/main/engine/manager';
import { SqliteStore } from '../../src/main/engine/store';
import { SETTINGS_DEFAULTS, type DownloadView } from '../../src/shared/types';

const [dbFile, dir, url, connections] = process.argv.slice(2);
const manager = new DownloadManager({
  store: new SqliteStore(dbFile),
  defaultSettings: { ...SETTINGS_DEFAULTS, downloadDirectory: dir, maxConcurrent: 1, connections: Number(connections) || 1 },
  progressIntervalMs: 50,
  persistIntervalMs: 100,
  minSegmentBytes: 128 * 1024,
});
manager.init();
manager.on('changed', (v: DownloadView) => process.stdout.write(`BYTES ${v.downloadedBytes}\n`));
const d = manager.add({ url });
process.stdout.write(`ID ${d.id}\n`);
