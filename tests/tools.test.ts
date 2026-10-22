import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { locateMediaTools } from '../src/main/engine/media';
import { ToolInstallError, ToolInstaller, defaultToolSources, findChecksum, type ToolSource } from '../src/main/engine/tools';
import type { ToolInstallStatus } from '../src/shared/types';
import { createHarness, isState, tempDir, waitFor } from './helpers/harness';
import { TestServer, randomBody } from './helpers/testServer';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

/** A zip shaped like the real release: the program (and for FFmpeg its DLLs) inside a versioned folder. */
function makeZip(dir: string, name: string, files: Record<string, Buffer>): Buffer {
  const src = tempDir('haul-zip-');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), body);
  }
  const zip = path.join(dir, name);
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(fs.existsSync(tar) ? tar : 'tar', ['-a', '-c', '-f', zip, '-C', src, ...fs.readdirSync(src)]);
  return fs.readFileSync(zip);
}

/** Serves fake releases of all three tools, with checksum lists in each project's real format. */
async function fakeReleases() {
  const server = new TestServer();
  await server.start();
  const work = tempDir('haul-rel-');
  const ytdlp = randomBody(300_000);
  const ffmpegExe = randomBody(50_000);
  const avcodec = randomBody(80_000);
  const denoExe = randomBody(120_000);
  const ffZip = makeZip(work, 'ff.zip', {
    'ffmpeg-master-latest-win64-gpl-shared/bin/ffmpeg.exe': ffmpegExe,
    'ffmpeg-master-latest-win64-gpl-shared/bin/ffprobe.exe': randomBody(1_000),
    'ffmpeg-master-latest-win64-gpl-shared/bin/ffplay.exe': randomBody(1_000),
    'ffmpeg-master-latest-win64-gpl-shared/bin/avcodec-62.dll': avcodec,
    'ffmpeg-master-latest-win64-gpl-shared/LICENSE.txt': Buffer.from('GPL'),
  });
  const denoZip = makeZip(work, 'deno.zip', { 'deno.exe': denoExe });
  const sources: ToolSource[] = defaultToolSources('x64').map((s) => ({
    ...s,
    url: server.url(`/${s.id}/${s.assetName}`),
    sumsUrl: server.url(`/${s.id}/sums`),
  }));
  const setYtDlp = (body: Buffer) => {
    server.route(`/yt-dlp/yt-dlp.exe`, { body });
    server.route(`/yt-dlp/sums`, {
      body: Buffer.from(`b7af77f686e95f7845ce8d09d21957718febb8b48b30555adb9dd2292ad7bf14  yt-dlp\n${sha(body)}  yt-dlp.exe\n`),
    });
  };
  setYtDlp(ytdlp);
  server.route('/ffmpeg/ffmpeg-master-latest-win64-gpl-shared.zip', { body: ffZip });
  server.route('/ffmpeg/sums', {
    body: Buffer.from(`${'1'.repeat(64)}  ffmpeg-master-latest-win32-gpl-shared.zip\n${sha(ffZip)}  ffmpeg-master-latest-win64-gpl-shared.zip\n`),
  });
  server.route('/deno/deno-x86_64-pc-windows-msvc.zip', { body: denoZip });
  // Deno publishes PowerShell Get-FileHash output (upper case, with the build machine's path).
  server.route('/deno/sums', {
    body: Buffer.from(
      `\r\nAlgorithm : SHA256\r\nHash      : ${sha(denoZip).toUpperCase()}\r\nPath      : C:\\a\\deno\\deno\\target\\release\\deno-x86_64-pc-windows-msvc.zip\r\n`,
    ),
  });
  return { server, sources, ytdlp, ffmpegExe, avcodec, denoExe, setYtDlp };
}

function installer(dir: string, sources: ToolSource[], over: Partial<ConstructorParameters<typeof ToolInstaller>[0]> = {}) {
  return new ToolInstaller({ dir, sources, timeoutMs: 5_000, retries: 2, retryDelayMs: 20, ...over });
}

describe('checksum lists', () => {
  test('reads the formats yt-dlp, FFmpeg-Builds and Deno publish', () => {
    const yt =
      'b7af77f686e95f7845ce8d09d21957718febb8b48b30555adb9dd2292ad7bf14  yt-dlp\n' +
      '33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555  yt-dlp.exe\n' +
      '1380a9f105302764e6a5d383c2f07238ae242f0f4fbf3414aea00e56619a79b3  yt-dlp_arm64.exe\n';
    assert.equal(findChecksum(yt, 'yt-dlp.exe'), '33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555');
    assert.equal(findChecksum(yt, 'yt-dlp_arm64.exe'), '1380a9f105302764e6a5d383c2f07238ae242f0f4fbf3414aea00e56619a79b3');
    assert.equal(findChecksum(yt, 'yt-dlp_x86.exe'), null);
    const deno =
      '\r\nAlgorithm : SHA256\r\nHash      : CBA84B26E0DF5AE7F74FC66B86A95B866872A86292EBD84FA1E959927EDD93BF\r\n' +
      'Path      : C:\\a\\deno\\deno\\target\\release\\deno-x86_64-pc-windows-msvc.zip\r\n';
    assert.equal(findChecksum(deno, 'deno-x86_64-pc-windows-msvc.zip'), 'cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf');
    assert.equal(findChecksum(deno, 'deno-aarch64-pc-windows-msvc.zip'), null, 'a hash for another file is not used');
    assert.equal(findChecksum('<html>Not Found</html>', 'yt-dlp.exe'), null);
  });

  test('official release addresses match this PC', () => {
    const x64 = defaultToolSources('x64');
    assert.deepEqual(
      x64.map((s) => s.url),
      [
        'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
        'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip',
        'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip',
      ],
    );
    assert.ok(defaultToolSources('arm64').every((s) => /arm64|aarch64/.test(s.assetName)));
  });
});

describe('getting the tools automatically', () => {
  test('downloads, checks and unpacks all three; Haul then finds them', async () => {
    const rel = await fakeReleases();
    const dir = path.join(tempDir(), 'tools');
    const inst = installer(dir, rel.sources);
    const seen: ToolInstallStatus[] = [];
    inst.on('status', (s: ToolInstallStatus) => seen.push(s));
    await inst.ensure();
    assert.deepEqual(fs.readFileSync(path.join(dir, 'yt-dlp.exe')), rel.ytdlp);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'ffmpeg.exe')), rel.ffmpegExe);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'avcodec-62.dll')), rel.avcodec, 'FFmpeg needs its DLLs next to it');
    assert.ok(fs.existsSync(path.join(dir, 'ffprobe.exe')));
    assert.ok(!fs.existsSync(path.join(dir, 'ffplay.exe')), 'the unused video player is left out');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'deno.exe')), rel.denoExe);
    assert.ok(!fs.existsSync(path.join(dir, '.staging')), 'no download left behind');
    assert.ok(seen.some((s) => s.state === 'installing' && s.tool === 'FFmpeg'), 'progress names the tool');
    assert.equal(seen.at(-1)?.state, 'idle');

    const found = locateMediaTools({ env: { PATH: '' }, managedDir: dir });
    assert.equal(found.status.problem, null);
    assert.equal(found.status.managed, true);
    assert.equal(found.tools?.ffmpeg, path.join(dir, 'ffmpeg.exe'));
    assert.equal(found.tools?.jsRuntime, `deno:${path.join(dir, 'deno.exe')}`);

    // Everything is there: nothing is downloaded again.
    const before = rel.server.requests.length;
    await inst.ensure();
    assert.equal(rel.server.requests.length, before);
    await rel.server.close();
  });

  test('a file that does not match the published checksum is never used', async () => {
    const rel = await fakeReleases();
    rel.server.route('/yt-dlp/yt-dlp.exe', { body: randomBody(300_000) }); // tampered or damaged
    const dir = path.join(tempDir(), 'tools');
    const inst = installer(dir, rel.sources);
    await assert.rejects(inst.ensure(), (e: unknown) => e instanceof ToolInstallError && /did not match the checksum/.test(e.message));
    assert.ok(!fs.existsSync(path.join(dir, 'yt-dlp.exe')));
    assert.ok(!fs.existsSync(path.join(dir, '.staging', 'yt-dlp.exe')), 'the rejected file is deleted');
    assert.equal(inst.status().state, 'failed');
    assert.match(inst.status().error ?? '', /checksum/);
    await rel.server.close();
  });

  test('a checksum list without the file, or a missing release, fails with a clear message', async () => {
    const rel = await fakeReleases();
    rel.server.route('/yt-dlp/sums', { body: Buffer.from(`${'a'.repeat(64)}  yt-dlp_linux\n`) });
    const dir = path.join(tempDir(), 'tools');
    await assert.rejects(installer(dir, rel.sources).ensure(), /does not mention yt-dlp\.exe/);
    rel.setYtDlp(rel.ytdlp);
    rel.server.route('/yt-dlp/yt-dlp.exe', { status: 404 });
    await assert.rejects(installer(dir, rel.sources).ensure(), /HTTP 404/);
    await rel.server.close();
  });

  test('a dropped connection is retried, and the retried file is checked as a whole', async () => {
    const rel = await fakeReleases();
    rel.server.route('/yt-dlp/yt-dlp.exe', { body: rel.ytdlp, dropAfter: 100_000 });
    const dir = path.join(tempDir(), 'tools');
    await installer(dir, rel.sources).ensure();
    assert.deepEqual(fs.readFileSync(path.join(dir, 'yt-dlp.exe')), rel.ytdlp);
    assert.equal(rel.server.requestsFor('/yt-dlp/yt-dlp.exe').length, 2);
    await rel.server.close();
  });

  test('several callers at once share one download', async () => {
    const rel = await fakeReleases();
    const dir = path.join(tempDir(), 'tools');
    const inst = installer(dir, rel.sources);
    await Promise.all([inst.ensure(), inst.ensure(), inst.update()]);
    assert.equal(rel.server.requestsFor('/ffmpeg/ffmpeg-master-latest-win64-gpl-shared.zip').length, 1);
    await rel.server.close();
  });

  test('a newer yt-dlp replaces the old one, checked at most once a day unless asked', async () => {
    const rel = await fakeReleases();
    const dir = path.join(tempDir(), 'tools');
    let now = 1_000_000;
    const inst = installer(dir, rel.sources, { now: () => now });
    await inst.update();
    const sumsAfterInstall = rel.server.requestsFor('/yt-dlp/sums').length;

    const newer = randomBody(310_000);
    rel.setYtDlp(newer);
    now += 60 * 60 * 1000; // an hour later: not checked yet
    await inst.update();
    assert.deepEqual(fs.readFileSync(path.join(dir, 'yt-dlp.exe')), rel.ytdlp);
    assert.equal(rel.server.requestsFor('/yt-dlp/sums').length, sumsAfterInstall);

    now += 24 * 60 * 60 * 1000;
    await inst.update();
    assert.deepEqual(fs.readFileSync(path.join(dir, 'yt-dlp.exe')), newer);

    // Same release again: checked, not downloaded.
    const downloads = rel.server.requestsFor('/yt-dlp/yt-dlp.exe').length;
    await inst.update(true);
    assert.equal(rel.server.requestsFor('/yt-dlp/yt-dlp.exe').length, downloads);
    await rel.server.close();
  });

  test('yt-dlp can be replaced while a video download is still using it', async () => {
    const rel = await fakeReleases();
    const dir = path.join(tempDir(), 'tools');
    const inst = installer(dir, rel.sources);
    await inst.ensure();
    // A real program running from the tools folder, as yt-dlp.exe is during a download.
    fs.copyFileSync(process.execPath, path.join(dir, 'yt-dlp.exe'));
    const child = spawn(path.join(dir, 'yt-dlp.exe'), ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    const newer = randomBody(320_000);
    rel.setYtDlp(newer);
    try {
      await inst.update(true);
      assert.ok(fs.readFileSync(path.join(dir, 'yt-dlp.exe')).equals(newer), 'the new copy is in place');
      assert.ok(fs.readdirSync(dir).some((n) => n.endsWith('.old')), 'the running copy was moved aside');
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    await inst.cleanUp();
    assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.old') || n === '.staging'), 'leftovers removed once it has stopped');
    await rel.server.close();
  });
});

describe('the download manager and automatic tools', () => {
  test('a video download waits for the tools, and explains when they cannot be downloaded', async () => {
    const server = new TestServer();
    await server.start();
    server.route('/yt-dlp/sums', { status: 503 }); // GitHub unavailable
    const sources = defaultToolSources('x64').map((s) => ({ ...s, url: server.url(`/${s.id}/file`), sumsUrl: server.url(`/${s.id}/sums`) }));
    const dir = tempDir();
    const inst = installer(path.join(dir, '.tools'), sources);
    const h = createHarness({ dir, mediaCommand: null, toolInstaller: inst });
    const d = h.manager.add({
      url: VIDEO,
      media: { mode: 'audio', height: null, audioFormat: 'm4a', thumbnail: false, subtitles: null, videoFormatId: null, audioFormatId: '140', videoId: 'aqz-KE-bpKQ', title: 'T', label: 'Audio · M4A', estimateVideo: null, estimateAudio: 1000 },
    });
    const f = await waitFor(h.manager, d.id, isState('failed'));
    assert.match(f.error ?? '', /Could not download yt-dlp: the server answered HTTP 503/);
    assert.ok(h.events.some((e) => e.id === d.id && /Getting the YouTube tools ready/.test(e.phase ?? '')), 'the card says what it is waiting for');
    assert.equal(server.requestsFor('/yt-dlp/sums').length, 3, 'tried three times');
    await assert.rejects(h.manager.probeMedia(VIDEO, new AbortController().signal), /HTTP 503/);
    const status = await h.manager.mediaToolsStatus();
    assert.equal(status.install?.state, 'failed');
    assert.match(status.problem ?? '', /HTTP 503/);
    await h.manager.shutdown();
    await server.close();
  });

  test('turned off in Settings, Haul never downloads anything and shows install instructions', async () => {
    const server = new TestServer();
    await server.start();
    const sources = defaultToolSources('x64').map((s) => ({ ...s, url: server.url(`/${s.id}/file`), sumsUrl: server.url(`/${s.id}/sums`) }));
    const dir = tempDir();
    const h = createHarness({ dir, mediaCommand: null, toolInstaller: installer(path.join(dir, '.tools'), sources) });
    h.manager.updateSettings({ ...h.manager.getSettings(), autoMediaTools: false });
    await h.manager.prepareMediaTools();
    await assert.rejects(h.manager.probeMedia(VIDEO, new AbortController().signal), /Get these tools automatically.*winget install/);
    assert.equal(server.requests.length, 0);
    assert.equal((await h.manager.mediaToolsStatus()).install, null);
    await h.manager.shutdown();
    await server.close();
  });
});
