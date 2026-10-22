// Tests for the 1.3 features: speed limit, "change link", categories, "shut down when done".
import { after, before, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TestServer, randomBody } from './helpers/testServer';
import { createHarness, isState, waitFor } from './helpers/harness';
import { RateLimiter } from '../src/main/engine/throttle';
import { ShutdownWhenDone } from '../src/main/power';
import { CATEGORIES, categoryByKey, categoryOf } from '../src/shared/categories';
import { ValidationError } from '../src/main/engine/urls';
import type { AddDownloadRequest, DownloadView, PowerState } from '../src/shared/types';
import { expectedMedia } from './helpers/fakeMedia';

const KB = 1024;
const MB = 1024 * KB;
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
const FAKE = [process.execPath, path.join(__dirname, 'fixtures', 'fakeYtDlp.js')];
const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

function mediaRequest(over: Partial<NonNullable<AddDownloadRequest['media']>> = {}): NonNullable<AddDownloadRequest['media']> {
  return {
    mode: 'video',
    height: 1080,
    audioFormat: null,
    thumbnail: false,
    subtitles: null,
    videoFormatId: '299',
    audioFormatId: '140',
    videoId: 'aqz-KE-bpKQ',
    title: 'Big Buck Bunny',
    label: '1080p60 · H.264',
    estimateVideo: 600_000,
    estimateAudio: 200_000,
    ...over,
  };
}

// ------------------------------------------------------------------ categories

describe('categories', () => {
  test('files are classified by extension, case-insensitively; unknown types have no category', () => {
    assert.equal(categoryOf('Movie.MP4')?.key, 'video');
    assert.equal(categoryOf('song.flac')?.key, 'music');
    assert.equal(categoryOf('photo.jpeg')?.key, 'images');
    assert.equal(categoryOf('report.pdf')?.key, 'documents');
    assert.equal(categoryOf('setup.exe')?.key, 'programs');
    assert.equal(categoryOf('backup.tar.gz')?.key, 'archives');
    assert.equal(categoryOf('disk.iso')?.key, 'archives');
    assert.equal(categoryOf('download'), null);
    assert.equal(categoryOf('data.bin'), null);
    assert.equal(categoryOf('weird.'), null);
    assert.equal(categoryByKey('video')?.folder, 'Video');
    assert.equal(categoryByKey('nope'), null);
    const all = CATEGORIES.flatMap((c) => c.extensions);
    assert.equal(new Set(all).size, all.length, 'no extension belongs to two categories');
  });

  test('with categories on, downloads land in a subfolder by type; others stay in the download folder', async () => {
    const mp3 = randomBody(120_000);
    const pdf = randomBody(30_000);
    const blob = randomBody(20_000);
    server.route('/cat/song.mp3', { body: mp3, etag: '"s"' });
    server.route('/cat/export', { body: pdf, headers: { 'Content-Disposition': 'attachment; filename="report.pdf"' } });
    server.route('/cat/blob', { body: blob });
    const h = createHarness();
    h.manager.updateSettings({ ...h.manager.getSettings(), categoriesEnabled: true });

    const named = h.manager.add({ url: server.url('/cat/blob'), fileName: 'clip.mkv' }); // name chosen by the user
    assert.equal(named.directory, path.join(h.dir, 'Video'), 'a known name is sorted at once');
    const song = h.manager.add({ url: server.url('/cat/song.mp3') }); // name from the link, settled by the server
    const report = h.manager.add({ url: server.url('/cat/export') }); // name from Content-Disposition
    const other = h.manager.add({ url: server.url('/cat/blob') }); // no recognisable type
    assert.equal(song.directory, h.dir, 'the folder is decided once the server names the file');
    assert.equal(song.autoCategory, true);

    const [a, b, c, d] = await Promise.all([named, song, report, other].map((x) => waitFor(h.manager, x.id, isState('completed', 'failed'))));
    for (const x of [a, b, c, d]) assert.equal(x.state, 'completed', x.error ?? '');
    assert.equal(a.directory, path.join(h.dir, 'Video'));
    assert.equal(b.directory, path.join(h.dir, 'Music'));
    assert.equal(c.directory, path.join(h.dir, 'Documents'));
    assert.equal(c.fileName, 'report.pdf');
    assert.equal(d.directory, h.dir);
    assert.equal(d.fileName, 'blob');
    assert.ok(read(a).equals(blob) && read(b).equals(mp3) && read(c).equals(pdf) && read(d).equals(blob));
    for (const x of [a, b, c, d]) assert.equal(x.autoCategory, false, 'nothing left to sort');
    assert.deepEqual(fs.readdirSync(h.dir).filter((f) => f !== '.state').sort(), ['Documents', 'Music', 'Video', 'blob']);
    await h.manager.shutdown();
  });

  test('a folder picked for the download is used as is, and nothing is sorted while categories are off', async () => {
    server.route('/cat/off.mp4', { body: randomBody(10_000) });
    const h = createHarness();
    const off = h.manager.add({ url: server.url('/cat/off.mp4') });
    h.manager.updateSettings({ ...h.manager.getSettings(), categoriesEnabled: true });
    const custom = path.join(h.dir, 'mine');
    const chosen = h.manager.add({ url: server.url('/cat/off.mp4'), directory: custom });
    const [a, b] = await Promise.all([off, chosen].map((x) => waitFor(h.manager, x.id, isState('completed', 'failed'))));
    assert.equal(a.directory, h.dir);
    assert.equal(b.directory, custom);
    assert.ok(!fs.existsSync(path.join(custom, 'Video')));
    await h.manager.shutdown();
  });

  test('a sorted download can be paused, resumed and survives a restart in its subfolder', async () => {
    const body = randomBody(2 * MB);
    server.route('/cat/big.mp4', { body, etag: '"big"', delayMs: 15, chunkSize: 32 * KB });
    const h = createHarness();
    h.manager.updateSettings({ ...h.manager.getSettings(), categoriesEnabled: true });
    const d = h.manager.add({ url: server.url('/cat/big.mp4') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 200_000);
    await h.manager.pause(d.id);
    const paused = h.manager.get(d.id)!;
    assert.equal(paused.directory, path.join(h.dir, 'Video'));
    assert.ok(fs.existsSync(path.join(h.dir, 'Video', 'big.mp4.haulpart')), 'partial file is in the subfolder');
    await h.manager.shutdown();

    server.route('/cat/big.mp4', { body, etag: '"big"' });
    const h2 = createHarness({ dir: h.dir, dbFile: h.dbFile });
    assert.equal(h2.manager.get(d.id)!.downloadedBytes, paused.downloadedBytes, 'progress found in the subfolder after restart');
    h2.manager.resume(d.id);
    const done = await waitFor(h2.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    assert.equal(server.requestsFor('/cat/big.mp4').pop()!.headers.range, `bytes=${paused.downloadedBytes}-`);
    await h2.manager.shutdown();
  });

  test('YouTube downloads are sorted into Video or Music', async () => {
    const h = createHarness({ mediaCommand: FAKE });
    h.manager.updateSettings({ ...h.manager.getSettings(), categoriesEnabled: true });
    const video = h.manager.add({ url: VIDEO, media: mediaRequest() });
    const audio = h.manager.add({ url: VIDEO, media: mediaRequest({ mode: 'audio', audioFormat: 'mp3', height: null, videoFormatId: null, title: 'Tune' }) });
    assert.equal(video.directory, path.join(h.dir, 'Video'));
    assert.equal(audio.directory, path.join(h.dir, 'Music'));
    const [v, a] = await Promise.all([video, audio].map((x) => waitFor(h.manager, x.id, isState('completed', 'failed'), 30_000)));
    assert.equal(v.state, 'completed', v.error ?? '');
    assert.equal(a.state, 'completed', a.error ?? '');
    assert.ok(read(v).equals(expectedMedia([{ id: '299', size: 600_000 }, { id: '140', size: 200_000 }])));
    assert.ok(fs.existsSync(path.join(h.dir, 'Music', 'Tune.mp3')));
    await h.manager.shutdown();
  });
});

// ------------------------------------------------------------------ speed limit

describe('speed limit', () => {
  test('the limiter paces chunks to the configured rate, releases waiters when the limit is removed, and honours abort', async () => {
    const limiter = new RateLimiter(200 * KB);
    const started = Date.now();
    // 640 KB in 64 KB chunks at 200 KB/s: the first 64 KB are the allowed burst, the rest takes about 2.9 s.
    for (let i = 0; i < 10; i++) await limiter.take(64 * KB);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2_500 && elapsed < 6_000, `took ${elapsed} ms`);

    const slow = new RateLimiter(1000);
    const waiting = slow.take(1_000_000);
    await sleep(100);
    slow.setRate(0);
    const t = Date.now();
    await waiting;
    assert.ok(Date.now() - t < 1_000, 'a waiter is released soon after the limit is turned off');

    const ac = new AbortController();
    const aborted = new RateLimiter(1000).take(1_000_000, ac.signal);
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(aborted, (e: Error) => e.name === 'AbortError');
  });

  test('a download is held to the limit, and removing the limit speeds it up at once', async () => {
    const body = randomBody(1 * MB);
    server.route('/limit/one.bin', { body, etag: '"l1"' });
    const h = createHarness();
    h.manager.updateSettings({ ...h.manager.getSettings(), speedLimit: 256 * KB });
    const started = Date.now();
    const d = h.manager.add({ url: server.url('/limit/one.bin') });
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    const elapsed = Date.now() - started;
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    // 1 MB at 256 KB/s is about 4 s (minus the 128 KB burst): unlimited, the local server takes well under a second.
    assert.ok(elapsed >= 3_000, `1 MB at 256 KB/s finished in ${elapsed} ms`);
    const speeds = h.events.filter((e) => e.id === d.id && e.state === 'downloading' && e.speed > 0).map((e) => e.speed);
    assert.ok(speeds.length > 0 && Math.max(...speeds) < 2 * 256 * KB, `reported speed stayed near the limit (max ${Math.max(...speeds)} B/s)`);

    const body2 = randomBody(3 * MB);
    server.route('/limit/two.bin', { body: body2, etag: '"l2"' });
    h.manager.updateSettings({ ...h.manager.getSettings(), speedLimit: 64 * KB }); // would take ~48 s
    const d2 = h.manager.add({ url: server.url('/limit/two.bin') });
    await waitFor(h.manager, d2.id, (x) => x.downloadedBytes > 100_000);
    const lifted = Date.now();
    h.manager.updateSettings({ ...h.manager.getSettings(), speedLimit: 0 });
    const done2 = await waitFor(h.manager, d2.id, isState('completed', 'failed'), 20_000);
    assert.equal(done2.state, 'completed', done2.error ?? '');
    assert.ok(Date.now() - lifted < 10_000, 'finished quickly once the limit was removed');
    assert.ok(read(done2).equals(body2));
    await h.manager.shutdown();
  });

  test('the limit is the total for all downloads together', async () => {
    const bodies = [randomBody(512 * KB), randomBody(512 * KB), randomBody(512 * KB)];
    bodies.forEach((body, i) => server.route(`/limit/shared${i}.bin`, { body }));
    const h = createHarness({ maxConcurrent: 3 });
    h.manager.updateSettings({ ...h.manager.getSettings(), speedLimit: 512 * KB });
    const started = Date.now();
    const ids = bodies.map((_, i) => h.manager.add({ url: server.url(`/limit/shared${i}.bin`) }).id);
    const done = await Promise.all(ids.map((id) => waitFor(h.manager, id, isState('completed', 'failed'), 30_000)));
    const elapsed = Date.now() - started;
    assert.ok(done.every((d) => d.state === 'completed'));
    // 1.5 MB in total at 512 KB/s: about 2.5 s after the burst. Three separate limits would finish in about 1 s.
    assert.ok(elapsed >= 2_000, `three 512 KB downloads at a shared 512 KB/s finished in ${elapsed} ms`);
    done.forEach((d, i) => assert.ok(read(d).equals(bodies[i])));
    await h.manager.shutdown();
  });

  test('the limit is passed on to yt-dlp, which paces the video download', async () => {
    const h = createHarness({ mediaCommand: FAKE });
    h.manager.updateSettings({ ...h.manager.getSettings(), speedLimit: 400 * KB });
    const started = Date.now();
    const d = h.manager.add({ url: VIDEO, media: mediaRequest({ title: 'Limited' }) });
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    const elapsed = Date.now() - started;
    assert.equal(done.state, 'completed', done.error ?? '');
    // 800 KB at 400 KB/s is about 2 s; the fake yt-dlp is otherwise instant.
    assert.ok(elapsed >= 1_500, `800 KB video at 400 KB/s finished in ${elapsed} ms`);
    assert.ok(read(done).equals(expectedMedia([{ id: '299', size: 600_000 }, { id: '140', size: 200_000 }])));
    await h.manager.shutdown();
  });
});

// ------------------------------------------------------------------ change link

describe('change link', () => {
  test('a paused download continues from its partial file under a fresh link to the same file', async () => {
    const body = randomBody(2 * MB);
    server.route('/cl/old.bin', { body, etag: '"same"', delayMs: 15, chunkSize: 32 * KB });
    server.route('/cl/new.bin', { body, etag: '"same"' });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/cl/old.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 200_000);
    await h.manager.pause(d.id);
    const paused = h.manager.get(d.id)!;
    const changed = h.manager.changeUrl(d.id, server.url('/cl/new.bin'));
    assert.equal(changed.url, server.url('/cl/new.bin'));
    assert.equal(changed.state, 'queued');
    assert.match(changed.notice ?? '', /Link changed/);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body), 'byte-identical after continuing under the new link');
    assert.equal(done.fileName, 'old.bin', 'the file keeps its name');
    const reqs = server.requestsFor('/cl/new.bin');
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].headers.range, `bytes=${paused.downloadedBytes}-`, 'resumed from the partial file');
    assert.equal(reqs[0].headers['if-range'], '"same"');
    await h.manager.shutdown();
  });

  test('an expired link: the failed download is given a new link and continues', async () => {
    const body = randomBody(2 * MB);
    server.route('/cl/expiring.bin', { body, etag: '"e"', delayMs: 15, chunkSize: 32 * KB });
    const h = createHarness({ maxAutoRetries: 0 });
    const d = h.manager.add({ url: server.url('/cl/expiring.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 200_000);
    await h.manager.pause(d.id);
    const at = h.manager.get(d.id)!.downloadedBytes;
    server.route('/cl/expiring.bin', { status: 403 }); // the link expired meanwhile
    h.manager.resume(d.id);
    const failed = await waitFor(h.manager, d.id, isState('failed', 'completed'));
    assert.equal(failed.state, 'failed');
    assert.match(failed.error ?? '', /HTTP 403/);
    assert.equal(failed.downloadedBytes, at, 'partial data kept');

    server.route('/cl/renewed.bin', { body, etag: '"e"' });
    h.manager.changeUrl(d.id, server.url('/cl/renewed.bin'));
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));
    assert.equal(server.requestsFor('/cl/renewed.bin')[0].headers.range, `bytes=${at}-`);
    await h.manager.shutdown();
  });

  test('a new link to a different file restarts from the beginning and says so', async () => {
    const v1 = randomBody(2 * MB);
    const v2 = randomBody(1 * MB);
    server.route('/cl/v1.bin', { body: v1, etag: '"v1"', delayMs: 15, chunkSize: 32 * KB });
    server.route('/cl/v2.bin', { body: v2, etag: '"v2"' });
    const h = createHarness();
    const d = h.manager.add({ url: server.url('/cl/v1.bin') });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 200_000);
    await h.manager.pause(d.id);
    h.manager.changeUrl(d.id, server.url('/cl/v2.bin'));
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(v2), 'the file is entirely the new one');
    assert.equal(done.totalBytes, v2.length);
    assert.match(done.notice ?? '', /restarted from the beginning/);
    await h.manager.shutdown();
  });

  test('a cancelled download can be given a new link; the link is validated; running and YouTube downloads refuse', async () => {
    const body = randomBody(50_000);
    server.route('/cl/c.bin', { body, delayMs: 15, chunkSize: 4 * KB });
    const h = createHarness({ mediaCommand: FAKE });
    const d = h.manager.add({ url: server.url('/cl/nope.bin') });
    await waitFor(h.manager, d.id, isState('failed'));
    for (const bad of ['', 'not a url', 'ftp://x/y', 'https://www.youtube.com/watch?v=abc']) {
      assert.throws(() => h.manager.changeUrl(d.id, bad), ValidationError, `rejects ${JSON.stringify(bad)}`);
    }
    assert.throws(() => h.manager.changeUrl('missing-id', server.url('/cl/c.bin')), ValidationError);
    await h.manager.cancel(d.id);
    h.manager.changeUrl(d.id, server.url('/cl/c.bin'));
    await waitFor(h.manager, d.id, isState('downloading'));
    assert.throws(() => h.manager.changeUrl(d.id, server.url('/cl/c.bin')), /Pause the download/);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(body));

    const media = h.manager.add({ url: VIDEO, media: mediaRequest(), startPaused: true });
    assert.throws(() => h.manager.changeUrl(media.id, server.url('/cl/c.bin')), /video download/);
    await h.manager.shutdown();
  });
});

// ------------------------------------------------------------------ shut down when done

describe('shut down when done', () => {
  const states = (s: ShutdownWhenDone) => {
    const seen: PowerState[] = [];
    s.on('changed', (st: PowerState) => seen.push(st));
    return seen;
  };

  test('armed while downloads run: the countdown starts when the queue empties and the shutdown runs when it ends', async () => {
    let executed = 0;
    const s = new ShutdownWhenDone({ countdownMs: 200, execute: async () => void executed++ });
    const seen = states(s);
    assert.deepEqual(s.state(), { armed: false, shutdownAt: null, unavailable: false });
    s.setArmed(true, false);
    assert.equal(s.state().shutdownAt, null, 'nothing happens while downloads are still running');
    s.queueChanged(false);
    s.queueChanged(true);
    assert.ok(s.state().shutdownAt! > Date.now(), 'countdown running');
    s.queueChanged(true); // repeated idle reports do not restart the countdown
    await sleep(350);
    assert.equal(executed, 1);
    assert.deepEqual(s.state(), { armed: false, shutdownAt: null, unavailable: false });
    assert.ok(seen.length >= 3);
    s.dispose();
  });

  test('new work during the countdown postpones it; disarming cancels it; idle at arming starts it at once', async () => {
    let executed = 0;
    const s = new ShutdownWhenDone({ countdownMs: 200, execute: async () => void executed++ });
    s.setArmed(true, true);
    assert.ok(s.state().shutdownAt !== null, 'idle when armed: countdown at once');
    s.queueChanged(false); // the user added something
    assert.equal(s.state().shutdownAt, null);
    assert.equal(s.state().armed, true, 'still armed for when that finishes');
    s.queueChanged(true);
    s.setArmed(false, true);
    assert.deepEqual(s.state(), { armed: false, shutdownAt: null, unavailable: false });
    await sleep(350);
    assert.equal(executed, 0, 'a cancelled countdown never shuts down');
    s.dispose();
  });

  test('a failed shutdown command disarms and reports the reason; unavailable builds never arm', async () => {
    const s = new ShutdownWhenDone({ countdownMs: 50, execute: async () => Promise.reject(new Error('Access is denied.')) });
    const errors: string[] = [];
    s.on('error', (m: string) => errors.push(m));
    s.setArmed(true, true);
    await sleep(200);
    assert.deepEqual(errors, ['Access is denied.']);
    assert.equal(s.state().armed, false);

    const none = new ShutdownWhenDone({ countdownMs: 50, execute: async () => {}, unavailable: true });
    assert.equal(none.setArmed(true, true).armed, false);
    assert.equal(none.state().unavailable, true);
  });

  test('the manager reports when nothing is left to download', async () => {
    server.route('/idle/a.bin', { body: randomBody(10_000) });
    const h = createHarness();
    assert.equal(h.manager.isIdle(), true);
    const d = h.manager.add({ url: server.url('/idle/a.bin'), startPaused: true });
    assert.equal(h.manager.isIdle(), true, 'a paused download does not keep the PC on');
    h.manager.resume(d.id);
    assert.equal(h.manager.isIdle(), false);
    await waitFor(h.manager, d.id, isState('completed'));
    assert.equal(h.manager.isIdle(), true);
    await h.manager.shutdown();
  });
});
