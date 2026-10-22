// Tests for downloading one file with several connections (1.4).
import { after, before, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TestServer, randomBody } from './helpers/testServer';
import { createHarness, isState, tempDir, waitFor } from './helpers/harness';
import { SqliteStore } from '../src/main/engine/store';
import { contiguousPrefix, planSegments, sumDone, validSegments } from '../src/main/engine/segments';
import { rangeHeader } from '../src/main/engine/multipart';
import { validateSettings } from '../src/main/engine/manager';
import { ValidationError } from '../src/main/engine/urls';
import type { DownloadRecord, DownloadView } from '../src/shared/types';

const KB = 1024;
const MB = 1024 * KB;
/** Small parts so a few MB are enough to exercise splitting. */
const SEG = 128 * KB;
let server: TestServer;

before(async () => {
  server = new TestServer();
  await server.start();
});
after(async () => {
  await server.close();
});

const read = (d: DownloadView) => fs.readFileSync(path.join(d.directory, d.fileName));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const harness = (opts: Parameters<typeof createHarness>[0] = {}) => createHarness({ connections: 4, minSegmentBytes: SEG, ...opts });
const rangesOf = (p: string) => server.requestsFor(p).map((r) => String(r.headers.range ?? '')).filter(Boolean);

describe('planning the parts', () => {
  test('a file is cut into equal parts of at least the minimum size; a prefix already on disk is kept', () => {
    assert.deepEqual(planSegments(0, 10 * MB, 4, MB).map((s) => [s.start, s.end, s.done]), [
      [0, 2.5 * MB, 0],
      [2.5 * MB, 5 * MB, 0],
      [5 * MB, 7.5 * MB, 0],
      [7.5 * MB, 10 * MB, 0],
    ]);
    assert.equal(planSegments(0, 3 * MB, 8, MB).length, 3, 'never smaller than the minimum');
    assert.equal(planSegments(0, 100, 8, MB).length, 1, 'a tiny file is one part');
    const resumed = planSegments(MB, 4 * MB, 3, MB);
    assert.deepEqual(resumed[0], { start: 0, end: MB, done: MB });
    assert.equal(resumed.length, 4);
    assert.equal(resumed[resumed.length - 1].end, 4 * MB);
    assert.ok(validSegments(resumed, 4 * MB));
    assert.ok(!validSegments([{ start: 0, end: 10, done: 0 }, { start: 12, end: 20, done: 0 }], 20), 'gaps are invalid');
    assert.ok(!validSegments([{ start: 0, end: 10, done: 11 }], 10), 'done beyond the part is invalid');
    assert.equal(sumDone(resumed), MB);
    assert.equal(contiguousPrefix([{ start: 0, end: 10, done: 10 }, { start: 10, end: 20, done: 3 }, { start: 20, end: 30, done: 10 }]), 13);
    assert.equal(rangeHeader({ start: 10, end: 20, done: 3 }, 30), 'bytes=13-19');
    assert.equal(rangeHeader({ start: 20, end: 30, done: 0 }, 30), 'bytes=20-', 'the last part asks open-ended, like a plain resume');
  });

  test('the connections setting is validated and defaults for settings saved by older versions', () => {
    const base = { downloadDirectory: 'C:\\dl', maxConcurrent: 3, resumeOnStartup: true };
    assert.equal(validateSettings(base).connections, 4);
    assert.equal(validateSettings({ ...base, connections: 8 }).connections, 8);
    for (const bad of [0, 17, 2.5, 'four']) assert.throws(() => validateSettings({ ...base, connections: bad }), ValidationError, String(bad));
  });
});

describe('downloading in parts', () => {
  test('a big file is fetched by several connections at once and is byte-identical', async () => {
    const body = randomBody(3 * MB);
    server.route('/mp/big.bin', { body, etag: '"big"', delayMs: 15, chunkSize: 32 * KB });
    const h = harness();
    const d = h.manager.add({ url: server.url('/mp/big.bin') });
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    assert.equal(done.segments, null, 'nothing to keep once finished');
    const reqs = server.requestsFor('/mp/big.bin');
    assert.ok(reqs.length >= 4, `${reqs.length} requests`);
    assert.ok(reqs.some((r) => r.concurrent >= 3), 'at least four responses were in flight together');
    assert.equal(reqs[0].headers.range, undefined, 'the first request asks for the whole file (it also tells the size)');
    assert.ok(rangesOf('/mp/big.bin').every((r) => /^bytes=\d+-\d*$/.test(r)));
    const peak = Math.max(...h.events.filter((e) => e.id === d.id).map((e) => e.connections));
    assert.equal(peak, 4, 'the card saw 4 connections');
    const progress = h.events.filter((e) => e.id === d.id && e.state === 'downloading').map((e) => e.downloadedBytes);
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1], 'progress never goes backwards');
    assert.ok(h.events.some((e) => e.id === d.id && e.speed > 0));
    await h.manager.shutdown();
  });

  test('small files, servers without ranges and the 1-connection setting stay on one connection', async () => {
    const small = randomBody(100 * KB);
    const noRanges = randomBody(2 * MB);
    const big = randomBody(2 * MB);
    server.route('/mp/small.bin', { body: small, etag: '"s"' });
    server.route('/mp/noranges.bin', { body: noRanges, ranges: false, headers: { 'Accept-Ranges': 'none' } });
    server.route('/mp/one.bin', { body: big, etag: '"o"' });
    const h = harness();
    const a = h.manager.add({ url: server.url('/mp/small.bin') });
    const b = h.manager.add({ url: server.url('/mp/noranges.bin') });
    await waitFor(h.manager, a.id, isState('completed'));
    await waitFor(h.manager, b.id, isState('completed'));
    assert.equal(server.requestsFor('/mp/small.bin').length, 1);
    assert.equal(server.requestsFor('/mp/noranges.bin').length, 1);
    h.manager.updateSettings({ ...h.manager.getSettings(), connections: 1 });
    const c = h.manager.add({ url: server.url('/mp/one.bin') });
    const cd = await waitFor(h.manager, c.id, isState('completed'));
    assert.equal(server.requestsFor('/mp/one.bin').length, 1);
    assert.ok(read(cd).equals(big));
    await h.manager.shutdown();
  });

  test('a server that does not advertise ranges but honours them is still downloaded in parts', async () => {
    const body = randomBody(2 * MB);
    server.route('/mp/quiet.bin', { body, etag: '"q"', advertiseRanges: false, delayMs: 5, chunkSize: 32 * KB });
    const h = harness();
    const d = h.manager.add({ url: server.url('/mp/quiet.bin') });
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    assert.ok(server.requestsFor('/mp/quiet.bin').length >= 3, 'ranges were tried and worked');
    await h.manager.shutdown();
  });

  test('a server that ignores Range requests (sends the whole file) makes the download fall back to one connection', async () => {
    const body = randomBody(2 * MB);
    server.route('/mp/ignores.bin', { body, ranges: false, delayMs: 5, chunkSize: 32 * KB });
    const h = harness();
    const d = h.manager.add({ url: server.url('/mp/ignores.bin') });
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body), 'the file is intact after the fallback');
    assert.equal(done.resumable, false, 'learned that this server cannot serve parts');
    assert.equal(fs.readdirSync(h.dir).filter((f) => f.endsWith('.haulpart')).length, 0);
    await h.manager.shutdown();
  });

  test('pause keeps every part, resume continues each from its own position with If-Range', async () => {
    const body = randomBody(4 * MB);
    server.route('/mp/pause.bin', { body, etag: '"p"', delayMs: 20, chunkSize: 32 * KB });
    const h = harness();
    const d = h.manager.add({ url: server.url('/mp/pause.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 600 * KB && x.connections === 4, 30_000);
    await h.manager.pause(d.id);
    const paused = h.manager.get(d.id)!;
    assert.equal(paused.state, 'paused');
    assert.ok(paused.segments && paused.segments.length >= 4, 'parts recorded');
    assert.equal(paused.downloadedBytes, sumDone(paused.segments!), 'progress is the sum of the parts');
    assert.ok(paused.downloadedBytes > 0 && paused.downloadedBytes < body.length);
    const inProgress = paused.segments!.filter((s) => s.done > 0 && s.done < s.end - s.start);
    assert.ok(inProgress.length >= 2, `several parts were half done: ${JSON.stringify(paused.segments)}`);
    // Every byte recorded as done is really on disk and correct.
    const part = fs.readFileSync(path.join(h.dir, 'pause.bin.haulpart'));
    for (const s of paused.segments!) assert.ok(part.subarray(s.start, s.start + s.done).equals(body.subarray(s.start, s.start + s.done)), `part at ${s.start}`);
    const before = server.requestsFor('/mp/pause.bin').length;

    server.route('/mp/pause.bin', { body, etag: '"p"' });
    h.manager.resume(d.id);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body), 'byte-identical after resuming four parts');
    const after = server.requestsFor('/mp/pause.bin').slice(before);
    for (const s of inProgress) {
      const expected = `bytes=${s.start + s.done}-${s.end === body.length ? '' : s.end - 1}`;
      assert.ok(after.some((r) => r.headers.range === expected), `a request continued part ${s.start} at ${expected}: ${after.map((r) => r.headers.range).join(', ')}`);
    }
    assert.ok(after.every((r) => r.headers['if-range'] === '"p"'), 'every part request carries the validator');
    assert.equal(done.notice, null);
    await h.manager.shutdown();
  });

  test('the parts survive closing Haul and a crash (power cut: zeros past each checkpoint are rewritten)', async () => {
    const body = randomBody(3 * MB);
    server.route('/mp/restart.bin', { body, etag: '"r"', delayMs: 20, chunkSize: 32 * KB });
    const h = harness();
    const d = h.manager.add({ url: server.url('/mp/restart.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 500 * KB, 30_000);
    await h.manager.shutdown();
    const peek = new SqliteStore(h.dbFile);
    const stored = peek.loadAll().find((r) => r.id === d.id)!;
    peek.close();
    assert.equal(stored.state, 'queued');
    assert.ok(stored.segments && stored.segments.length >= 4);
    // Simulate a power cut: data past each part's checkpoint reads back as zeros.
    const partFile = path.join(h.dir, 'restart.bin.haulpart');
    const part = fs.readFileSync(partFile);
    for (const s of stored.segments!) part.fill(0, Math.min(part.length, s.start + s.done), Math.min(part.length, s.end));
    fs.writeFileSync(partFile, part);

    server.route('/mp/restart.bin', { body, etag: '"r"' });
    const h2 = harness({ dir: h.dir, dbFile: h.dbFile });
    const again = h2.manager.get(d.id)!;
    assert.equal(again.downloadedBytes, sumDone(stored.segments!), 'progress found after restart');
    const done = await waitFor(h2.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body), 'no zero-filled gaps: every part rewrote what was past its checkpoint');
    await h2.manager.shutdown();
  });

  test('the stored progress of every part never runs ahead of the data on disk', async () => {
    const body = randomBody(3 * MB);
    server.route('/mp/steady.bin', { body, etag: '"st"', delayMs: 10, chunkSize: 32 * KB });
    const h = harness();
    const d = h.manager.add({ url: server.url('/mp/steady.bin') });
    const peek = new SqliteStore(h.dbFile);
    let checkpoints = 0;
    let violations = 0;
    for (;;) {
      const stored = peek.loadAll().find((r) => r.id === d.id)!;
      if (stored.state === 'completed') break;
      if (stored.state === 'failed' || stored.state === 'cancelled') throw new Error(`download ended ${stored.state}: ${stored.error}`);
      if (stored.state === 'downloading' && stored.segments && stored.downloadedBytes > 0) {
        checkpoints++;
        let onDisk: Buffer;
        try {
          onDisk = fs.readFileSync(path.join(h.dir, 'steady.bin.haulpart'));
        } catch {
          continue;
        }
        for (const s of stored.segments) {
          if (s.done > 0 && !onDisk.subarray(s.start, s.start + s.done).equals(body.subarray(s.start, s.start + s.done))) violations++;
        }
        if (stored.downloadedBytes !== sumDone(stored.segments)) violations++;
      }
      await sleep(25);
    }
    peek.close();
    assert.ok(checkpoints > 3, `saw ${checkpoints} checkpoints`);
    assert.equal(violations, 0);
    assert.ok(read(h.manager.get(d.id)!).equals(body));
    await h.manager.shutdown();
  });

  test('checkpointNow (Windows shutting down) records every part synchronously', async () => {
    const body = randomBody(3 * MB);
    server.route('/mp/session.bin', { body, etag: '"w"', delayMs: 15, chunkSize: 32 * KB });
    const h = harness({ persistIntervalMs: 60_000 });
    const d = h.manager.add({ url: server.url('/mp/session.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 500 * KB, 30_000);
    h.manager.checkpointNow();
    const peek = new SqliteStore(h.dbFile);
    const stored = peek.loadAll().find((r) => r.id === d.id)!;
    peek.close();
    assert.equal(stored.state, 'downloading');
    assert.ok(stored.segments && sumDone(stored.segments) > 400 * KB, `stored ${stored.downloadedBytes}`);
    const onDisk = fs.readFileSync(path.join(h.dir, 'session.bin.haulpart'));
    for (const s of stored.segments!) assert.ok(onDisk.subarray(s.start, s.start + s.done).equals(body.subarray(s.start, s.start + s.done)));
    await h.manager.shutdown();
  });

  test('a download started with one connection (older version) continues in parts after an upgrade', async () => {
    const body = randomBody(3 * MB);
    server.route('/mp/upgrade.bin', { body, etag: '"u"', delayMs: 15, chunkSize: 32 * KB });
    const h = createHarness({ connections: 1, minSegmentBytes: SEG });
    const d = h.manager.add({ url: server.url('/mp/upgrade.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 300 * KB);
    await h.manager.pause(d.id);
    const prefix = h.manager.get(d.id)!.downloadedBytes;
    assert.equal(h.manager.get(d.id)!.segments, null, 'one connection records no parts');
    server.route('/mp/upgrade.bin', { body, etag: '"u"', delayMs: 3, chunkSize: 32 * KB });
    h.manager.updateSettings({ ...h.manager.getSettings(), connections: 4 });
    h.manager.resume(d.id);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    const ranges = rangesOf('/mp/upgrade.bin');
    assert.equal(ranges[0], `bytes=${prefix}-`, 'first continued the old partial file');
    assert.ok(ranges.length >= 3, 'then the rest was split');
    await h.manager.shutdown();
  });

  test('when a server refuses extra connections (HTTP 429), the download goes on with the ones it allows', async () => {
    const body = randomBody(2 * MB);
    server.route('/mp/strict.bin', { body, etag: '"x"', maxParallel: 2, delayMs: 8, chunkSize: 32 * KB });
    const h = harness();
    const d = h.manager.add({ url: server.url('/mp/strict.bin') });
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    assert.match(done.notice ?? '', /fewer connections/);
    const peak = Math.max(...server.requestsFor('/mp/strict.bin').map((r) => r.concurrent));
    assert.ok(peak <= 2, `never more than 2 in flight (saw ${peak + 1})`);
    await h.manager.shutdown();
  });

  test('a dropped connection on one part is reconnected without disturbing the others', async () => {
    const body = randomBody(2 * MB);
    server.route('/mp/drop.bin', { body, etag: '"d"', dropAfter: 100 * KB, delayMs: 5, chunkSize: 32 * KB });
    const h = harness();
    const d = h.manager.add({ url: server.url('/mp/drop.bin') });
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    assert.equal(done.error, null);
    await h.manager.shutdown();
  });

  test('the file changing on the server between parts restarts the download instead of mixing versions', async () => {
    const v1 = randomBody(2 * MB);
    const v2 = randomBody(2 * MB);
    server.route('/mp/changing.bin', { body: v1, etag: '"v1"', delayMs: 20, chunkSize: 32 * KB });
    const h = harness();
    const d = h.manager.add({ url: server.url('/mp/changing.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 200 * KB, 30_000);
    await h.manager.pause(d.id);
    server.route('/mp/changing.bin', { body: v2, etag: '"v2"' });
    h.manager.resume(d.id);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(v2), 'entirely the new version');
    assert.match(done.notice ?? '', /restarted from the beginning/);
    await h.manager.shutdown();
  });

  test('cancel removes the partial file; change link continues the parts under the new link', async () => {
    const body = randomBody(3 * MB);
    server.route('/mp/cancel.bin', { body, etag: '"c"', delayMs: 20, chunkSize: 32 * KB });
    server.route('/mp/old.bin', { body, etag: '"same"', delayMs: 20, chunkSize: 32 * KB });
    server.route('/mp/new.bin', { body, etag: '"same"' });
    const h = harness();
    const c = h.manager.add({ url: server.url('/mp/cancel.bin') });
    await waitFor(h.manager, c.id, (x) => x.downloadedBytes > 200 * KB, 30_000);
    await h.manager.cancel(c.id);
    assert.equal(h.manager.get(c.id)!.state, 'cancelled');
    assert.equal(h.manager.get(c.id)!.segments, null);
    assert.ok(!fs.existsSync(path.join(h.dir, 'cancel.bin.haulpart')));

    const d = h.manager.add({ url: server.url('/mp/old.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 400 * KB, 30_000);
    await h.manager.pause(d.id);
    const kept = h.manager.get(d.id)!.downloadedBytes;
    h.manager.changeUrl(d.id, server.url('/mp/new.bin'));
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    assert.ok(kept > 0 && rangesOf('/mp/new.bin').length >= 1, 'continued under the new link');
    await h.manager.shutdown();
  });

  test('the speed limit holds for all connections together', async () => {
    const body = randomBody(1 * MB);
    server.route('/mp/limited.bin', { body, etag: '"l"' });
    const h = harness();
    h.manager.updateSettings({ ...h.manager.getSettings(), speedLimit: 256 * KB });
    const started = Date.now();
    const d = h.manager.add({ url: server.url('/mp/limited.bin') });
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    const elapsed = Date.now() - started;
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    assert.ok(elapsed >= 3_000, `1 MB at 256 KB/s over several connections finished in ${elapsed} ms`);
    await h.manager.shutdown();
  });

  test('a damaged parts record (file shorter than its checkpoints) starts over safely', async () => {
    const body = randomBody(2 * MB);
    server.route('/mp/damaged.bin', { body, etag: '"dm"' });
    const dir = tempDir();
    const dbFile = path.join(dir, '.state', 'dm.db');
    const now = Date.now();
    const rec: DownloadRecord = {
      id: 'damaged', kind: 'http', media: null, url: server.url('/mp/damaged.bin'), finalUrl: null, fileName: 'damaged.bin', directory: dir,
      fileNameSettled: true, state: 'paused', totalBytes: body.length, downloadedBytes: 1_500_000, resumable: true, etag: '"dm"', lastModified: null,
      error: null, notice: null, createdAt: now, updatedAt: now, completedAt: null, autoCategory: false, referrer: null,
      segments: [{ start: 0, end: MB, done: MB }, { start: MB, end: 2 * MB, done: 500_000 }],
    };
    const store = new SqliteStore(dbFile);
    store.upsert(rec);
    store.close();
    fs.writeFileSync(path.join(dir, 'damaged.bin.haulpart'), body.subarray(0, 300_000)); // far shorter than the record claims
    const h = harness({ dir, dbFile });
    const r = h.manager.get('damaged')!;
    assert.equal(r.downloadedBytes, 0);
    assert.equal(r.segments, null);
    assert.match(r.notice ?? '', /no longer matches/);
    h.manager.resume('damaged');
    const done = await waitFor(h.manager, 'damaged', isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    await h.manager.shutdown();
  });

  test('the referrer of a link captured from the browser is sent as the Referer header', async () => {
    const body = randomBody(10 * KB);
    server.route('/mp/ref.bin', { body });
    const h = harness();
    const d = h.manager.add({ url: server.url('/mp/ref.bin'), referrer: 'https://example.com/page#frag' });
    const done = await waitFor(h.manager, d.id, isState('completed'));
    assert.equal(done.referrer, 'https://example.com/page');
    assert.equal(server.requestsFor('/mp/ref.bin')[0].headers.referer, 'https://example.com/page');
    const none = h.manager.add({ url: server.url('/mp/ref.bin'), referrer: 'javascript:alert(1)' });
    assert.equal(none.referrer, null, 'only http(s) referrers are kept');
    await h.manager.shutdown();
  });
});
