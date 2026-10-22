// Child process used by crash.test.ts: starts a download and reports progress on stdout
// until the parent kills it abruptly (no graceful shutdown).
import { DownloadManager } from '../../src/main/engine/manager';
import { SqliteStore } from '../../src/main/engine/store';
import type { DownloadView } from '../../src/shared/types';

const [dbFile, dir, url] = process.argv.slice(2);
const manager = new DownloadManager({
  store: new SqliteStore(dbFile),
  defaultSettings: { downloadDirectory: dir, maxConcurrent: 1, resumeOnStartup: true, ytDlpPath: '', autoMediaTools: true },
  progressIntervalMs: 50,
  persistIntervalMs: 100,
});
manager.init();
manager.on('changed', (v: DownloadView) => process.stdout.write(`BYTES ${v.downloadedBytes}\n`));
const d = manager.add({ url });
process.stdout.write(`ID ${d.id}\n`);
