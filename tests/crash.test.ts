import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TestServer, randomBody } from './helpers/testServer';
import { createHarness, isState, tempDir, waitFor } from './helpers/harness';
import { SqliteStore } from '../src/main/engine/store';
import { sumDone } from '../src/main/engine/segments';

for (const connections of [1, 4]) {
test(`recovers a download after the process is killed mid-transfer (${connections} connection${connections > 1 ? 's' : ''})`, async () => {
  const server = new TestServer();
  await server.start();
  const body = randomBody(4 * 1024 * 1024);
  server.route('/crash/big.bin', { body, etag: '"c1"', delayMs: 15, chunkSize: 32 * 1024 });
  const dir = tempDir();
  const dbFile = path.join(dir, '.state', 'crash.db');

  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'crashChild.js'), dbFile, dir, server.url('/crash/big.bin'), String(connections)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let id = '';
  // Kill once the child is well past its first durable checkpoint (with several connections,
  // 600 KB can arrive before the first checkpoint has even been written).
  const storedBytes = () => {
    try {
      const peek = new SqliteStore(dbFile);
      const n = peek.loadAll().find((r) => r.id === id)?.downloadedBytes ?? 0;
      peek.close();
      return n;
    } catch {
      return 0;
    }
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child made no progress')), 20_000);
    let buf = '';
    let done = false;
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      for (const line of buf.split('\n')) {
        if (line.startsWith('ID ')) id = line.slice(3).trim();
        if (!done && id && line.startsWith('BYTES ') && Number(line.slice(6)) > 600_000 && storedBytes() > 0) {
          done = true;
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
  if (connections > 1) {
    assert.ok(stored.segments && stored.segments.length >= 2, 'parts were recorded');
    assert.equal(checkpoint, sumDone(stored.segments!));
    const onDisk = fs.readFileSync(part);
    for (const s of stored.segments!) assert.ok(onDisk.subarray(s.start, s.start + s.done).equals(body.subarray(s.start, s.start + s.done)), `checkpoint of part ${s.start} is really on disk`);
  }

  server.route('/crash/big.bin', { body, etag: '"c1"' });
  const requestsBefore = server.requestsFor('/crash/big.bin').length;
  const h = createHarness({ dir, dbFile, connections, minSegmentBytes: 128 * 1024 });
  const recovered = h.manager.get(id)!;
  assert.ok(recovered, 'record survived the crash');
  assert.match(recovered.notice ?? '', /closed while this was downloading/);
  const done = await waitFor(h.manager, id, isState('completed', 'failed'));
  assert.equal(done.state, 'completed', done.error ?? '');
  assert.ok(fs.readFileSync(path.join(dir, 'big.bin')).equals(body), 'recovered file is byte-identical');
  const reqs = server.requestsFor('/crash/big.bin');
  if (connections === 1) assert.equal(reqs[reqs.length - 1].headers.range, `bytes=${checkpoint}-`, 'continued from the last durable checkpoint');
  else {
    const ranges = reqs.slice(requestsBefore).map((r) => String(r.headers.range));
    for (const s of stored.segments!.filter((x) => x.done < x.end - x.start)) {
      assert.ok(ranges.some((r) => r.startsWith(`bytes=${s.start + s.done}-`)), `part ${s.start} continued from its checkpoint ${s.start + s.done}: ${ranges.join(', ')}`);
    }
  }
  await h.manager.shutdown();
  await server.close();
});
}
