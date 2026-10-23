import { after, before, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { TestServer, randomBody } from './helpers/testServer';
import { createHarness, isState, waitFor } from './helpers/harness';
import { ValidationError } from '../src/main/engine/urls';
import type { DownloadView } from '../src/shared/types';

const MB = 1024 * 1024;
let server: TestServer;

before(async () => {
  server = new TestServer();
  await server.start();
});
after(async () => {
  await server.close();
});

const read = (d: DownloadView) => fs.readFileSync(path.join(d.directory, d.fileName));
const partials = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith('.haulpart'));

describe('basic downloads', () => {
  test('downloads a file, reports progress and finalizes it', async () => {
    const body = randomBody(2 * MB);
    // Slow enough (about 0.7 s) for a speed to be measured even on a fast machine: the meter needs 0.3 s.
    server.route('/basic/file.bin', { body, etag: '"v1"', delayMs: 20, chunkSize: 64 * 1024 });
    const h = createHarness();
    const added = h.manager.add({ url: server.url('/basic/file.bin') });
    assert.equal(added.state, 'queued');
    const done = await waitFor(h.manager, added.id, isState('completed'));
    assert.equal(done.fileName, 'file.bin');
    assert.equal(done.totalBytes, body.length);
    assert.equal(done.downloadedBytes, body.length);
    assert.ok(read(done).equals(body), 'content matches');
    assert.deepEqual(partials(h.dir), [], 'no partial file left behind');

    const progress = h.events.filter((e) => e.id === added.id && e.state === 'downloading').map((e) => e.downloadedBytes);
    assert.ok(progress.length >= 3, `expected several progress events, got ${progress.length}`);
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1], 'progress is monotonic');
    assert.ok(progress.some((b) => b > 0 && b < body.length), 'saw intermediate progress');
    assert.ok(h.events.some((e) => e.id === added.id && e.speed > 0), 'speed was reported');
    assert.ok(h.events.some((e) => e.id === added.id && e.etaSeconds !== null), 'ETA was reported');
    // Never reported completed before the file existed under its final name.
    const firstCompleted = h.events.find((e) => e.id === added.id && e.state === 'completed');
    assert.ok(firstCompleted);
    await h.manager.shutdown();
  });

  test('uses Content-Disposition for the file name and follows redirects', async () => {
    const body = randomBody(10_000);
    server.route('/cd/real', { body, headers: { 'Content-Disposition': `attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf` } });
    server.route('/cd/hop1', { redirectTo: '/cd/hop2' });
    server.route('/cd/hop2', { redirectTo: server.url('/cd/real') });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/cd/hop1') });
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.equal(done.fileName, 'résumé.pdf');
    assert.equal(done.finalUrl, server.url('/cd/real'));
    assert.ok(read(done).equals(body));
    await h.manager.shutdown();
  });

  test('handles chunked responses without Content-Length', async () => {
    const body = randomBody(300_000);
    server.route('/chunked/data.bin', { body, chunked: true, ranges: false });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/chunked/data.bin') });
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    assert.equal(done.resumable, false);
    await h.manager.shutdown();
  });

  test('adds an extension from Content-Type and respects a user-chosen name', async () => {
    server.route('/', { body: Buffer.from('<html></html>'), headers: { 'Content-Type': 'text/html' } });
    const h = createHarness();
    const a = h.manager.add({ url: server.url('/') });
    const b = h.manager.add({ url: server.url('/'), fileName: 'my:page.htm' });
    const da = await waitFor(h.manager, a.id, isState('completed'));
    const db = await waitFor(h.manager, b.id, isState('completed'));
    assert.equal(da.fileName, 'download.html');
    assert.equal(db.fileName, 'my_page.htm');
    await h.manager.shutdown();
  });
});

describe('pause and resume', () => {
  test('resumes with a Range request when the server supports it', async () => {
    const body = randomBody(3 * MB);
    server.route('/pr/ranged.bin', { body, etag: '"abc"', delayMs: 15, chunkSize: 32 * 1024 });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/pr/ranged.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 300_000);
    await h.manager.pause(d.id);
    const paused = h.manager.get(d.id)!;
    assert.equal(paused.state, 'paused');
    const partSize = fs.statSync(path.join(h.dir, 'ranged.bin.haulpart')).size;
    assert.equal(paused.downloadedBytes, partSize, 'downloaded bytes match the partial file on disk');
    const lastPauseEvent = h.events.filter((e) => e.id === d.id).pop()!;
    assert.equal(lastPauseEvent.state, 'paused');
    assert.equal(lastPauseEvent.downloadedBytes, partSize, 'the paused event reports on-disk bytes, not the live counter');
    assert.ok(partSize > 0 && partSize < body.length);
    assert.ok(!fs.existsSync(path.join(h.dir, 'ranged.bin')), 'not finalized while paused');

    server.route('/pr/ranged.bin', { body, etag: '"abc"' }); // full speed for the rest
    h.manager.resume(d.id);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body), 'resumed file is byte-identical');
    const reqs = server.requestsFor('/pr/ranged.bin');
    const last = reqs[reqs.length - 1];
    assert.equal(last.headers.range, `bytes=${partSize}-`);
    assert.equal(last.headers['if-range'], '"abc"');
    assert.equal(done.notice, null, 'no restart notice for a clean resume');
    await h.manager.shutdown();
  });

  test('restarts safely when the server ignores ranges', async () => {
    const body = randomBody(2 * MB);
    server.route('/pr/noranges.bin', { body, ranges: false, delayMs: 15, chunkSize: 32 * 1024 });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/pr/noranges.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 200_000);
    assert.equal(h.manager.get(d.id)!.resumable, null, 'no Accept-Ranges header: support unknown');
    await h.manager.pause(d.id);

    server.route('/pr/noranges.bin', { body, ranges: false });
    h.manager.resume(d.id);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body), 'the full-body 200 reply replaced the partial; nothing was appended');
    assert.match(done.notice ?? '', /restarted from the beginning/);
    assert.equal(done.resumable, false, 'learned that the server cannot resume');
    const reqs = server.requestsFor('/pr/noranges.bin');
    assert.ok(reqs[reqs.length - 1].headers.range, 'a Range request was tried');
    await h.manager.shutdown();
  });

  test('never sends Range to a server that says Accept-Ranges: none', async () => {
    const body = randomBody(2 * MB);
    const spec = { body, ranges: false, headers: { 'Accept-Ranges': 'none' } };
    server.route('/pr/none.bin', { ...spec, delayMs: 15, chunkSize: 32 * 1024 });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/pr/none.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 200_000);
    await h.manager.pause(d.id);
    const paused = h.manager.get(d.id)!;
    assert.equal(paused.resumable, false);
    assert.match(paused.notice ?? '', /does not support resuming/);
    server.route('/pr/none.bin', spec);
    h.manager.resume(d.id);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    const reqs = server.requestsFor('/pr/none.bin');
    assert.equal(reqs[reqs.length - 1].headers.range, undefined);
    await h.manager.shutdown();
  });

  test('refuses to append when the file changed on the server (ETag mismatch)', async () => {
    const v1 = randomBody(2 * MB);
    const v2 = randomBody(2 * MB);
    server.route('/pr/changing.bin', { body: v1, etag: '"v1"', delayMs: 15, chunkSize: 32 * 1024 });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/pr/changing.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 200_000);
    await h.manager.pause(d.id);

    server.route('/pr/changing.bin', { body: v2, etag: '"v2"' });
    h.manager.resume(d.id);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(v2), 'file is entirely the new version');
    assert.match(done.notice ?? '', /restarted from the beginning/);
    await h.manager.shutdown();
  });

  test('refuses to append when the server sends an inconsistent Content-Range', async () => {
    const body = randomBody(1 * MB);
    server.route('/pr/badrange.bin', { body, etag: '"x"', delayMs: 15, chunkSize: 32 * 1024 });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/pr/badrange.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 100_000);
    await h.manager.pause(d.id);
    // Broken server: answers range requests with 206 but sends the file from byte 0.
    server.route('/pr/badrange.bin', { body, etag: '"x"', lieAboutRange: true });
    h.manager.resume(d.id);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body), 'no misaligned data appended');
    assert.match(done.notice ?? '', /Could not safely resume/);
    await h.manager.shutdown();
  });

  test('pausing a queued download and resuming it later', async () => {
    const body = randomBody(50_000);
    server.route('/pr/q.bin', { body });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/pr/q.bin'), startPaused: true });
    assert.equal(d.state, 'paused');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(server.requestsFor('/pr/q.bin').length, 0, 'nothing requested while paused');
    h.manager.resume(d.id);
    const done = await waitFor(h.manager, d.id, isState('completed'));
    assert.ok(read(done).equals(body));
    await h.manager.shutdown();
  });
});

describe('cancellation, failures and retries', () => {
  test('cancel stops the transfer and deletes the partial file', async () => {
    const body = randomBody(3 * MB);
    server.route('/f/cancel.bin', { body, delayMs: 15, chunkSize: 32 * 1024 });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/f/cancel.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 100_000);
    await h.manager.cancel(d.id);
    const c = h.manager.get(d.id)!;
    assert.equal(c.state, 'cancelled');
    assert.equal(c.downloadedBytes, 0);
    const lastCancelEvent = h.events.filter((e) => e.id === d.id).pop()!;
    assert.equal(lastCancelEvent.state, 'cancelled');
    assert.equal(lastCancelEvent.downloadedBytes, 0, 'the cancelled event reports 0 bytes');
    assert.deepEqual(partials(h.dir), []);
    assert.ok(!fs.existsSync(path.join(h.dir, 'cancel.bin')));

    // Retrying a cancelled download starts over and completes.
    server.route('/f/cancel.bin', { body });
    h.manager.retry(d.id);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    await h.manager.shutdown();
  });

  test('cancel racing with pause and repeated actions leaves a consistent state', async () => {
    const body = randomBody(2 * MB);
    server.route('/f/race.bin', { body, delayMs: 15, chunkSize: 32 * 1024 });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/f/race.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 50_000);
    await Promise.all([h.manager.pause(d.id), h.manager.cancel(d.id), h.manager.pause(d.id)]);
    const r = h.manager.get(d.id)!;
    assert.ok(r.state === 'paused' || r.state === 'cancelled', r.state);
    await h.manager.cancel(d.id);
    assert.equal(h.manager.get(d.id)!.state, 'cancelled');
    assert.deepEqual(partials(h.dir), []);
    await h.manager.shutdown();
  });

  test('fails clearly when the connection is refused', async () => {
    const tmp = http.createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise<void>((r) => tmp.close(() => r()));
    const h = createHarness({ maxAutoRetries: 1 });
    const d = h.manager.add({ url: `http://127.0.0.1:${port}/nothing.bin` });
    const f = await waitFor(h.manager, d.id, isState('failed'));
    assert.match(f.error ?? '', /refused/i);
    await h.manager.shutdown();
  });

  test('reports HTTP errors without retrying non-transient ones', async () => {
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/does-not-exist.zip') });
    const f = await waitFor(h.manager, d.id, isState('failed'));
    assert.match(f.error ?? '', /HTTP 404/);
    assert.equal(server.requestsFor('/does-not-exist.zip').length, 1, '404 is not retried');
    await h.manager.shutdown();
  });

  test('retries transient 503 errors automatically', async () => {
    const body = randomBody(20_000);
    server.route('/f/flaky.bin', { body, status: 503, failTimes: 2 });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/f/flaky.bin') });
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.equal(server.requestsFor('/f/flaky.bin').length, 3);
    await h.manager.shutdown();
  });

  test('a persistent 500 fails, and manual retry succeeds once the server recovers', async () => {
    const body = randomBody(20_000);
    server.route('/f/broken.bin', { body, status: 500 });
    const h = createHarness({ maxAutoRetries: 1 });
    const d = h.manager.add({ url: server.url('/f/broken.bin') });
    const f = await waitFor(h.manager, d.id, isState('failed'));
    assert.match(f.error ?? '', /Server error \(HTTP 500\)/);
    server.route('/f/broken.bin', { body });
    h.manager.retry(d.id);
    const done = await waitFor(h.manager, d.id, isState('completed'));
    assert.ok(read(done).equals(body));
    await h.manager.shutdown();
  });

  test('a long Retry-After is reported instead of waited on', async () => {
    server.route('/f/ratelimited', { status: 429, headers: { 'Retry-After': '3600' } });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/f/ratelimited') });
    const f = await waitFor(h.manager, d.id, isState('failed'));
    assert.match(f.error ?? '', /HTTP 429.*60 min/);
    await h.manager.shutdown();
  });

  test('a dropped connection is resumed automatically from the partial file', async () => {
    const body = randomBody(1 * MB);
    server.route('/f/drop.bin', { body, etag: '"d"', dropAfter: 400_000 });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/f/drop.bin') });
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    const reqs = server.requestsFor('/f/drop.bin');
    assert.equal(reqs.length, 2);
    assert.match(String(reqs[1].headers.range), /^bytes=\d+-$/);
    await h.manager.shutdown();
  });

  test('a truncated body is never reported as completed', async () => {
    const body = randomBody(500_000);
    server.route('/f/trunc.bin', { body, ranges: false, dropAfter: 200_000, dropOnce: false });
    const h = createHarness({ maxAutoRetries: 1 });
    const d = h.manager.add({ url: server.url('/f/trunc.bin') });
    const f = await waitFor(h.manager, d.id, isState('failed', 'completed'));
    assert.equal(f.state, 'failed');
    assert.match(f.error ?? '', /interrupted|incomplete/i);
    assert.ok(!fs.existsSync(path.join(h.dir, 'trunc.bin')), 'no final file for a truncated transfer');
    await h.manager.shutdown();
  });

  test('times out a server that never responds', async () => {
    server.route('/f/hang', { hang: true });
    const h = createHarness({ timeoutMs: 300, maxAutoRetries: 0 });
    const d = h.manager.add({ url: server.url('/f/hang') });
    const f = await waitFor(h.manager, d.id, isState('failed'));
    assert.match(f.error ?? '', /timed out/i);
    await h.manager.shutdown();
  });

  test('rejects redirect loops and redirects to unsupported protocols', async () => {
    server.route('/f/loop', { redirectTo: '/f/loop' });
    server.route('/f/toftp', { redirectTo: 'ftp://example.com/file' });
    const h = createHarness();
    const a = h.manager.add({ url: server.url('/f/loop') });
    const b = h.manager.add({ url: server.url('/f/toftp') });
    assert.match((await waitFor(h.manager, a.id, isState('failed'))).error ?? '', /Too many redirects/);
    assert.match((await waitFor(h.manager, b.id, isState('failed'))).error ?? '', /unsupported protocol/);
    await h.manager.shutdown();
  });

  test('fails before downloading when disk space is insufficient', async () => {
    server.route('/f/big.bin', { body: randomBody(100_000) });
    const h = createHarness({ getFreeSpace: async () => 1_000 });
    const d = h.manager.add({ url: server.url('/f/big.bin') });
    const f = await waitFor(h.manager, d.id, isState('failed'));
    assert.match(f.error ?? '', /Not enough disk space/);
    await h.manager.shutdown();
  });

  test('rejects invalid input at add time', () => {
    const h = createHarness();
    assert.throws(() => h.manager.add({ url: 'not a url' }), ValidationError);
    assert.throws(() => h.manager.add({ url: 'ftp://example.com/x' }), ValidationError);
    assert.throws(() => h.manager.add({ url: server.url('/x'), directory: 'relative\\dir' }), ValidationError);
    assert.equal(h.manager.list().length, 0);
    void h.manager.shutdown();
  });

  test('reports a clear error when the destination is not writable', async () => {
    server.route('/f/perm.bin', { body: randomBody(1000) });
    const h = createHarness();
    // A path whose "parent folder" is actually a file cannot be created.
    const blocker = path.join(h.dir, 'iam-a-file');
    fs.writeFileSync(blocker, 'x');
    const d = h.manager.add({ url: server.url('/f/perm.bin'), directory: path.join(blocker, 'sub') });
    const f = await waitFor(h.manager, d.id, isState('failed'));
    assert.match(f.error ?? '', /Cannot create the folder/);
    await h.manager.shutdown();
  });
});

describe('naming and concurrency', () => {
  test('duplicate file names get unique names, including concurrent downloads', async () => {
    const body = randomBody(200_000);
    server.route('/n/same.bin', { body, delayMs: 5 });
    const h = createHarness({ maxConcurrent: 3 });
    fs.writeFileSync(path.join(h.dir, 'same.bin'), 'pre-existing');
    const ids = [0, 1, 2].map(() => h.manager.add({ url: server.url('/n/same.bin') }).id);
    const done = await Promise.all(ids.map((id) => waitFor(h.manager, id, isState('completed', 'failed'))));
    const names = done.map((d) => d.fileName).sort();
    assert.deepEqual(names, ['same (1).bin', 'same (2).bin', 'same (3).bin']);
    assert.equal(fs.readFileSync(path.join(h.dir, 'same.bin'), 'utf8'), 'pre-existing', 'existing file untouched');
    for (const d of done) assert.ok(read(d).equals(body));
    await h.manager.shutdown();
  });

  test('respects the simultaneous download limit', async () => {
    const body = randomBody(400_000);
    for (let i = 0; i < 5; i++) server.route(`/n/c${i}.bin`, { body, delayMs: 10, chunkSize: 32 * 1024 });
    const h = createHarness({ maxConcurrent: 2 });
    let maxActive = 0;
    h.manager.on('changed', () => {
      maxActive = Math.max(maxActive, h.manager.list().filter((d) => d.state === 'downloading').length);
    });
    const ids = [0, 1, 2, 3, 4].map((i) => h.manager.add({ url: server.url(`/n/c${i}.bin`) }).id);
    const done = await Promise.all(ids.map((id) => waitFor(h.manager, id, isState('completed', 'failed'))));
    assert.ok(done.every((d) => d.state === 'completed'));
    assert.equal(maxActive, 2);
    await h.manager.shutdown();
  });

  test('raising the limit starts queued downloads immediately', async () => {
    const body = randomBody(600_000);
    for (let i = 0; i < 3; i++) server.route(`/n/l${i}.bin`, { body, delayMs: 10, chunkSize: 32 * 1024 });
    const h = createHarness({ maxConcurrent: 1 });
    const ids = [0, 1, 2].map((i) => h.manager.add({ url: server.url(`/n/l${i}.bin`) }).id);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.manager.list().filter((d) => d.state === 'downloading').length, 1);
    h.manager.updateSettings({ ...h.manager.getSettings(), maxConcurrent: 3 });
    assert.equal(h.manager.list().filter((d) => d.state === 'downloading').length, 3);
    await Promise.all(ids.map((id) => waitFor(h.manager, id, isState('completed'))));
    await h.manager.shutdown();
  });

  test('remove deletes partial files and optionally the downloaded file', async () => {
    const body = randomBody(50_000);
    server.route('/n/rm.bin', { body });
    const h = createHarness();
    const a = h.manager.add({ url: server.url('/n/rm.bin'), fileName: 'keep.bin' });
    const b = h.manager.add({ url: server.url('/n/rm.bin'), fileName: 'delete.bin' });
    await waitFor(h.manager, a.id, isState('completed'));
    await waitFor(h.manager, b.id, isState('completed'));
    await h.manager.remove(a.id, false);
    await h.manager.remove(b.id, true);
    assert.ok(fs.existsSync(path.join(h.dir, 'keep.bin')));
    assert.ok(!fs.existsSync(path.join(h.dir, 'delete.bin')));
    assert.equal(h.manager.list().length, 0);
    await h.manager.shutdown();
  });
});

describe('persistence and recovery', () => {
  test('history and settings survive a restart', async () => {
    const body = randomBody(30_000);
    server.route('/p/hist.bin', { body });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/p/hist.bin') });
    await waitFor(h.manager, d.id, isState('completed'));
    h.manager.updateSettings({ downloadDirectory: h.dir, maxConcurrent: 5, resumeOnStartup: true });
    await h.manager.shutdown();

    const h2 = createHarness({ dir: h.dir, dbFile: h.dbFile });
    const again = h2.manager.get(d.id)!;
    assert.equal(again.state, 'completed');
    assert.equal(again.fileName, 'hist.bin');
    assert.equal(again.fileExists, true);
    assert.equal(h2.manager.getSettings().maxConcurrent, 5);
    fs.rmSync(path.join(h.dir, 'hist.bin'));
    assert.equal(h2.manager.get(d.id)!.fileExists, false, 'detects a deleted file');
    await h2.manager.shutdown();
  });

  test('graceful shutdown keeps the partial file and continues on next start', async () => {
    const body = randomBody(3 * MB);
    server.route('/p/graceful.bin', { body, etag: '"g"', delayMs: 15, chunkSize: 32 * 1024 });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/p/graceful.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 200_000);
    await h.manager.shutdown();
    const part = path.join(h.dir, 'graceful.bin.haulpart');
    const partSize = fs.statSync(part).size;
    assert.ok(partSize > 0);

    server.route('/p/graceful.bin', { body, etag: '"g"' });
    const h2 = createHarness({ dir: h.dir, dbFile: h.dbFile });
    const done = await waitFor(h2.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    const reqs = server.requestsFor('/p/graceful.bin');
    assert.equal(reqs[reqs.length - 1].headers.range, `bytes=${partSize}-`);
    await h2.manager.shutdown();
  });

  test('resume-on-startup can be turned off', async () => {
    const body = randomBody(2 * MB);
    server.route('/p/noauto.bin', { body, delayMs: 15, chunkSize: 32 * 1024 });
    const h = createHarness();
    h.manager.updateSettings({ ...h.manager.getSettings(), resumeOnStartup: false });
    const d = h.manager.add({ url: server.url('/p/noauto.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 100_000);
    await h.manager.shutdown();
    const h2 = createHarness({ dir: h.dir, dbFile: h.dbFile });
    const r = h2.manager.get(d.id)!;
    assert.equal(r.state, 'paused');
    assert.match(r.notice ?? '', /Paused at startup/);
    await h2.manager.shutdown();
  });

  test('a missing partial file is detected and the download starts over', async () => {
    const body = randomBody(2 * MB);
    server.route('/p/missing.bin', { body, etag: '"m"', delayMs: 15, chunkSize: 32 * 1024 });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/p/missing.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 200_000);
    await h.manager.pause(d.id);
    await h.manager.shutdown();
    fs.rmSync(path.join(h.dir, 'missing.bin.haulpart'));

    server.route('/p/missing.bin', { body, etag: '"m"' });
    const h2 = createHarness({ dir: h.dir, dbFile: h.dbFile });
    const r = h2.manager.get(d.id)!;
    assert.equal(r.downloadedBytes, 0);
    assert.match(r.notice ?? '', /missing or renamed/);
    h2.manager.resume(d.id);
    const done = await waitFor(h2.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    await h2.manager.shutdown();
  });
});

