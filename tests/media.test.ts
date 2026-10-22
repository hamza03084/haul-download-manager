import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MediaError,
  buildDownloadArgs,
  cleanError,
  locateMediaTools,
  parseOutputLine,
  summarizeInfo,
  type MediaTools,
} from '../src/main/engine/media';
import { validateMediaRequest } from '../src/main/engine/manager';
import { SqliteStore } from '../src/main/engine/store';
import { ValidationError } from '../src/main/engine/urls';
import type { AddDownloadRequest, DownloadView, MediaSpec } from '../src/shared/types';
import { createHarness, isState, tempDir, waitFor } from './helpers/harness';
import { expectedMedia, streamBytes } from './helpers/fakeMedia';

const fixture = () => JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'youtube-probe.json'), 'utf8'));
const FAKE = [process.execPath, path.join(__dirname, 'fixtures', 'fakeYtDlp.js')];
const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// ------------------------------------------------------------------ pure functions

describe('reading what yt-dlp reports', () => {
  test('summarises a real YouTube format list into qualities with exact streams and sizes', () => {
    const info = summarizeInfo(fixture(), VIDEO);
    assert.equal(info.title, 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film');
    assert.equal(info.uploader, 'Blender');
    assert.equal(info.durationSeconds, 635);
    assert.deepEqual(
      info.qualities.map((q) => q.height),
      [2160, 1440, 1080, 720, 480, 360, 240, 144],
    );
    const by = (h: number) => info.qualities.find((q) => q.height === h)!;
    // Highest frame rate first, then the most compatible codec (H.264 > VP9 > AV1).
    assert.deepEqual([by(1080).formatId, by(1080).codec, by(1080).label], ['299', 'H.264', '1080p60 (HD)']);
    assert.deepEqual([by(720).formatId, by(720).codec], ['298', 'H.264']);
    assert.deepEqual([by(2160).formatId, by(2160).codec, by(2160).label], ['315', 'VP9', '2160p60 (4K)']);
    assert.equal(by(2160).videoBytes, 1362269481);
    // Stereo AAC, not the loudness-compressed (DRC) or 5.1 copies.
    assert.equal(info.audioFormatId, '140');
    assert.equal(info.audioBytes, 10271496);
    assert.equal(info.hasThumbnail, true);
    assert.deepEqual(info.subtitles, []);
  });

  test('lists subtitles and refuses playlists and live streams', () => {
    const withSubs = { ...fixture(), subtitles: { en: [{ name: 'English' }], 'pt-BR': [{ name: 'Portuguese (Brazil)' }], live_chat: [{}] } };
    assert.deepEqual(summarizeInfo(withSubs, VIDEO).subtitles, [
      { code: 'en', name: 'English' },
      { code: 'pt-BR', name: 'Portuguese (Brazil)' },
    ]);
    assert.throws(() => summarizeInfo({ _type: 'playlist', entries: [] }, VIDEO), (e: unknown) => e instanceof MediaError && /playlist/.test(e.message));
    assert.throws(() => summarizeInfo({ ...fixture(), is_live: true }, VIDEO), /Live streams/);
    assert.throws(() => summarizeInfo({ id: 'x', formats: [] }, VIDEO), /no downloadable formats/);
  });

  test('parses progress, stream, post-processing and "already downloaded" lines', () => {
    assert.deepEqual(parseOutputLine('[haul] downloading|1024|28207144|NA|339040.67|135'), {
      type: 'progress',
      status: 'downloading',
      downloaded: 1024,
      total: 28207144,
      speed: 339041,
      formatId: '135',
    });
    assert.deepEqual(parseOutputLine('[haul] finished|NA|NA|5000|NA|140'), { type: 'progress', status: 'finished', downloaded: 0, total: 5000, speed: null, formatId: '140' });
    assert.deepEqual(parseOutputLine('[download] Destination: C:\\v\\Bunny.f299.mp4'), { type: 'destination', file: 'C:\\v\\Bunny.f299.mp4', stream: true });
    assert.equal((parseOutputLine('[download] Destination: C:\\v\\Bunny.en.vtt') as { stream: boolean }).stream, false);
    assert.equal(parseOutputLine('[download] C:\\v\\Bunny.f299.mp4 has already been downloaded')?.type, 'already');
    assert.deepEqual(parseOutputLine('[download] Resuming download at byte 14193023'), { type: 'resume', at: 14193023 });
    assert.deepEqual(parseOutputLine('[Merger] Merging formats into "C:\\v\\Bunny.mp4"'), { type: 'phase', phase: 'Joining video and sound…' });
    assert.equal(parseOutputLine('[VideoRemuxer] Not remuxing media file'), null);
    assert.equal(parseOutputLine('[youtube] aqz-KE-bpKQ: Downloading webpage'), null);
  });

  test('turns yt-dlp errors into short explanations', () => {
    assert.equal(cleanError('WARNING: x\nERROR: [youtube] aqz-KE-bpKQ: Private video. Sign in if you\'ve been granted access'), 'This video is private.');
    assert.match(cleanError("ERROR: [youtube] aqz-KE-bpKQ: Sign in to confirm you're not a bot. Use --cookies"), /not a bot/);
    assert.match(cleanError('ERROR: [youtube] aqz-KE-bpKQ: Video unavailable. This video has been removed'), /^The video is not available: Video unavailable/);
    assert.equal(cleanError('ERROR: unable to download video data: HTTP Error 403: Forbidden (caused by <HTTPError 403>)'), 'unable to download video data: HTTP Error 403: Forbidden');
    assert.equal(cleanError('just warnings'), '');
  });

  test('builds a command with no shell, no user config and the URL after "--"', () => {
    const tools: MediaTools = { ytDlp: ['C:\\yt\\yt-dlp.exe'], ffmpeg: 'C:\\yt\\ffmpeg.exe', jsRuntime: 'deno:C:\\yt\\deno.exe' };
    const spec = validateMediaRequest(mediaRequest({ thumbnail: true, subtitles: 'en' }));
    const args = buildDownloadArgs(spec, { url: VIDEO, home: 'C:\\dl', temp: 'C:\\dl\\x.haulparts', stem: '100% <done>', tools });
    assert.equal(args[0], '--ignore-config');
    assert.ok(args.includes('--no-playlist'));
    assert.deepEqual(args.slice(-2), ['--', VIDEO]);
    assert.equal(args[args.indexOf('-f') + 1], '299+140/bv*[height<=1080]+ba/b[height<=1080]');
    assert.equal(args[args.indexOf('-o') + 1], '100%% <done>.%(ext)s', 'percent signs are literal in the output template');
    const withPercent = buildDownloadArgs(spec, { url: VIDEO, home: 'C:\\dl', temp: 'C:\\dl\\50% off.mp4.haulparts', stem: '50% off', tools });
    assert.equal(withPercent[withPercent.indexOf('--print-to-file') + 2], 'C:\\dl\\50%% off.mp4.haulparts\\final-path.txt', '--print-to-file names are templates too');
    assert.equal(args[args.indexOf('--merge-output-format') + 1], 'mp4');
    assert.equal(args[args.indexOf('--js-runtimes') + 1], 'deno:C:\\yt\\deno.exe');
    assert.equal(args[args.indexOf('--sub-langs') + 1], 'en');
    assert.ok(args.includes('--write-thumbnail'));
    const audio = buildDownloadArgs(validateMediaRequest(mediaRequest({ mode: 'audio', audioFormat: 'mp3', height: null, videoFormatId: null })), {
      url: VIDEO, home: 'C:\\dl', temp: 'C:\\t', stem: 's', tools,
    });
    assert.equal(audio[audio.indexOf('-f') + 1], '140/ba');
    assert.equal(audio[audio.indexOf('--audio-format') + 1], 'mp3');
    assert.ok(audio.includes('-x'));
  });

  test('a quality choice from the UI cannot smuggle options onto the command line', () => {
    assert.equal(validateMediaRequest(mediaRequest()).videoFormatId, '299');
    for (const bad of [
      { videoFormatId: '299+140' },
      { videoFormatId: '--exec calc' },
      { audioFormatId: 'a b' },
      { subtitles: 'en,--exec' },
      { mode: 'script' },
      { height: 99 },
      { height: 1080.5 },
      { title: '' },
      { mode: 'audio', audioFormat: 'wav' },
    ]) {
      assert.throws(() => validateMediaRequest(mediaRequest(bad as never)), ValidationError, JSON.stringify(bad));
    }
    const audio = validateMediaRequest(mediaRequest({ mode: 'audio', audioFormat: 'm4a', height: 1080, videoFormatId: '299' }));
    assert.equal(audio.height, null, 'irrelevant fields are dropped');
    assert.equal(audio.videoFormatId, null);
  });

  test('finds yt-dlp, FFmpeg and Deno next to each other, on PATH or in winget links', () => {
    const dir = tempDir('haul-tools-');
    const tools = path.join(dir, 'tools');
    const links = path.join(dir, 'Microsoft', 'WinGet', 'Links');
    fs.mkdirSync(tools, { recursive: true });
    fs.mkdirSync(links, { recursive: true });
    const exe = (d: string, n: string) => fs.writeFileSync(path.join(d, process.platform === 'win32' ? `${n}.exe` : n), '');
    exe(tools, 'yt-dlp');
    exe(tools, 'deno');
    exe(links, 'ffmpeg');
    const env = { PATH: tools, LOCALAPPDATA: dir };
    const found = locateMediaTools({ env });
    assert.equal(found.status.problem, null);
    assert.equal(found.tools?.ytDlp[0], path.join(tools, path.basename(found.tools!.ytDlp[0])));
    assert.match(found.tools!.jsRuntime!, /^deno:/);
    assert.ok(found.tools!.ffmpeg!.startsWith(links));

    fs.rmSync(path.join(links, path.basename(found.tools!.ffmpeg!)));
    assert.match(locateMediaTools({ env }).status.problem ?? '', /FFmpeg/);
    assert.match(locateMediaTools({ env: { PATH: '' } }).status.problem ?? '', /need yt-dlp, which was not found.*winget install yt-dlp\.yt-dlp/);
    assert.match(locateMediaTools({ env, ytDlpPath: path.join(dir, 'nope.exe') }).status.problem ?? '', /location set in Settings/);
  });
});

describe('database upgrade', () => {
  test('a Haul 1.0 database (schema 1) is upgraded in place and keeps its history', () => {
    const dir = tempDir();
    const file = path.join(dir, 'old.db');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE downloads (id TEXT PRIMARY KEY, url TEXT NOT NULL, final_url TEXT, file_name TEXT NOT NULL,
      directory TEXT NOT NULL, file_name_settled INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, total_bytes INTEGER,
      downloaded_bytes INTEGER NOT NULL DEFAULT 0, resumable INTEGER, etag TEXT, last_modified TEXT, error TEXT, notice TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER);
      CREATE INDEX downloads_created ON downloads(created_at);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO downloads VALUES ('old-1','https://example.com/a.zip',NULL,'a.zip','${dir.replace(/'/g, "''")}',1,'paused',100,40,1,'"e"',NULL,NULL,NULL,1,2,NULL);
      INSERT INTO settings VALUES ('maxConcurrent','4'), ('resumeOnStartup','false');
      PRAGMA user_version = 1;`);
    db.close();

    const store = new SqliteStore(file);
    const [old] = store.loadAll();
    assert.equal(old.kind, 'http');
    assert.equal(old.media, null);
    assert.equal(old.downloadedBytes, 40);
    assert.equal(store.loadSettings().maxConcurrent, 4);
    const now = Date.now();
    const media: MediaSpec = validateMediaRequest(mediaRequest());
    store.upsert({ ...old, id: 'new-1', kind: 'media', media, createdAt: now, updatedAt: now });
    store.close();

    const again = new SqliteStore(file);
    const rows = again.loadAll();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find((r) => r.id === 'new-1')!.media, media);
    again.close();
    const check = new DatabaseSync(file);
    assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
    check.close();
  });
});

// ------------------------------------------------------------------ engine + fake yt-dlp

describe('video downloads through yt-dlp (fake yt-dlp)', () => {
  const harness = (opts: Parameters<typeof createHarness>[0] = {}) => createHarness({ mediaCommand: FAKE, ...opts });
  const url = (q: Record<string, string | number> = {}) =>
    `${VIDEO}&${new URLSearchParams(Object.entries(q).map(([k, v]): [string, string] => [k, String(v)]))}`;
  const read = (d: DownloadView) => fs.readFileSync(path.join(d.directory, d.fileName));

  test('lists qualities through the manager, and explains unavailable videos and playlists', async () => {
    const h = harness();
    const info = await h.manager.probeMedia(url(), new AbortController().signal);
    assert.equal(info.qualities[0].height, 2160);
    await assert.rejects(h.manager.probeMedia(url({ mode: 'unavailable' }), new AbortController().signal), (e: unknown) => e instanceof ValidationError && /not available/.test(e.message));
    await assert.rejects(h.manager.probeMedia(url({ mode: 'playlist' }), new AbortController().signal), /playlist/);
    const ac = new AbortController();
    const started = Date.now();
    const slow = h.manager.probeMedia(url({ mode: 'slowprobe' }), ac.signal);
    setTimeout(() => ac.abort(), 500);
    await assert.rejects(slow, (e: Error) => e.name === 'AbortError');
    assert.ok(Date.now() - started < 10_000, 'cancelling a lookup stops yt-dlp promptly');
    await h.manager.shutdown();
  });

  test('downloads video + sound, reports phases, and leaves only the finished file', async () => {
    const h = harness();
    const d = h.manager.add({ url: url({ delay: 2 }), media: mediaRequest() });
    assert.equal(d.kind, 'media');
    assert.equal(d.fileName, 'Big Buck Bunny.mp4');
    assert.equal(d.totalBytes, 800_000, 'estimate shown before the download starts');
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'));
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(expectedMedia([{ id: '299', size: 600_000 }, { id: '140', size: 200_000 }])), 'merged content is exact');
    assert.equal(done.downloadedBytes, 800_000);
    assert.deepEqual(fs.readdirSync(h.dir).filter((f) => f !== '.state'), ['Big Buck Bunny.mp4'], 'parts folder removed');
    const phases = new Set(h.events.filter((e) => e.id === d.id).map((e) => e.phase).filter(Boolean));
    for (const p of ['Downloading video (1 of 2)', 'Downloading sound (2 of 2)']) assert.ok(phases.has(p), `phase "${p}" in ${[...phases].join(', ')}`);
    const progress = h.events.filter((e) => e.id === d.id && e.state === 'downloading').map((e) => e.downloadedBytes);
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1], 'overall progress never goes backwards across streams');
    await h.manager.shutdown();
  });

  test('pause keeps partial streams and resume continues them to an exact file', async () => {
    const h = harness();
    const d = h.manager.add({ url: url({ delay: 60 }), media: mediaRequest({ title: 'Paused video' }) });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 150_000);
    await h.manager.pause(d.id);
    const paused = h.manager.get(d.id)!;
    assert.equal(paused.state, 'paused');
    assert.ok(paused.downloadedBytes > 0 && paused.downloadedBytes < 800_000, `${paused.downloadedBytes}`);
    const parts = path.join(h.dir, 'Paused video.mp4.haulparts');
    const partFile = fs.readdirSync(parts).find((f) => f.endsWith('.part'))!;
    const partSize = fs.statSync(path.join(parts, partFile)).size;
    await sleep(400);
    assert.equal(fs.statSync(path.join(parts, partFile)).size, partSize, 'yt-dlp really stopped (whole process tree)');
    h.manager.resume(d.id);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(expectedMedia([{ id: '299', size: 600_000 }, { id: '140', size: 200_000 }])));
    await h.manager.shutdown();
  });

  test('pausing while video and sound are being joined, then resuming, still gives an exact file', async () => {
    const h = harness();
    const d = h.manager.add({ url: url({ mergedelay: 3000 }), media: mediaRequest({ title: 'Paused while joining' }) });
    await waitFor(h.manager, d.id, (x) => x.phase === 'Joining video and sound…');
    await h.manager.pause(d.id);
    assert.equal(h.manager.get(d.id)!.state, 'paused');
    assert.ok(!fs.existsSync(path.join(h.dir, 'Paused while joining.mp4')), 'not reported or placed as finished');
    h.manager.resume(d.id);
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(expectedMedia([{ id: '299', size: 600_000 }, { id: '140', size: 200_000 }])));
    await h.manager.shutdown();
  });

  test('cancel stops yt-dlp and deletes its partial files', async () => {
    const h = harness();
    const d = h.manager.add({ url: url({ delay: 60 }), media: mediaRequest({ title: 'Cancelled video' }) });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 100_000);
    await h.manager.cancel(d.id);
    assert.equal(h.manager.get(d.id)!.state, 'cancelled');
    await sleep(300);
    assert.deepEqual(fs.readdirSync(h.dir).filter((f) => f !== '.state'), [], 'nothing left behind');
    await h.manager.shutdown();
  });

  test('a yt-dlp failure is reported with its reason, and closing Haul mid-download resumes next time', async () => {
    const h = harness();
    const bad = h.manager.add({ url: url({ failat: 100_000 }), media: mediaRequest({ title: 'Forbidden' }) });
    const failed = await waitFor(h.manager, bad.id, isState('failed', 'completed'));
    assert.equal(failed.state, 'failed');
    assert.match(failed.error ?? '', /HTTP Error 403/);

    const d = h.manager.add({ url: url({ delay: 60 }), media: mediaRequest({ title: 'Survives restart' }) });
    await waitFor(h.manager, d.id, (x) => x.downloadedBytes > 150_000);
    await h.manager.shutdown();
    assert.ok(fs.existsSync(path.join(h.dir, 'Survives restart.mp4.haulparts')), 'partial streams kept on close');
    const h2 = harness({ dir: h.dir, dbFile: h.dbFile });
    const done = await waitFor(h2.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(expectedMedia([{ id: '299', size: 600_000 }, { id: '140', size: 200_000 }])));
    await h2.manager.shutdown();
  });

  test('audio-only MP3 with thumbnail; odd titles become safe, unique file names', async () => {
    const h = harness();
    const audio = h.manager.add({
      url: url(),
      media: mediaRequest({ mode: 'audio', audioFormat: 'mp3', height: null, videoFormatId: null, thumbnail: true, title: 'Song: 100% "live"?' }),
    });
    const a = await waitFor(h.manager, audio.id, isState('completed', 'failed'));
    assert.equal(a.state, 'completed', a.error ?? '');
    assert.equal(a.fileName, 'Song_ 100% _live__.mp3');
    assert.ok(read(a).equals(streamBytes('140', 0, 200_000)));
    assert.ok(fs.existsSync(path.join(h.dir, 'Song_ 100% _live__.jpg')), 'thumbnail saved next to it');

    // A title that looks like a yt-dlp template field must stay literal everywhere (found with the real yt-dlp).
    const tricky = h.manager.add({ url: url(), media: mediaRequest({ title: '100% Real %(title)s test' }) });
    const tr = await waitFor(h.manager, tricky.id, isState('completed', 'failed'));
    assert.equal(tr.state, 'completed', tr.error ?? '');
    assert.equal(tr.fileName, '100% Real %(title)s test.mp4');
    assert.ok(!fs.readdirSync(h.dir).some((f) => f.includes('FAKE TITLE')), 'no stray folder from template expansion');

    const ids = [0, 1].map(() => h.manager.add({ url: url(), media: mediaRequest({ title: 'Same title' }) }).id);
    const names = (await Promise.all(ids.map((id) => waitFor(h.manager, id, isState('completed', 'failed'))))).map((x) => x.fileName).sort();
    assert.deepEqual(names, ['Same title (1).mp4', 'Same title.mp4']);
    await h.manager.shutdown();
  });

  test('after a Haul crash, a yt-dlp still running from before is stopped before continuing', async () => {
    // Windows does not end child processes when their parent crashes: the old yt-dlp keeps writing.
    const dir = tempDir();
    const dbFile = path.join(dir, '.state', 'orphan.db');
    const parts = path.join(dir, 'Orphan.mp4.haulparts');
    fs.mkdirSync(parts, { recursive: true });
    const orphanUrl = url({ delay: 150 });
    const orphan = spawn(FAKE[0], [FAKE[1], '-P', `home:${dir}`, '-P', `temp:${parts}`, '-o', 'Orphan.%(ext)s', '--print-to-file', 'after_move:filepath', path.join(parts, 'final-path.txt'), '-f', '299+140', '--', orphanUrl], { stdio: 'ignore' });
    fs.writeFileSync(path.join(parts, 'yt-dlp.pid'), String(orphan.pid));
    const orphanExit = new Promise((r) => orphan.once('exit', r));
    await sleep(800);
    const now = Date.now();
    const store = new SqliteStore(dbFile);
    store.upsert({
      id: 'crashed-media', kind: 'media', media: validateMediaRequest(mediaRequest({ title: 'Orphan' })), url: orphanUrl, finalUrl: null,
      fileName: 'Orphan.mp4', directory: dir, fileNameSettled: true, state: 'downloading', totalBytes: 800_000, downloadedBytes: 50_000,
      resumable: true, etag: null, lastModified: null, error: null, notice: null, createdAt: now, updatedAt: now, completedAt: null,
    });
    store.close();

    const h = harness({ dir, dbFile });
    const done = await waitFor(h.manager, 'crashed-media', isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    await Promise.race([orphanExit, sleep(2000)]);
    assert.notEqual(orphan.exitCode === null && orphan.signalCode === null, true, 'the leftover yt-dlp was stopped');
    assert.ok(read(done).equals(expectedMedia([{ id: '299', size: 600_000 }, { id: '140', size: 200_000 }])), 'no corruption from two writers');
    await h.manager.shutdown();
  });

  test('a video too big for the free disk space fails up front with a clear message', async () => {
    const h = harness({ getFreeSpace: async () => 1_000_000 });
    const d = h.manager.add({ url: url(), media: mediaRequest({ title: 'Too big', estimateVideo: 257_619_653, estimateAudio: 10_271_496 }) });
    const f = await waitFor(h.manager, d.id, isState('failed', 'completed'));
    assert.equal(f.state, 'failed');
    assert.match(f.error ?? '', /Not enough disk space: about 511 MB is needed/);
    assert.ok(!fs.readdirSync(h.dir).some((x) => x.startsWith('Too big') && !x.endsWith('.haulparts')), 'nothing downloaded');
    await h.manager.shutdown();
  });

  test('without yt-dlp, a video download fails with install instructions instead of hanging', async () => {
    const h = createHarness({ mediaCommand: null });
    h.manager.updateSettings({ ...h.manager.getSettings(), ytDlpPath: path.join(h.dir, 'missing', 'yt-dlp.exe') });
    const d = h.manager.add({ url: VIDEO, media: mediaRequest() });
    const f = await waitFor(h.manager, d.id, isState('failed'));
    assert.match(f.error ?? '', /yt-dlp was not found/);
    await assert.rejects(h.manager.probeMedia(VIDEO, new AbortController().signal), /yt-dlp was not found/);
    await h.manager.shutdown();
  });
});
