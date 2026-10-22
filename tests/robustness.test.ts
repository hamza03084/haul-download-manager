import { after, before, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TestServer, randomBody } from './helpers/testServer';
import { createHarness, isState, tempDir, waitFor } from './helpers/harness';
import { CorruptDatabaseError, SqliteStore, openStore } from '../src/main/engine/store';
import { ValidationError } from '../src/main/engine/urls';
import type { DownloadRecord, DownloadView } from '../src/shared/types';

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('crash and power-loss durability', () => {
  test('after a power cut, unflushed data past the last checkpoint is discarded, not appended to', async () => {
    // Simulates the state a power cut can leave behind: the database says 1 MB was safely on disk,
    // but the partial file is longer and its tail is zeros (data the OS never wrote out).
    const body = randomBody(3 * MB);
    server.route('/pl/video.bin', { body, etag: '"pl"' });
    const dir = tempDir();
    const dbFile = path.join(dir, '.state', 'pl.db');
    const checkpoint = 1 * MB;
    const now = Date.now();
    const rec: DownloadRecord = {
      id: 'power-loss-1',
      kind: 'http',
      media: null,
      url: server.url('/pl/video.bin'),
      finalUrl: server.url('/pl/video.bin'),
      fileName: 'video.bin',
      directory: dir,
      fileNameSettled: true,
      state: 'downloading',
      totalBytes: body.length,
      downloadedBytes: checkpoint,
      resumable: true,
      etag: '"pl"',
      lastModified: null,
      error: null,
      notice: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      autoCategory: false, segments: null, referrer: null,
    };
    const store = new SqliteStore(dbFile);
    store.upsert(rec);
    store.close();
    fs.writeFileSync(path.join(dir, 'video.bin.haulpart'), Buffer.concat([body.subarray(0, checkpoint), Buffer.alloc(700_000)]));

    const h = createHarness({ dir, dbFile });
    const done = await waitFor(h.manager, rec.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body), 'no zero-filled gap in the finished file');
    const reqs = server.requestsFor('/pl/video.bin');
    assert.equal(reqs[reqs.length - 1].headers.range, `bytes=${checkpoint}-`);
    await h.manager.shutdown();
  });

  test('the stored progress of a running download never runs ahead of the data on disk', async () => {
    const body = randomBody(3 * MB);
    server.route('/pl/steady.bin', { body, etag: '"s"', delayMs: 10, chunkSize: 32 * 1024 });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/pl/steady.bin') });
    const peek = new SqliteStore(h.dbFile);
    let checkpoints = 0;
    let violations = 0;
    for (;;) {
      const stored = peek.loadAll().find((r) => r.id === d.id)!;
      if (stored.state === 'completed') break;
      if (stored.state === 'failed' || stored.state === 'cancelled') throw new Error(`download ended ${stored.state}: ${stored.error}`);
      if (stored.state === 'downloading' && stored.downloadedBytes > 0) {
        checkpoints++;
        const onDisk = fs.statSync(path.join(h.dir, 'steady.bin.haulpart')).size;
        if (stored.downloadedBytes > onDisk) violations++;
      }
      await sleep(25);
    }
    peek.close();
    assert.ok(checkpoints > 3, `saw ${checkpoints} checkpoints`);
    assert.equal(violations, 0);
    assert.ok(read(h.manager.get(d.id)!).equals(body));
    await h.manager.shutdown();
  });

  test('checkpointNow (Windows shutting down) records flushed progress synchronously', async () => {
    const body = randomBody(3 * MB);
    server.route('/pl/session.bin', { body, etag: '"w"', delayMs: 15, chunkSize: 32 * 1024 });
    // Long checkpoint interval, so only the explicit call can have stored progress.
    const h = createHarness({ persistIntervalMs: 60_000 });
    const d = h.manager.add({ url: server.url('/pl/session.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 500_000);
    h.manager.checkpointNow();
    const peek = new SqliteStore(h.dbFile);
    const stored = peek.loadAll().find((r) => r.id === d.id)!;
    peek.close();
    const onDisk = fs.statSync(path.join(h.dir, 'session.bin.haulpart')).size;
    assert.equal(stored.state, 'downloading');
    assert.ok(stored.downloadedBytes > 400_000 && stored.downloadedBytes <= onDisk, `stored ${stored.downloadedBytes}, on disk ${onDisk}`);
    await h.manager.shutdown();
  });
});

describe('progress reporting', () => {
  test('a stalled transfer reports its speed dropping to zero instead of freezing the last value', async () => {
    const body = randomBody(1 * MB);
    // The speed is averaged over 3 s, so it can only reach 0 after 3 s without data: stall for 7 s.
    server.route('/stall/file.bin', { body, etag: '"st"', delayMs: 5, chunkSize: 32 * 1024, stallAfter: 300_000, stallMs: 7_000 });
    const h = createHarness({ timeoutMs: 10_000 });
    const d = h.manager.add({ url: server.url('/stall/file.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes >= 300_000 && x.speed > 0);
    const stalledAt = h.manager.get(d.id)!.downloadedBytes;
    await waitFor(h.manager, d.id, (x) => x.state === 'downloading' && x.downloadedBytes === stalledAt && x.speed === 0, 6_500);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    await h.manager.shutdown();
  });
});

describe('links that are not files', () => {
  test('YouTube links are never downloaded as a web page: they need a quality choice', () => {
    const h = createHarness();
    for (const u of [
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      'https://youtu.be/aqz-KE-bpKQ',
      'https://m.youtube.com/shorts/abc',
      'https://music.youtube.com/watch?v=x',
      'https://www.youtube-nocookie.com/embed/x',
    ]) {
      assert.throws(() => h.manager.add({ url: u }), (e: unknown) => e instanceof ValidationError && /YouTube page, not a file/.test(e.message), u);
    }
    // Look-alike hosts are not YouTube.
    assert.doesNotThrow(() => h.manager.add({ url: 'https://youtube.com.example.net/video.mp4', startPaused: true }));
    assert.doesNotThrow(() => h.manager.add({ url: 'https://notyoutube.com/video.mp4', startPaused: true }));
    assert.equal(h.manager.list().length, 2);
    void h.manager.shutdown();
  });

  test('a web page served instead of the expected file is flagged, not silently reported as the file', async () => {
    const html = Buffer.from('<!doctype html><html><body>Please sign in</body></html>');
    server.route('/wp/movie.mp4', { body: html, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    server.route('/wp/watch', { body: html, headers: { 'Content-Type': 'text/html' } });
    server.route('/wp/export', { body: html, headers: { 'Content-Type': 'text/html', 'Content-Disposition': 'attachment; filename="report.html"' } });
    server.route('/wp/data.bin', { body: randomBody(1000) });
    const h = createHarness();
    const ids = ['/wp/movie.mp4', '/wp/watch', '/wp/export', '/wp/data.bin'].map((p) => h.manager.add({ url: server.url(p) }).id);
    const [movie, watch, exported, data] = await Promise.all(ids.map((id) => waitFor(h.manager, id, isState('completed', 'failed'))));
    assert.match(movie.notice ?? '', /web page instead of the expected \.mp4 file/);
    assert.match(watch.notice ?? '', /leads to a web page/);
    assert.equal(watch.fileName, 'watch.html');
    assert.equal(exported.notice, null, 'a page the server deliberately names as a download is fine');
    assert.equal(exported.fileName, 'report.html');
    assert.equal(data.notice, null);
    await h.manager.shutdown();
  });
});

describe('things users do to files and data', () => {
  test('deleting the partial file while paused restarts the download with an explanation', async () => {
    const body = randomBody(2 * MB);
    server.route('/u/deleted.bin', { body, etag: '"del"', delayMs: 15, chunkSize: 32 * 1024 });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/u/deleted.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 200_000);
    await h.manager.pause(d.id);
    fs.rmSync(path.join(h.dir, 'deleted.bin.haulpart'));
    server.route('/u/deleted.bin', { body, etag: '"del"' });
    h.manager.resume(d.id);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    assert.match(done.notice ?? '', /deleted or moved, so the download started over/);
    const reqs = server.requestsFor('/u/deleted.bin');
    assert.equal(reqs[reqs.length - 1].headers.range, undefined, 'nothing to resume from');
    await h.manager.shutdown();
  });

  test('deleting the partial file during a transfer never yields a corrupt "completed" file', async (t) => {
    const body = randomBody(2 * MB);
    server.route('/u/yanked.bin', { body, etag: '"y"', delayMs: 15, chunkSize: 32 * 1024 });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/u/yanked.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 300_000);
    let deleted = 'deleted';
    try {
      fs.rmSync(path.join(h.dir, 'yanked.bin.haulpart'));
    } catch (e) {
      deleted = `delete refused (${(e as NodeJS.ErrnoException).code})`; // either outcome is acceptable
    }
    const end = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    t.diagnostic(`partial file ${deleted}; download ended ${end.state}${end.error ? `: ${end.error}` : ''}`);
    if (end.state === 'completed') assert.ok(read(end).equals(body), 'a completed file must be intact');
    else assert.ok(end.error, 'a failure must explain itself');
    await h.manager.shutdown();
  });

  test('a damaged database is set aside and the app starts with an empty history', () => {
    const dir = tempDir();
    const garbage = path.join(dir, 'garbage.db');
    fs.writeFileSync(garbage, randomBytes(16 * 1024));
    assert.throws(() => new SqliteStore(garbage), CorruptDatabaseError);
    const opened = openStore(garbage);
    assert.ok(opened.quarantined && fs.existsSync(opened.quarantined), 'damaged file kept for inspection');
    assert.deepEqual(opened.store.loadAll(), []);
    opened.store.close();

    // A real history database cut in half (e.g. a disk error).
    const truncated = path.join(dir, 'truncated.db');
    const s = new SqliteStore(truncated);
    for (let i = 0; i < 400; i++) {
      const now = Date.now();
      s.upsert({
        id: `id-${i}`, kind: 'http', media: null, url: `https://example.com/${i}.bin`, finalUrl: null, fileName: `${i}.bin`, directory: dir,
        fileNameSettled: true, state: 'completed', totalBytes: 1, downloadedBytes: 1, resumable: true, etag: null,
        lastModified: null, error: null, notice: 'x'.repeat(200), createdAt: now, updatedAt: now, completedAt: now, autoCategory: false, segments: null, referrer: null,
      });
    }
    s.close();
    const size = fs.statSync(truncated).size;
    fs.truncateSync(truncated, Math.floor(size / 2));
    const reopened = openStore(truncated);
    assert.ok(reopened.quarantined, 'a half-written database is detected as damaged');
    assert.deepEqual(reopened.store.loadAll(), []);
    reopened.store.close();

    // A healthy database is opened as-is.
    const healthy = openStore(path.join(dir, 'healthy.db'));
    assert.equal(healthy.quarantined, null);
    healthy.store.close();
  });
});

// ------------------------------------------------------------------ chaos

/** Small deterministic PRNG so a failing seed can be replayed. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// HAUL_CHAOS_SEEDS=50 runs a longer soak with seeds 1..50.
const chaosSeeds = Array.from({ length: Number(process.env.HAUL_CHAOS_SEEDS) || 3 }, (_, i) => i + 1);

describe('impatient user (randomised actions)', () => {
  for (const seed of chaosSeeds) {
    test(`random pause/resume/cancel/retry/remove/duplicate storm keeps every file correct (seed ${seed}, ${seed % 2 === 0 ? `${2 + (seed % 3)} connections` : '1 connection'})`, async () => {
      const rnd = mulberry32(seed);
      const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
      const bodies = new Map<string, Buffer>();
      const routes: string[] = [];
      for (let i = 0; i < 6; i++) {
        const p = `/chaos${seed}/file${i}.bin`;
        const body = randomBody(300_000 + Math.floor(rnd() * 900_000));
        bodies.set(p, body);
        routes.push(p);
        server.route(p, {
          body,
          etag: i % 3 === 2 ? null : `"c${seed}-${i}"`,
          ranges: i % 3 !== 1, // a third of the servers cannot resume
          delayMs: 3 + Math.floor(rnd() * 6),
          chunkSize: 16 * 1024,
          dropAfter: i === 0 ? 150_000 : null, // one server drops the first connection
        });
      }
      // Every other seed downloads in parts (2-4 connections) with small parts, so splitting happens on these files.
      const connections = seed % 2 === 0 ? 2 + (seed % 3) : 1;
      const h = createHarness({ maxConcurrent: 3, maxAutoRetries: 3, connections, minSegmentBytes: 64 * 1024 });
      const ids: string[] = [];
      const unexpected: string[] = [];
      const act = async (name: string, fn: () => unknown) => {
        try {
          await fn();
        } catch (e) {
          if (!(e instanceof ValidationError)) unexpected.push(`${name}: ${(e as Error).stack ?? e}`);
        }
      };

      for (let step = 0; step < 160; step++) {
        const r = rnd();
        const id = ids.length ? pick(ids) : null;
        if (r < 0.22 || !id) await act('add', () => ids.push(h.manager.add({ url: server.url(pick(routes)), startPaused: rnd() < 0.1 }).id));
        else if (r < 0.4) await act('pause', () => h.manager.pause(id));
        else if (r < 0.58) await act('resume', () => h.manager.resume(id));
        else if (r < 0.66) await act('cancel', () => h.manager.cancel(id));
        else if (r < 0.74) await act('retry', () => h.manager.retry(id));
        else if (r < 0.8) await act('remove', () => h.manager.remove(id, rnd() < 0.5));
        else if (r < 0.84) await act('pauseAll', () => h.manager.pauseAll());
        else if (r < 0.88) await act('resumeAll', () => h.manager.resumeAll());
        else if (r < 0.92) await act('settings', () => h.manager.updateSettings({ ...h.manager.getSettings(), maxConcurrent: 1 + Math.floor(rnd() * 5) }));
        else if (r < 0.95) await act('clearFinished', () => h.manager.clearFinished());
        else {
          // Several buttons clicked at once: like separate IPC calls, each may fail on its own.
          await Promise.all([
            act('pause', () => h.manager.pause(id)),
            act('resume', () => h.manager.resume(id)),
            act('cancel', () => h.manager.cancel(id)),
          ]);
        }
        if (rnd() < 0.5) await sleep(Math.floor(rnd() * 40));
      }
      assert.deepEqual(unexpected, [], 'only validation errors may surface to the user');

      // Let everything settle, then finish whatever is left like a patient user would.
      const settle = async () => {
        const deadline = Date.now() + 60_000;
        while (h.manager.list().some((d) => d.state === 'downloading' || d.state === 'queued')) {
          if (Date.now() > deadline) throw new Error('downloads did not settle');
          await sleep(50);
        }
      };
      await settle();
      h.manager.resumeAll();
      for (const d of h.manager.list()) if (d.state === 'failed') h.manager.retry(d.id);
      await settle();

      const list = h.manager.list();
      assert.ok(list.every((d) => d.state === 'completed' || d.state === 'cancelled'), `final states: ${list.map((d) => `${d.state}:${d.error}`).join(', ')}`);
      for (const d of list.filter((x) => x.state === 'completed')) {
        const expected = bodies.get(new URL(d.url).pathname)!;
        assert.ok(read(d).equals(expected), `${d.fileName} is byte-identical`);
        assert.equal(d.downloadedBytes, expected.length);
      }
      const files = fs.readdirSync(h.dir).filter((f) => f !== '.state');
      assert.deepEqual(files.filter((f) => f.endsWith('.haulpart')), [], 'no partial files left behind');
      // Every file on disk (including ones kept after "remove from list") is a complete, correct copy.
      for (const f of files) {
        const content = fs.readFileSync(path.join(h.dir, f));
        assert.ok([...bodies.values()].some((b) => b.equals(content)), `${f} is a correct copy of a served file`);
      }
      await h.manager.shutdown();
    });
  }
});
