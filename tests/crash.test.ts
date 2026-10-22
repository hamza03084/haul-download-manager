import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TestServer, randomBody } from './helpers/testServer';
import { createHarness, isState, tempDir, waitFor } from './helpers/harness';
import { SqliteStore } from '../src/main/engine/store';

test('recovers a download after the process is killed mid-transfer', async () => {
  const server = new TestServer();
  await server.start();
  const body = randomBody(4 * 1024 * 1024);
  server.route('/crash/big.bin', { body, etag: '"c1"', delayMs: 15, chunkSize: 32 * 1024 });
  const dir = tempDir();
  const dbFile = path.join(dir, '.state', 'crash.db');

  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'crashChild.js'), dbFile, dir, server.url('/crash/big.bin')], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let id = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child made no progress')), 15_000);
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      for (const line of buf.split('\n')) {
        if (line.startsWith('ID ')) id = line.slice(3).trim();
        if (line.startsWith('BYTES ') && Number(line.slice(6)) > 600_000) {
          clearTimeout(timer);
          resolve();
        }
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
  });
  child.kill('SIGKILL'); // TerminateProcess on Windows: no cleanup code runs
  await new Promise((r) => child.once('exit', r));
  assert.ok(id, 'child reported the download id');

  const part = path.join(dir, 'big.bin.haulpart');
  const partSize = fs.statSync(part).size;
  assert.ok(partSize > 0 && partSize < body.length, `partial size ${partSize}`);

  // The stored progress of a running download is its last durable checkpoint, never ahead of the disk.
  const peek = new SqliteStore(dbFile);
  const stored = peek.loadAll().find((r) => r.id === id)!;
  peek.close();
  assert.equal(stored.state, 'downloading');
  const checkpoint = stored.downloadedBytes;
  assert.ok(checkpoint > 0 && checkpoint <= partSize, `checkpoint ${checkpoint} vs partial ${partSize}`);

  server.route('/crash/big.bin', { body, etag: '"c1"' });
  const h = createHarness({ dir, dbFile });
  const recovered = h.manager.get(id)!;
  assert.ok(recovered, 'record survived the crash');
  assert.match(recovered.notice ?? '', /closed while this was downloading/);
  const done = await waitFor(h.manager, id, isState('completed', 'failed'));
  assert.equal(done.state, 'completed', done.error ?? '');
  assert.ok(fs.readFileSync(path.join(dir, 'big.bin')).equals(body), 'recovered file is byte-identical');
  const reqs = server.requestsFor('/crash/big.bin');
  assert.equal(reqs[reqs.length - 1].headers.range, `bytes=${checkpoint}-`, 'continued from the last durable checkpoint');
  await h.manager.shutdown();
  await server.close();
});
