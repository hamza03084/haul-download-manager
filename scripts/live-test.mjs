// Real-internet test of a packaged Haul build, using large public HD videos from the Blender
// Foundation's download server (open movies, CC BY). The videos are distributed as ZIP archives,
// whose built-in CRC-32 checksums prove that a resumed download is byte-for-byte intact.
// Not part of `npm test` or CI: it needs internet access and downloads ~400 MB.
//
//   node scripts/live-test.mjs --exe "<path to Haul Download Manager.exe>" [--ytdlp "<path to yt-dlp.exe>"] [--only youtube,site,crash,pause,ratelimit]
//
// Scenarios
//   youtube    With --ytdlp (ffmpeg, ffprobe and deno in the same folder): downloads a Creative Commons YouTube
//              video (Blender's Big Buck Bunny) at 720p60 with a hard kill, relaunch, pause and resume, then
//              1080p60 and audio-only MP3, and checks every file with ffprobe and a full ffmpeg decode.
//   crash      Starts a 125 MB 1080p video, kills the whole app process tree at ~35% (like a crash or
//              power cut: no shutdown code runs), relaunches, and checks that it continues from the
//              partial file (Range request in the log) and that the archive passes its CRC check.
//   pause      Starts a 275 MB 1080p video, pauses it with the Pause button, resumes, verifies CRC.
//   site       With --ytdlp: downloads a public-domain video from the Internet Archive (Big Buck Bunny, served
//              as plain MP4 files with the sound built in) through the picker and checks it with ffprobe/ffmpeg.
//              (Vimeo was the first choice, but its web client now needs a signed-in account for yt-dlp.)
//   ratelimit  Adds a Wikimedia Commons video; records how the app reports the server's rate limit.
// The crash and pause downloads run with the default 4 connections per download (parts), and record it.
// Uses an isolated profile and download folder in %TEMP%; never touches your real Haul data.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const exe = arg('--exe') && path.resolve(arg('--exe'));
if (!exe || !fs.existsSync(exe)) {
  console.error('Usage: node scripts/live-test.mjs --exe "<path to Haul Download Manager.exe>"');
  process.exit(2);
}
const only = (arg('--only') ?? 'youtube,site,crash,pause').split(',');
const ytDlp = arg('--ytdlp') && path.resolve(arg('--ytdlp'));
const ffprobeExe = ytDlp && path.join(path.dirname(ytDlp), 'ffprobe.exe');
const ffmpegExe = ytDlp && path.join(path.dirname(ytDlp), 'ffmpeg.exe');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-live-'));
const profile = path.join(work, 'profile');
const downloads = path.join(work, 'downloads');
const logFile = path.join(profile, 'logs', 'haul.log');

const FILES = {
  crash: {
    url: 'https://download.blender.org/demo/movies/caminandes_gran_dillama.mp4.zip',
    name: 'caminandes_gran_dillama.mp4.zip',
    size: 125632282,
  },
  pause: {
    url: 'https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_30fps_normal.mp4.zip',
    name: 'bbb_sunflower_1080p_30fps_normal.mp4.zip',
    size: 275524128,
  },
  ratelimit: {
    url: 'https://upload.wikimedia.org/wikipedia/commons/0/02/Glass_Half_-_Blender_Open_Movie-full_movie.webm',
    name: 'Glass_Half_-_Blender_Open_Movie-full_movie.webm',
  },
};
// Blender's official uploads of Big Buck Bunny (Creative Commons Attribution).
const YOUTUBE = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const SITE_VIDEO = 'https://archive.org/details/BigBuckBunny_124';

class SkipScenario extends Error {}
const results = [];
const record = (name, status, detail = '') => {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(6)} ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const size = (file) => (fs.existsSync(file) ? fs.statSync(file).size : null);
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

/**
 * Verifies every entry of a ZIP archive: decompresses it and compares the CRC-32 and size with the
 * values in the central directory. Any corrupted, missing or misplaced byte makes this fail.
 */
async function verifyZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    const tailLen = Math.min(total, 65_557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, total - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return { ok: false, detail: 'no end-of-central-directory record' };
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const entries = [];
    for (let p = 0, i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) return { ok: false, detail: 'bad central directory' };
      const nameLen = cd.readUInt16LE(p + 28);
      entries.push({
        method: cd.readUInt16LE(p + 10),
        crc: cd.readUInt32LE(p + 16),
        csize: cd.readUInt32LE(p + 20),
        usize: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
        name: cd.subarray(p + 46, p + 46 + nameLen).toString(),
      });
      p += 46 + nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
    }
    for (const e of entries) {
      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, e.offset);
      if (lh.readUInt32LE(0) !== 0x04034b50) return { ok: false, detail: `bad local header for ${e.name}` };
      const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      let crc = 0;
      let n = 0;
      const sink = new Writable({
        write(chunk, _enc, cb) {
          crc = zlib.crc32(chunk, crc);
          n += chunk.length;
          cb();
        },
      });
      const src = fs.createReadStream(file, { start, end: start + e.csize - 1 });
      if (e.method === 8) await pipeline(src, zlib.createInflateRaw(), sink);
      else if (e.method === 0) await pipeline(src, sink);
      else return { ok: false, detail: `unsupported compression ${e.method}` };
      if (crc >>> 0 !== e.crc || n !== e.usize) return { ok: false, detail: `${e.name}: CRC/size mismatch` };
    }
    return { ok: true, detail: entries.map((e) => `${e.name} ${mb(e.usize)} CRC ${e.crc.toString(16)} OK`).join('; ') };
  } catch (err) {
    return { ok: false, detail: `archive unreadable: ${err.message}` };
  } finally {
    fs.closeSync(fd);
  }
}

/** Streams and duration of a media file, via ffprobe. */
function ffprobe(file) {
  try {
    const out = JSON.parse(
      execFileSync(ffprobeExe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' }),
    );
    const v = out.streams.find((x) => x.codec_type === 'video' && x.codec_name !== 'mjpeg');
    const a = out.streams.find((x) => x.codec_type === 'audio');
    const video = v ? `${v.codec_name} ${v.width}x${v.height}` : '';
    const audio = a ? a.codec_name : '';
    const duration = Number(out.format?.duration ?? 0);
    return { ok: true, video, audio, duration, summary: `video ${video || 'none'}, audio ${audio || 'none'}, ${duration.toFixed(1)} s` };
  } catch (e) {
    return { ok: false, video: '', audio: '', duration: 0, summary: `ffprobe failed: ${String(e.message).slice(0, 200)}` };
  }
}

/** Decodes every frame; corrupted or missing data shows up as decoding errors. */
function decodeCheck(file) {
  const t0 = Date.now();
  try {
    const err = execFileSync(ffmpegExe, ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return { ok: !err.trim(), detail: `decoded in ${Math.round((Date.now() - t0) / 1000)} s, ${err.trim() ? 'errors: ' + err.slice(0, 200) : 'no errors'}` };
  } catch (e) {
    return { ok: false, detail: `decode errors: ${String(e.stderr ?? e.message).slice(0, 300)}` };
  }
}

/** Working set of the main process in bytes (the main process runs the download engine). */
function workingSet(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    const m = /"([\d,.\s]+) K"/.exec(out);
    return m ? Number(m[1].replace(/[^\d]/g, '')) * 1024 : null;
  } catch {
    return null;
  }
}

async function launch() {
  // HAUL_NO_TOOL_DOWNLOADS: never download yt-dlp/FFmpeg/Deno in the background during these tests.
  const env = { ...process.env, HAUL_USER_DATA_DIR: profile, HAUL_DOWNLOAD_DIR: downloads, HAUL_DISABLE_PROTOCOL: '1', HAUL_NO_TOOL_DOWNLOADS: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(exe, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' });
  const exited = new Promise((r) => proc.once('exit', r));
  let browser = null;
  for (let i = 0; i < 150 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    if (!browser) await sleep(200);
  }
  if (!browser) throw new Error('could not attach to the app');
  const ctx = browser.contexts()[0];
  const win = ctx.pages()[0] ?? (await ctx.waitForEvent('page'));
  await win.waitForSelector('.app');
  // Never let the user's real clipboard content appear in test output.
  await win.locator('[aria-label="Dismiss clipboard suggestion"]').click({ timeout: 1500 }).catch(() => {});
  return {
    win,
    pid: proc.pid,
    /** Graceful close through the window (normal user action). */
    close: async () => {
      await win.close().catch(() => {});
      await Promise.race([exited, sleep(20_000)]);
      await browser.close().catch(() => {});
    },
    /** Hard kill of the whole process tree: no shutdown code runs. */
    kill: async () => {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      await Promise.race([exited, sleep(10_000)]);
      await browser.close().catch(() => {});
    },
  };
}

const card = (win, name) => win.locator('article.card', { has: win.locator('.card-name', { hasText: name }) });
const pill = async (win, name) => (await card(win, name).locator('.state-pill').textContent({ timeout: 2000 }).catch(() => '')) ?? '';
const cardText = async (win, name) =>
  ((await card(win, name).locator('.card-meta, .card-notice, .card-error').allTextContents().catch(() => [])) ?? []).join(' | ').replace(/\s+/g, ' ').trim();
async function add(win, url) {
  await win.fill('.addbar-input', url);
  await win.press('.addbar-input', 'Enter');
}
async function waitPct(win, name, min, timeoutMs, onTick) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = parseFloat((await card(win, name).locator('.pct').textContent({ timeout: 2000 }).catch(() => '')) ?? '');
    onTick?.();
    if (p >= min) return p;
    if (/Failed/i.test(await pill(win, name))) throw new Error(`${name} failed: ${await cardText(win, name)}`);
    await sleep(500);
  }
  throw new Error(`${name} did not reach ${min}% in time`);
}
async function waitFinal(win, name, timeoutMs, onTick) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await pill(win, name);
    onTick?.();
    if (/Done|Failed|Cancelled/i.test(state)) return state.trim();
    await sleep(1000);
  }
  throw new Error(`${name} did not finish in time`);
}

let s = null;
try {
  console.log(`App: ${exe}\nWork folder: ${work}\n`);
  s = await launch();

  // --------------------------------------------- YouTube through a real yt-dlp
  try {
  if (only.includes('youtube')) {
    if (!ytDlp) {
      record('youtube: real yt-dlp scenario', 'SKIP', 'pass --ytdlp <path to yt-dlp.exe> (with ffmpeg/ffprobe/deno next to it) to run it');
    } else {
      // Point Haul at the user's yt-dlp the way a user would: Settings -> location -> Save.
      await s.win.getByRole('button', { name: 'Settings' }).click();
      await s.win.getByLabel('Location of yt-dlp.exe').fill(ytDlp);
      await s.win.getByRole('button', { name: 'Save settings' }).click();
      await s.win.locator('.sheet').waitFor({ state: 'detached' });

      // 1. 720p60 (~161 MB): hard kill mid-download, relaunch, pause, resume.
      const t0 = Date.now();
      await add(s.win, YOUTUBE);
      await s.win.locator('.picker-row, .picker-error').first().waitFor({ timeout: 120_000 });
      if (await s.win.locator('.picker-error').count()) {
        // YouTube refuses from time to time (its "not a bot" check): record it instead of aborting.
        const why = (await s.win.locator('.picker-error').textContent())?.replace(/\s+/g, ' ').trim();
        record('youtube: real yt-dlp scenario', 'SKIP', `YouTube refused the lookup, Haul explained it: "${why}"`);
        await s.win.getByRole('button', { name: 'Close' }).click();
        throw new SkipScenario();
      }
      const qualities = await s.win.locator('.picker-row .picker-q').allTextContents();
      record('youtube: quality picker lists the real formats', qualities.length >= 6 ? 'PASS' : 'FAIL', `${qualities.join(', ')} (lookup took ${Math.round((Date.now() - t0) / 1000)} s)`);
      await s.win.screenshot({ path: path.join(work, 'youtube-picker.png') });
      await s.win.locator('.picker-row', { hasText: '720p60' }).click();
      const button720 = (await s.win.locator('.picker .btn-accent').textContent()) ?? '';
      await s.win.locator('.picker .btn-accent').click();
      await sleep(1000);
      const v720 = (await s.win.locator('article.card .card-name').first().textContent())?.trim() ?? '';
      let peak = 0;
      const tick = () => (peak = Math.max(peak, workingSet(s.pid) ?? 0));
      const pct = await waitPct(s.win, v720, 30, 20 * 60_000, tick);
      const parts = path.join(downloads, `${v720}.haulparts`);
      const partBytes = () =>
        fs.existsSync(parts) ? fs.readdirSync(parts).filter((x) => x.endsWith('.part')).reduce((n, x) => n + fs.statSync(path.join(parts, x)).size, 0) : 0;
      await s.win.screenshot({ path: path.join(work, 'youtube-downloading.png') });
      await s.kill();
      s = null;
      const killedAt = partBytes();
      record('youtube: partial video survives a hard kill of the app', killedAt > 0 ? 'PASS' : 'FAIL', `killed at ${pct}%, ${mb(killedAt)} in .part files`);
      s = await launch();
      await waitPct(s.win, v720, Math.min(pct + 15, 90), 20 * 60_000, tick);
      await card(s.win, v720).getByRole('button', { name: 'Pause' }).click();
      const deadline = Date.now() + 20_000;
      while (!/Paused/i.test(await pill(s.win, v720)) && Date.now() < deadline) await sleep(200);
      const p1 = partBytes();
      await sleep(4000);
      record('youtube: pause stops yt-dlp (partial files stop growing)', /Paused/i.test(await pill(s.win, v720)) && p1 > 0 && p1 === partBytes() ? 'PASS' : 'FAIL', `${mb(p1)} on disk`);
      await card(s.win, v720).getByRole('button', { name: 'Resume' }).click();
      const state720 = await waitFinal(s.win, v720, 25 * 60_000, tick);
      const resumes = [...fs.readFileSync(logFile, 'utf8').matchAll(/continues a partial stream from byte (\d+)/g)].map((m) => mb(Number(m[1])));
      record('youtube: continued from partial data after the kill and after pause (not restarted)', resumes.length >= 2 ? 'PASS' : 'FAIL', `resumed at ${resumes.join(', ') || 'never'}`);
      const v720file = path.join(downloads, v720);
      const probe720 = ffprobe(v720file);
      record(
        'youtube: 720p video is a valid H.264 + AAC MP4 of the full length',
        state720 === 'Done' && probe720.ok && /h264/.test(probe720.video) && /1280x720/.test(probe720.video) && /aac/.test(probe720.audio) && Math.abs(probe720.duration - 635) < 3 ? 'PASS' : 'FAIL',
        `${button720.trim()} -> ${mb(size(v720file) ?? 0)}; ${probe720.summary}`,
      );
      const dec720 = decodeCheck(v720file);
      record('youtube: every frame of the resumed 720p video decodes without errors', dec720.ok ? 'PASS' : 'FAIL', dec720.detail);
      record('youtube: main-process peak memory (yt-dlp runs as its own process)', 'INFO', mb(peak));

      // 2. 1080p60 (~268 MB) straight through.
      await add(s.win, YOUTUBE);
      await s.win.locator('.picker-row').first().waitFor({ timeout: 120_000 });
      await s.win.locator('.picker-row', { hasText: '1080p60' }).click();
      await s.win.locator('.picker .btn-accent').click();
      await sleep(1000);
      const v1080 = (await s.win.locator('article.card .card-name').first().textContent())?.trim() ?? '';
      const state1080 = await waitFinal(s.win, v1080, 30 * 60_000);
      const v1080file = path.join(downloads, v1080);
      const probe1080 = ffprobe(v1080file);
      const dec1080 = decodeCheck(v1080file);
      record(
        'youtube: 1080p60 video (~268 MB) is complete and decodes cleanly',
        state1080 === 'Done' && probe1080.ok && /1920x1080/.test(probe1080.video) && Math.abs(probe1080.duration - 635) < 3 && dec1080.ok ? 'PASS' : 'FAIL',
        `${v1080}: ${mb(size(v1080file) ?? 0)}; ${probe1080.summary}; ${dec1080.detail}`,
      );

      // 3. Audio only, MP3, with thumbnail.
      await add(s.win, YOUTUBE);
      await s.win.locator('.picker-row').first().waitFor({ timeout: 120_000 });
      await s.win.getByRole('tab', { name: 'Audio only' }).click();
      await s.win.locator('.picker-row', { hasText: 'MP3' }).click();
      await s.win.getByLabel('Also save the thumbnail image (JPG)').check();
      await s.win.locator('.picker .btn-accent').click();
      await sleep(1000);
      const mp3 = (await s.win.locator('article.card .card-name').first().textContent())?.trim() ?? '';
      const stateMp3 = await waitFinal(s.win, mp3, 15 * 60_000);
      const mp3file = path.join(downloads, mp3);
      const probeMp3 = ffprobe(mp3file);
      const jpg = mp3file.replace(/\.mp3$/, '.jpg');
      record(
        'youtube: audio-only MP3 + thumbnail',
        stateMp3 === 'Done' && /mp3/.test(probeMp3.audio) && fs.existsSync(jpg) ? 'PASS' : 'FAIL',
        `${mp3}: ${mb(size(mp3file) ?? 0)}; ${probeMp3.summary}; thumbnail ${fs.existsSync(jpg) ? mb(size(jpg)) : 'missing'}`,
      );
      await s.win.screenshot({ path: path.join(work, 'youtube-done.png') });
    }
  }
  } catch (e) {
    if (!(e instanceof SkipScenario)) throw e;
  }

  // --------------------------------------------- another site through a real yt-dlp
  if (only.includes('site')) {
    if (!ytDlp) {
      record('site: real yt-dlp scenario', 'SKIP', 'pass --ytdlp <path to yt-dlp.exe> to run it');
    } else {
      await s.win.getByRole('button', { name: 'Settings' }).click();
      await s.win.getByLabel('Location of yt-dlp.exe').fill(ytDlp);
      await s.win.getByRole('button', { name: 'Save settings' }).click();
      await s.win.locator('.sheet').waitFor({ state: 'detached' });
      const t0 = Date.now();
      await add(s.win, SITE_VIDEO);
      await s.win.locator('.picker-row, .picker-error').first().waitFor({ timeout: 120_000 });
      if (await s.win.locator('.picker-error').count()) {
        const why = (await s.win.locator('.picker-error').textContent())?.replace(/\s+/g, ' ').trim();
        record('site: real yt-dlp scenario', 'SKIP', `the site refused the lookup, Haul explained it: "${why}"`);
        await s.win.getByRole('button', { name: 'Close' }).click();
      } else {
      const site = (await s.win.locator('.picker-kicker').textContent())?.trim();
      const rows = await s.win.locator('.picker-row').allTextContents();
      record('site: the picker opens for an Internet Archive link and lists its sizes', site === 'Internet Archive' && rows.length >= 1 ? 'PASS' : 'FAIL', `${site}: ${rows.map((r) => r.replace(/\s+/g, ' ').trim()).join(' | ')} (lookup took ${Math.round((Date.now() - t0) / 1000)} s)`);
      await s.win.screenshot({ path: path.join(work, 'site-picker.png') });
      const videoOnlyDisabled = await s.win.getByRole('tab', { name: 'Video only' }).isDisabled();
      record('site: "video only" availability (the site serves picture and sound together)', 'INFO', videoOnlyDisabled ? 'unavailable, as expected for combined streams' : 'available (separate streams offered)');
      // The 360p MP4 (59 MB) rather than the preselected 720p AVI (317 MB): same code path, far quicker.
      await s.win.locator('.picker-row', { hasText: '360p' }).click();
      await s.win.locator('.picker .btn-accent').click();
      await sleep(1000);
      // Haul names the file after the stream it really got (an .avi stays .avi), so find the card by
      // its title rather than its first name, and read the final name from the card afterwards.
      const siteTitle = ((await s.win.locator('article.card .card-name').first().textContent())?.trim() ?? '').replace(/\.[a-z0-9]+$/i, '');
      const stateV = await waitFinal(s.win, siteTitle, 20 * 60_000);
      const siteName = (await card(s.win, siteTitle).locator('.card-name').first().textContent())?.trim() ?? '';
      const vfile = path.join(downloads, siteName);
      const probeV = ffprobe(vfile);
      const decV = decodeCheck(vfile);
      record(
        'site: the video is a complete MP4 with picture and sound that decodes cleanly',
        stateV === 'Done' && probeV.ok && probeV.video && probeV.audio && decV.ok ? 'PASS' : 'FAIL',
        `${siteName}: ${mb(size(vfile) ?? 0)}; ${probeV.summary}; ${decV.detail}; card: ${await cardText(s.win, siteName)}`,
      );
      }
    }
  }

  // ------------------------------------------------- crash mid-download, resume
  if (only.includes('crash')) {
    const f = FILES.crash;
    await add(s.win, f.url);
    let peak = 0;
    const tick = () => (peak = Math.max(peak, workingSet(s.pid) ?? 0));
    const t0 = Date.now();
    let connectionsSeen = 0;
    const pct = await waitPct(s.win, f.name, 35, 15 * 60_000, () => {
      tick();
      void card(s.win, f.name).locator('.meta-text').textContent({ timeout: 1000 }).then((t) => {
        const m = /(\d+) connections/.exec(t ?? '');
        if (m) connectionsSeen = Math.max(connectionsSeen, Number(m[1]));
      }).catch(() => {});
    });
    record('parts: the Blender server serves the file in parts over several connections', connectionsSeen >= 2 ? 'PASS' : 'FAIL', `${connectionsSeen} connections shown on the card at ${pct}%`);
    const part = path.join(downloads, `${f.name}.haulpart`);
    const before = size(part);
    await s.kill();
    s = null;
    const after = size(part);
    record('crash: partial file survives a hard kill of the app', after > 0 ? 'PASS' : 'FAIL', `killed at ${pct}% after ${Math.round((Date.now() - t0) / 1000)} s; .haulpart ${mb(after ?? 0)}`);

    s = await launch();
    const afterRestart = await cardText(s.win, f.name);
    const state = await waitFinal(s.win, f.name, 15 * 60_000, tick);
    const log = fs.readFileSync(logFile, 'utf8');
    // Only Haul's own HTTP requests ("request <id> <url> from byte N"), not yt-dlp's resume lines.
    const resumedFrom = [...log.matchAll(/ INFO {2}request \S+ \S+ from byte (\d+)/g)].map((m) => Number(m[1]));
    record('crash: download continued after relaunch instead of starting over', resumedFrom.some((b) => b > 0) ? 'PASS' : 'FAIL', `Range request from byte ${resumedFrom.join(', ') || 'none'} (${mb(resumedFrom[0] ?? 0)}); card after relaunch: "${afterRestart.slice(0, 200)}"`);
    const final = path.join(downloads, f.name);
    const zip = await verifyZip(final);
    record('crash: resumed 125 MB 1080p video archive is intact (CRC-32)', state === 'Done' && size(final) === f.size && zip.ok ? 'PASS' : 'FAIL', `state=${state} size=${size(final)}/${f.size}; ${zip.detail}`);
    record('crash: main-process peak memory during the download', 'INFO', mb(peak));
  }

  // --------------------------------------------------------- pause and resume
  if (only.includes('pause')) {
    const f = FILES.pause;
    await add(s.win, f.url);
    await waitPct(s.win, f.name, 20, 15 * 60_000);
    await card(s.win, f.name).getByRole('button', { name: 'Pause' }).click();
    const deadline = Date.now() + 15_000;
    while (!/Paused/i.test(await pill(s.win, f.name)) && Date.now() < deadline) await sleep(200);
    const part = path.join(downloads, `${f.name}.haulpart`);
    const p1 = size(part);
    await sleep(4000);
    const p2 = size(part);
    record('pause: transfer stops and the partial file is kept', /Paused/i.test(await pill(s.win, f.name)) && p1 > 0 && p1 === p2 ? 'PASS' : 'FAIL', `${mb(p1 ?? 0)} on disk, unchanged after 4 s: ${p1 === p2}`);
    await card(s.win, f.name).getByRole('button', { name: 'Resume' }).click();
    const state = await waitFinal(s.win, f.name, 15 * 60_000);
    const log = fs.readFileSync(logFile, 'utf8');
    // In parts, the resume continues the first unfinished part, and the other parts follow from their own positions.
    const resumeLines = [...log.matchAll(/ INFO {2}request \S+ \S+ from byte (\d+)/g)].map((m) => Number(m[1]));
    const partsLines = [...log.matchAll(/(\d+) part\(s\) with up to (\d+) connections/g)].map((m) => `${m[1]} parts/${m[2]} conn`);
    record('pause: resume continued from the paused data (Range request) instead of starting over', resumeLines.some((b) => b > 0) ? 'PASS' : 'FAIL', `from byte ${resumeLines.join(', ') || 'none'}; parts: ${partsLines.join(', ') || 'none'}`);
    const final = path.join(downloads, f.name);
    const zip = await verifyZip(final);
    record('pause: resumed 275 MB 1080p video archive is intact (CRC-32)', state === 'Done' && size(final) === f.size && zip.ok ? 'PASS' : 'FAIL', `state=${state} size=${size(final)}/${f.size}; ${zip.detail}`);
  }

  // ------------------------------------------------------- server rate limit
  if (only.includes('ratelimit')) {
    const f = FILES.ratelimit;
    await add(s.win, f.url);
    const state = await waitFinal(s.win, f.name, 5 * 60_000);
    record('ratelimit: Wikimedia download outcome', 'INFO', `state=${state}; ${await cardText(s.win, f.name)}`);
  }

  await s.win.screenshot({ path: path.join(work, 'live-final.png') }).catch(() => {});
} catch (e) {
  record('live test aborted', 'FAIL', String(e?.message ?? e));
  if (s) await s.win.screenshot({ path: path.join(work, 'live-error.png') }).catch(() => {});
} finally {
  if (s) await s.close().catch(() => {});
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${results.length} checks, ${failed} failed. Work folder (screenshots, log, files): ${work}`);
  try {
    console.log('\n--- haul.log ---\n' + fs.readFileSync(logFile, 'utf8'));
  } catch {}
  process.exitCode = failed ? 1 : 0;
}
