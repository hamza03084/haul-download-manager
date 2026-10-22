// Tests for video sites beyond YouTube (1.4): site detection, streams with sound built in, pages with
// one plain video, DRM refusal, and the browser extension's native messaging host.
import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildDownloadArgs, cleanError, summarizeInfo, type MediaTools } from '../src/main/engine/media';
import { validateMediaRequest } from '../src/main/engine/manager';
import { ValidationError, buildProtocolUrl, extractProtocolRequests, extractProtocolUrls, isMediaPage, refuseDrm } from '../src/main/engine/urls';
import { mediaSiteOf, mediaSiteOfUrl, drmSiteOf } from '../src/shared/types';
import {
  EXTENSION_ORIGIN,
  NATIVE_HOST_NAME,
  encodeMessage,
  readHostRegistration,
  readMessage,
  registerHostInRegistry,
  unregisterHostFromRegistry,
  writeHostManifest,
} from '../src/main/nativeHost';
import { createHarness, isState, tempDir, waitFor } from './helpers/harness';
import { expectedMedia, streamBytes } from './helpers/fakeMedia';
import type { AddDownloadRequest, DownloadView } from '../src/shared/types';

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'tests', 'fixtures', name), 'utf8'));
const FAKE = [process.execPath, path.join(__dirname, 'fixtures', 'fakeYtDlp.js')];
const VIMEO = 'https://vimeo.com/76979871';
const tools: MediaTools = { ytDlp: ['C:\\yt\\yt-dlp.exe'], ffmpeg: 'C:\\yt\\ffmpeg.exe', jsRuntime: null };

describe('which links are video pages', () => {
  test('known video sites open the picker; direct files on them and unknown hosts are plain downloads', () => {
    const page = (u: string) => mediaSiteOf(new URL(u));
    assert.equal(page('https://www.youtube.com/watch?v=x'), 'YouTube');
    assert.equal(page('https://youtu.be/x'), 'YouTube');
    assert.equal(page('https://vimeo.com/76979871'), 'Vimeo');
    assert.equal(page('https://player.vimeo.com/video/76979871'), 'Vimeo');
    assert.equal(page('https://www.dailymotion.com/video/x8abc'), 'Dailymotion');
    assert.equal(page('https://www.twitch.tv/videos/123'), 'Twitch');
    assert.equal(page('https://www.tiktok.com/@u/video/1'), 'TikTok');
    assert.equal(page('https://x.com/user/status/1'), 'X');
    assert.equal(page('https://twitter.com/user/status/1'), 'X');
    assert.equal(page('https://www.reddit.com/r/videos/comments/abc/x/'), 'Reddit');
    assert.equal(page('https://soundcloud.com/artist/track'), 'SoundCloud');
    assert.equal(page('https://i.redd.it/abc.jpg'), null, 'a direct image on a video site is a file');
    assert.equal(page('https://v.redd.it/abc/DASH_720.mp4'), null);
    assert.equal(page('https://www.youtube.com/anything.mp4'), 'YouTube', 'YouTube never serves files directly');
    assert.equal(page('https://example.com/video/123'), null, 'unknown sites download as files (the card then offers "Try as video")');
    assert.equal(page('https://notvimeo.com/x'), null);
    assert.equal(page('https://vimeo.com.evil.net/x'), null);
    assert.equal(mediaSiteOfUrl('vimeo.com/1'), null, 'not a URL');
    assert.ok(isMediaPage(new URL('https://www.bilibili.com/video/BV1')));
  });

  test('DRM services are refused everywhere a link can enter', () => {
    assert.equal(drmSiteOf(new URL('https://www.netflix.com/watch/1')), 'Netflix');
    assert.equal(drmSiteOf(new URL('https://open.spotify.com/track/1')), 'Spotify');
    assert.equal(drmSiteOf(new URL('https://www.vimeo.com/1')), null);
    assert.throws(() => refuseDrm(new URL('https://www.disneyplus.com/video/1')), (e: unknown) => e instanceof ValidationError && /copy protection/.test(e.message));
    const h = createHarness({ mediaCommand: FAKE });
    assert.throws(() => h.manager.add({ url: 'https://www.netflix.com/watch/1' }), /Netflix protects its videos with DRM/);
    assert.doesNotThrow(() => h.manager.add({ url: 'https://example.com/a.bin', startPaused: true }), 'an unknown host is a plain download');
    void h.manager.shutdown();
  });
});

describe('reading what other sites offer', () => {
  test('a site whose streams have sound built in (Vimeo) lists each size once and needs no separate audio', () => {
    const info = summarizeInfo(fixture('vimeo-probe.json'), VIMEO);
    assert.equal(info.site, 'Vimeo');
    assert.equal(info.title, 'The New Vimeo Player (You Know, For Videos)');
    assert.deepEqual(
      info.qualities.map((q) => [q.height, q.formatId, q.hasAudio, q.videoOnlyFormatId]),
      [
        [1080, 'http-1080p', true, null],
        [720, 'http-720p', true, null],
        [540, 'hls-fastly_skyfire-540p', true, null],
        [360, 'http-360p', true, null],
        [240, 'hls-fastly_skyfire-240p', true, null],
      ],
      'plain files are preferred over HLS at the same size',
    );
    assert.equal(info.qualities[0].videoBytes, 75_000_000);
    assert.equal(info.qualities[2].videoBytes, Math.round((1200 * 1000 * 120) / 8), 'HLS size estimated from bitrate');
    assert.equal(info.audioFormatId, null, 'no separate sound stream');
    assert.equal(info.audioBytes, null);
    const spec = validateMediaRequest({ ...choice(info, 720), videoId: info.videoId, title: info.title, label: '720p', estimateVideo: 37_500_000, estimateAudio: null });
    const args = buildDownloadArgs(spec, { url: VIMEO, home: 'C:\\dl', temp: 'C:\\t', stem: 's', tools });
    assert.equal(args[args.indexOf('-f') + 1], 'http-720p/bv*[height<=720]+ba/b[height<=720]', 'one stream, no "+audio"');
    assert.ok(!args.includes('-S'), 'the codec sort is for YouTube only');
    const audio = buildDownloadArgs(
      validateMediaRequest({ mode: 'audio', height: null, audioFormat: 'm4a', thumbnail: false, subtitles: null, videoFormatId: null, audioFormatId: null, videoId: 'x', title: 't', label: '', estimateVideo: null, estimateAudio: null }),
      { url: VIMEO, home: 'C:\\dl', temp: 'C:\\t', stem: 's', tools },
    );
    assert.equal(audio[audio.indexOf('-f') + 1], 'ba/b', 'audio is taken out of the best video when there is no sound stream');
  });

  test('YouTube keeps separate picture and sound streams, with "video only" available', () => {
    const info = summarizeInfo(fixture('youtube-probe.json'), 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
    assert.equal(info.site, 'YouTube');
    const q = info.qualities.find((x) => x.height === 1080)!;
    assert.deepEqual([q.formatId, q.hasAudio, q.videoOnlyFormatId], ['299', false, '299']);
    assert.equal(info.audioFormatId, '140');
  });

  test('a page with one plain video file offers "Best available"', () => {
    const info = summarizeInfo(fixture('generic-probe.json'), 'https://example.test/page');
    assert.equal(info.site, 'this page');
    assert.deepEqual(info.qualities.map((q) => [q.height, q.label, q.formatId, q.hasAudio]), [[0, 'Best available', '0', true]]);
    assert.equal(info.qualities[0].videoBytes, 12_345_678);
    const spec = validateMediaRequest({ ...choice(info, 0), videoId: 'clip', title: 'clip', label: '', estimateVideo: 12_345_678, estimateAudio: null });
    assert.equal(spec.label, 'Best available');
    const args = buildDownloadArgs(spec, { url: 'https://example.test/page', home: 'C:\\dl', temp: 'C:\\t', stem: 's', tools });
    assert.equal(args[args.indexOf('-f') + 1], '0/bv*+ba/b', 'no height limit when the site does not say');
    assert.ok(!args.includes('-S'), 'no sort outside YouTube: it would renumber streams that have no IDs of their own');
    assert.throws(() => validateMediaRequest({ ...choice(info, 0), height: 50, videoId: 'x', title: 't', label: '', estimateVideo: null, estimateAudio: null }), ValidationError);
  });

  test('files that report only their container (Internet Archive) count as picture with sound', () => {
    const info = summarizeInfo(
      {
        id: 'BigBuckBunny_124',
        title: 'Big Buck Bunny',
        extractor_key: 'ArchiveOrg',
        duration: 596,
        formats: [
          { format_id: '0', ext: 'ogv', height: 300, width: 533, protocol: 'https', filesize: 46_935_223, url: 'https://archive.org/x.ogv' },
          { format_id: '1', ext: 'mp4', height: 360, width: 640, protocol: 'https', filesize: 61_878_609, url: 'https://archive.org/x.mp4' },
          { format_id: '2', ext: 'avi', height: 720, width: 1280, protocol: 'https', filesize: 332_243_668, url: 'https://archive.org/x.avi' },
        ],
      },
      'https://archive.org/details/BigBuckBunny_124',
    );
    assert.equal(info.site, 'Internet Archive');
    assert.deepEqual(
      info.qualities.map((q) => [q.height, q.formatId, q.codec, q.hasAudio, q.videoOnlyFormatId]),
      [
        [720, '2', 'AVI', true, null],
        [360, '1', 'MP4', true, null],
        [300, '0', 'OGV', true, null],
      ],
    );
    assert.equal(info.audioFormatId, null);
  });

  test('yt-dlp errors from other sites are explained', () => {
    assert.match(cleanError('ERROR: Unsupported URL: https://example.com/page'), /found no video on this page/);
    assert.match(cleanError('ERROR: [vimeo] 1: Requested format is not available. Use --list-formats'), /no longer offered/);
    assert.match(cleanError('ERROR: [instagram] 1: login required'), /signed-in account/);
  });
});

describe('downloading from other sites (fake yt-dlp)', () => {
  const harness = (opts: Parameters<typeof createHarness>[0] = {}) => createHarness({ mediaCommand: FAKE, ...opts });
  const read = (d: DownloadView) => fs.readFileSync(path.join(d.directory, d.fileName));

  test('a Vimeo link is probed, downloaded as one stream with sound, and sorted like any video', async () => {
    const h = harness();
    h.manager.updateSettings({ ...h.manager.getSettings(), categoriesEnabled: true });
    const info = await h.manager.probeMedia(`${VIMEO}?site=vimeo`, new AbortController().signal);
    assert.equal(info.site, 'Vimeo');
    const q = info.qualities.find((x) => x.height === 720)!;
    const d = h.manager.add({
      url: `${VIMEO}?site=vimeo&vsize=300000&delay=40`,
      media: { ...choice(info, 720), videoId: info.videoId, title: info.title, label: '720p · H.264 + sound', estimateVideo: q.videoBytes, estimateAudio: null },
    });
    assert.equal(d.directory, path.join(h.dir, 'Video'));
    assert.equal(d.totalBytes, 37_500_000, 'the estimate is the whole file');
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(expectedMedia([{ id: 'http-720p', size: 300_000 }])), 'one stream, nothing joined');
    assert.equal(done.fileName, 'The New Vimeo Player (You Know, For Videos).mp4');
    const phases = new Set(h.events.filter((e) => e.id === d.id).map((e) => e.phase).filter(Boolean));
    assert.ok(phases.has('Downloading video'), [...phases].join(', '));
    await h.manager.shutdown();
  });

  test('an unknown page that is not a video fails with a clear reason; "best available" from a generic page works', async () => {
    const h = harness();
    await assert.rejects(h.manager.probeMedia('https://example.test/page?mode=unsupported', new AbortController().signal), /found no video on this page/);
    const info = await h.manager.probeMedia('https://example.test/page?site=generic', new AbortController().signal);
    assert.equal(info.qualities[0].label, 'Best available');
    const d = h.manager.add({
      url: 'https://example.test/page?site=generic&vsize=100000',
      media: { ...choice(info, 0), videoId: 'clip', title: 'clip', label: 'Best available', estimateVideo: null, estimateAudio: null },
    });
    const done = await waitFor(h.manager, d.id, isState('completed', 'failed'), 30_000);
    assert.equal(done.state, 'completed', done.error ?? '');
    assert.ok(read(done).equals(streamBytes('0', 0, 100_000)));
    await h.manager.shutdown();
  });
});

describe('browser extension: native messaging host', () => {
  test('replies are framed with a little-endian length and read back strictly', async () => {
    const framed = encodeMessage({ type: 'add', url: 'https://example.com/a.zip' });
    assert.equal(framed.readUInt32LE(0), framed.length - 4);
    const input = new PassThrough();
    const pending = readMessage(input, 2000);
    input.write(framed.subarray(0, 3)); // arrives in pieces
    input.write(framed.subarray(3));
    assert.deepEqual(await pending, { type: 'add', url: 'https://example.com/a.zip' });
    const empty = new PassThrough();
    const closed = readMessage(empty, 2000);
    empty.end();
    await assert.rejects(closed, /closed before/);
    await assert.rejects(readMessage(new PassThrough(), 50), /time limit/);
  });

  test('a haul:// link built from a captured download comes back whole', () => {
    const link = buildProtocolUrl({ url: 'https://example.com/a b.zip?x=1&y=2', fileName: 'My file.zip', referrer: 'https://example.com/page?p=1#top', auto: true });
    assert.ok(link.startsWith('haul://add?'));
    const [req] = extractProtocolRequests(['C:\\Haul.exe', link]);
    assert.deepEqual(req, { url: 'https://example.com/a%20b.zip?x=1&y=2', fileName: 'My file.zip', referrer: 'https://example.com/page?p=1#top', auto: true });
    assert.deepEqual(extractProtocolUrls([link]), ['https://example.com/a%20b.zip?x=1&y=2']);
    // The context-menu form carries no name and is not automatic.
    const [plain] = extractProtocolRequests(['haul://add?url=https%3A%2F%2Fexample.com%2Fb.zip']);
    assert.deepEqual(plain, { url: 'https://example.com/b.zip', fileName: null, referrer: null, auto: false });
    assert.deepEqual(extractProtocolRequests(['haul://add?url=javascript:alert(1)', 'haul://other?url=https://x/y']), []);
    assert.equal(buildProtocolUrl({ url: 'https://x/y', fileName: null, referrer: null, auto: false }), 'haul://add?url=https%3A%2F%2Fx%2Fy');
  });

  test('the host files: a .cmd running the script, and a manifest that allows only our extension', () => {
    const dir = tempDir('haul-host-');
    const direct = writeHostManifest(dir, { exe: 'C:\\Haul\\Haul Download Manager.exe', version: '1.4.0' });
    const manifest = JSON.parse(fs.readFileSync(direct.manifest, 'utf8'));
    assert.deepEqual(manifest, {
      name: NATIVE_HOST_NAME,
      description: 'Haul Download Manager: receives downloads from the browser extension.',
      path: path.join(dir, `${NATIVE_HOST_NAME}.cmd`),
      type: 'stdio',
      allowed_origins: [EXTENSION_ORIGIN],
    });
    const cmd = fs.readFileSync(direct.path, 'utf8');
    assert.match(cmd, /^@echo off\r\n/);
    assert.match(cmd, /powershell\.exe" -NoProfile -NonInteractive -NoLogo -ExecutionPolicy Bypass -File ".*\.ps1" %\*\r\n$/);
    const script = fs.readFileSync(direct.script, 'utf8');
    assert.match(script, /\$HaulExe = 'C:\\Haul\\Haul Download Manager\.exe'/);
    const dev = writeHostManifest(dir, { exe: "C:\\e's\\electron.exe", args: ['C:\\src\\app'], env: { HAUL_USER_DATA_DIR: 'C:\\p' }, version: '1.4.0' });
    const devScript = fs.readFileSync(dev.script, 'utf8');
    assert.match(devScript, /\$HaulExe = 'C:\\e''s\\electron\.exe'/, 'quotes are escaped the PowerShell way');
    assert.match(devScript, /\$Leading = @\('C:\\src\\app'\)/);
    assert.match(devScript, /\$env:HAUL_USER_DATA_DIR = 'C:\\p'/);
  });

  test('the host passes a browser download to Haul as a haul:// link and answers; bad input is refused', { timeout: 180_000 }, async () => {
    if (process.platform !== 'win32') return;
    // Node stands in for Haul: it records what it was started with.
    const dir = tempDir('haul-host-run-');
    const recorder = path.join(dir, 'fake-haul.js');
    const record = path.join(dir, 'started.txt');
    fs.writeFileSync(recorder, `require('fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + '\\n');`);
    const host = writeHostManifest(dir, { exe: process.execPath, args: [recorder], env: { HAUL_TEST_MARK: 'x' }, version: '9.9.9' });
    const ask = (message: unknown, origin = EXTENSION_ORIGIN) =>
      new Promise<{ reply: unknown; code: number | null; stderr: string }>((resolve) => {
        const proc = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', host.path, origin], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
        const reply = readMessage(proc.stdout, 60_000).catch((e: Error) => ({ ok: false, error: `no reply: ${e.message}` }));
        proc.stdin.write(encodeMessage(message));
        proc.on('exit', (code) => void reply.then((r) => resolve({ reply: r, code, stderr })));
      });
    const ping = await ask({ type: 'ping' });
    assert.deepEqual(ping.reply, { ok: true, version: '9.9.9' }, ping.stderr);
    assert.equal(ping.code, 0);

    const add = await ask({ type: 'add', url: 'https://example.com/a b.zip?x=1&y=2', fileName: ' My file.zip ', referrer: 'https://example.com/page?p=1', auto: true });
    // "running" here: the stand-in is node.exe, which this test process itself is.
    assert.deepEqual({ ...(add.reply as object), delivered: 'x' }, { ok: true, delivered: 'x', version: '9.9.9' }, add.stderr);
    assert.ok(['running', 'started'].includes((add.reply as { delivered: string }).delivered));
    // The stand-in Haul records its arguments a moment after the host has already answered.
    const recorded = async (n: number) => {
      const until = Date.now() + 10_000;
      for (;;) {
        const lines = fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean) : [];
        if (lines.length >= n || Date.now() > until) return lines;
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const started = (await recorded(1)).map((l) => JSON.parse(l) as string[]);
    assert.equal(started.length, 1, 'Haul was started once');
    const [req] = extractProtocolRequests(started[0]);
    assert.deepEqual(req, { url: 'https://example.com/a%20b.zip?x=1&y=2', fileName: 'My file.zip', referrer: 'https://example.com/page?p=1', auto: true }, started[0].join(' '));

    const menu = await ask({ type: 'add', url: 'https://example.com/c.zip', referrer: '', auto: false });
    assert.equal((menu.reply as { ok: boolean }).ok, true, menu.stderr);
    const lines = await recorded(2);
    assert.equal(lines.length, 2, 'the stand-in Haul was started a second time');
    assert.deepEqual(extractProtocolRequests(JSON.parse(lines[1]))[0], { url: 'https://example.com/c.zip', fileName: null, referrer: null, auto: false });

    for (const [bad, why] of [
      [{ type: 'add', url: 'ftp://x/y' }, /Only http and https/],
      [{ type: 'add', url: 'javascript:alert(1)' }, /Only http and https/],
      [{ type: 'run', url: 'https://x/y' }, /Unknown request/],
    ] as [unknown, RegExp][]) {
      const r = (await ask(bad)).reply as { ok: boolean; error?: string };
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.match(r.error ?? '', why);
    }
    const stranger = (await ask({ type: 'ping' }, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/')).reply as { ok: boolean; error?: string };
    assert.equal(stranger.ok, false);
    assert.match(stranger.error ?? '', /not allowed/);
    assert.equal(fs.readFileSync(record, 'utf8').trim().split('\n').length, 2, 'nothing was started for refused requests');
  });

  test('the registry points every supported browser at the manifest', async () => {
    if (process.platform !== 'win32') return;
    const dir = tempDir('haul-host-reg-');
    const host = writeHostManifest(dir, { exe: 'C:\\Haul\\Haul.exe', version: '1.4.0' });
    // A key of our own, so the real browsers' entries are never touched by the test.
    const keys = ['HKCU\\Software\\HaulTest\\NativeMessagingHosts'];
    try {
      assert.deepEqual(await registerHostInRegistry(host.manifest, keys), []);
      assert.equal(await readHostRegistration(keys[0]), host.manifest);
    } finally {
      await unregisterHostFromRegistry(keys);
      await unregisterHostFromRegistry(['HKCU\\Software\\HaulTest']).catch(() => {});
    }
    assert.equal(await readHostRegistration(keys[0]), null);
  });
});

/** The picker's choice for a listed size, as MediaPicker.tsx builds it. */
function choice(info: ReturnType<typeof summarizeInfo>, height: number): Omit<NonNullable<AddDownloadRequest['media']>, 'videoId' | 'title' | 'label' | 'estimateVideo' | 'estimateAudio'> {
  const q = info.qualities.find((x) => x.height === height)!;
  return { mode: 'video', height: q.height, audioFormat: null, thumbnail: false, subtitles: null, videoFormatId: q.formatId, audioFormatId: q.hasAudio ? null : info.audioFormatId };
}
