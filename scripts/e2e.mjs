// End-to-end check of the real desktop app, driven through its UI with Playwright.
//   node scripts/e2e.mjs                 -> runs the development build (electron .)
//   node scripts/e2e.mjs --exe <path>    -> runs a packaged Haul Download Manager.exe
// Uses an isolated profile and download folder in %TEMP%; never touches your real data.
import { _electron as electron, chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { expectedMedia } = createRequire(import.meta.url)(path.join(root, 'dist', 'tests', 'helpers', 'fakeMedia.js'));
const exeIdx = process.argv.indexOf('--exe');
const exe = exeIdx > 0 ? path.resolve(process.argv[exeIdx + 1]) : null;
const outDir = path.join(root, 'e2e-output');
fs.mkdirSync(outDir, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-e2e-'));
const profile = path.join(work, 'profile');
const downloads = path.join(work, 'downloads');

// ---------------------------------------------------------------- local server
const files = {
  '/files/quick.zip': { body: randomBytes(1_500_000), delay: 0 },
  '/files/slow-ranged.iso': { body: randomBytes(10_000_000), delay: 60 },
  '/files/to-cancel.bin': { body: randomBytes(6_000_000), delay: 25 },
  '/files/survives-restart.bin': { body: randomBytes(6_000_000), delay: 25 },
  '/files/windows-shutdown.bin': { body: randomBytes(6_000_000), delay: 25 },
};
const server = http.createServer(async (req, res) => {
  const f = files[req.url];
  if (!f) return res.writeHead(404).end();
  const etag = `"${createHash('sha1').update(f.body).digest('hex').slice(0, 12)}"`;
  let start = 0;
  const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  const headers = { 'Accept-Ranges': 'bytes', ETag: etag, 'Content-Type': 'application/octet-stream' };
  if (m && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
    start = Number(m[1]);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${f.body.length - 1}/${f.body.length}`, 'Content-Length': f.body.length - start });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': f.body.length });
  }
  for (let off = start; off < f.body.length && !res.destroyed; off += 64 * 1024) {
    if (!res.write(f.body.subarray(off, off + 64 * 1024))) await new Promise((r) => res.once('drain', r));
    if (f.delay) await new Promise((r) => setTimeout(r, f.delay));
  }
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------- helpers
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) throw new Error(`Check failed: ${name} ${detail}`);
};
const sameBytes = (file, body) => fs.existsSync(file) && fs.readFileSync(file).equals(body);

/** Ends a process tree abruptly (TerminateProcess): no shutdown code runs, like a crash or power cut. */
function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

/** The app reads the real clipboard; make sure nothing private from it ends up in screenshots. */
async function hideClipboardSuggestion(win) {
  await win.locator('[aria-label="Dismiss clipboard suggestion"]').click({ timeout: 1500 }).catch(() => {});
}

async function launch() {
  const env = {
    ...process.env,
    HAUL_USER_DATA_DIR: profile,
    HAUL_DOWNLOAD_DIR: downloads,
    HAUL_DISABLE_PROTOCOL: '1',
    HAUL_NO_TOOL_DOWNLOADS: '1',
    // Offline stand-in for yt-dlp (see tests/fixtures/fakeYtDlp.ts); the real one is exercised by live-test.mjs.
    HAUL_YTDLP_COMMAND: JSON.stringify([process.execPath, path.join(root, 'dist', 'tests', 'fixtures', 'fakeYtDlp.js')]),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!exe) {
    const app = await electron.launch({ args: [root], env, cwd: root });
    const win = await app.firstWindow();
    await win.waitForSelector('.app');
    await hideClipboardSuggestion(win);
    const pid = app.process().pid;
    return { app, win, kill: async () => killTree(pid) };
  }
  // Packaged builds disable Node's inspector via Electron fuses, so attach through Chromium's
  // DevTools protocol instead (the same thing a real user would run, no special build).
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(exe, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' });
  const exited = new Promise((r) => proc.once('exit', r));
  let browser;
  for (let i = 0; i < 100 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    if (!browser) await new Promise((r) => setTimeout(r, 200));
  }
  if (!browser) throw new Error('could not attach to the packaged app');
  const ctx = browser.contexts()[0];
  const win = ctx.pages()[0] ?? (await ctx.waitForEvent('page'));
  await win.waitForSelector('.app');
  await hideClipboardSuggestion(win);
  const app = {
    // Closing the window quits the app through its normal (graceful) shutdown path.
    close: async () => {
      await win.close().catch(() => {});
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
      await browser.close().catch(() => {});
    },
  };
  const kill = async () => {
    killTree(proc.pid);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    await browser.close().catch(() => {});
  };
  return { app, win, kill };
}
const card = (win, name) => win.locator('article.card', { has: win.locator('.card-name', { hasText: name }) });
async function addUrl(win, url) {
  await win.fill('.addbar-input', url);
  await win.press('.addbar-input', 'Enter');
}
async function waitPill(win, name, label, timeout = 30_000) {
  await card(win, name).locator('.state-pill', { hasText: label }).waitFor({ timeout });
}
async function waitBytes(win, name, min) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const pct = await card(win, name).locator('.pct').textContent().catch(() => '');
    if (parseFloat(pct ?? '') >= min) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no progress for ${name}`);
}

let app;
try {
  // ------------------------------------------------------------ first run
  let s = await launch();
  app = s.app;
  let win = s.win;
  await win.setViewportSize?.({ width: 1180, height: 760 });
  check('first run shows empty state', await win.locator('.empty h2', { hasText: 'Nothing in the hold yet' }).isVisible());
  await win.screenshot({ path: path.join(outDir, '01-empty.png') });

  // Invalid URL feedback
  await addUrl(win, 'ftp://example.com/file');
  await win.locator('.addbar-error').waitFor();
  check('invalid URL is rejected with a message', (await win.locator('.addbar-error').textContent()).includes('Only http and https'));
  await win.fill('.addbar-input', '');


  // Simple download
  await addUrl(win, `${base}/files/quick.zip`);
  await waitPill(win, 'quick.zip', 'Done');
  check('download completes and file is byte-identical', sameBytes(path.join(downloads, 'quick.zip'), files['/files/quick.zip'].body));
  let zone = '';
  try {
    zone = fs.readFileSync(`${path.join(downloads, 'quick.zip')}:Zone.Identifier`, 'utf8');
  } catch {}
  check('finished file carries the Mark of the Web (ZoneId=3)', /ZoneId=3/.test(zone) && !zone.includes('?'), zone.replace(/\s+/g, ' ').trim());

  // Pause / resume
  if (!exe) {
    // Count clipboard reads in the main process: they must not happen on every progress update.
    await app.evaluate(({ clipboard }) => {
      const orig = clipboard.readText.bind(clipboard);
      globalThis.__clipReads = 0;
      clipboard.readText = (...a) => {
        globalThis.__clipReads++;
        return orig(...a);
      };
    });
  }
  await addUrl(win, `${base}/files/slow-ranged.iso`);
  await waitBytes(win, 'slow-ranged.iso', 30);
  if (!exe) {
    const reads = await app.evaluate(() => globalThis.__clipReads);
    check('clipboard is not polled during downloads', reads === 0, `${reads} reads while downloading`);
    await win.evaluate(() => window.dispatchEvent(new Event('focus')));
    await new Promise((r) => setTimeout(r, 300));
    const afterFocus = await app.evaluate(() => globalThis.__clipReads);
    check('clipboard is read when the window gains focus (instrumentation works)', afterFocus === reads + 1, `${afterFocus} reads`);
  }
  check('pause is a labelled button on the card', await card(win, 'slow-ranged.iso').locator('.act-btn', { hasText: 'Pause' }).isVisible());
  check('card says the server supports resuming', await card(win, 'slow-ranged.iso').locator('.resume-tag', { hasText: 'Resumable' }).isVisible());

  // Adding the same link again while it downloads asks for confirmation instead of silently duplicating
  await addUrl(win, `${base}/files/slow-ranged.iso`);
  await win.locator('.addbar-error', { hasText: 'already in your list' }).waitFor();
  check('duplicate link is caught before a second copy is added', (await win.locator('article.card').count()) === 2);
  await win.fill('.addbar-input', '');

  await win.screenshot({ path: path.join(outDir, '02-downloading.png') });
  await card(win, 'slow-ranged.iso').getByRole('button', { name: 'Pause' }).click();
  await waitPill(win, 'slow-ranged.iso', 'Paused');
  const part = path.join(downloads, 'slow-ranged.iso.haulpart');
  const partSize = fs.existsSync(part) ? fs.statSync(part).size : 0;
  check('pause keeps a partial file', partSize > 0 && partSize < files['/files/slow-ranged.iso'].body.length, `${partSize} bytes`);
  await win.screenshot({ path: path.join(outDir, '03-paused.png') });
  await card(win, 'slow-ranged.iso').getByRole('button', { name: 'Resume' }).click();
  await waitPill(win, 'slow-ranged.iso', 'Done', 60_000);
  check('resumed download is byte-identical', sameBytes(path.join(downloads, 'slow-ranged.iso'), files['/files/slow-ranged.iso'].body));

  // Cancel
  await addUrl(win, `${base}/files/to-cancel.bin`);
  await waitBytes(win, 'to-cancel.bin', 3);
  await card(win, 'to-cancel.bin').getByRole('button', { name: 'Cancel download' }).click();
  await waitPill(win, 'to-cancel.bin', 'Cancelled');
  check(
    'cancel removes partial data',
    !fs.existsSync(path.join(downloads, 'to-cancel.bin.haulpart')) && !fs.existsSync(path.join(downloads, 'to-cancel.bin')),
  );

  // Settings
  await win.getByRole('button', { name: 'Settings' }).click();
  await win.getByRole('button', { name: 'Fewer' }).click();
  check('settings panel shows the app version', /Haul \d+\.\d+\.\d+/.test(await win.locator('.version').textContent()));
  await win.screenshot({ path: path.join(outDir, '04-settings.png') });
  await win.getByRole('button', { name: 'Save settings' }).click();
  await win.locator('.statusbar', { hasText: '2 at a time' }).waitFor();
  check('settings save (3 -> 2 simultaneous downloads)', true);

  // Expand details
  await card(win, 'quick.zip').locator('.card-main').click();
  await win.screenshot({ path: path.join(outDir, '05-details.png') });

  // ------------------------------------------------- YouTube: quality picker (fake yt-dlp)
  const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  const TITLE = 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film';
  await addUrl(win, `${VIDEO}&delay=300`);
  await win.locator('.picker-row').first().waitFor({ timeout: 30_000 });
  const qualities = await win.locator('.picker-row .picker-q').allTextContents();
  check('YouTube link opens the quality picker with every resolution', qualities.join(',') === '2160p60 (4K),1440p60 (2K),1080p60 (HD),720p60 (HD),480p,360p,240p,144p', qualities.join(', '));
  check('1080p is preselected', await win.locator('.picker-row.is-on', { hasText: '1080p60' }).isVisible());
  await win.screenshot({ path: path.join(outDir, '09-quality-picker.png') });
  await win.locator('.picker-row', { hasText: '720p60' }).click();
  check('download button names the choice and size', /Download 720p60 · H\.264 \(≈ /.test(await win.locator('.picker .btn-accent').textContent()));
  await win.locator('.picker .btn-accent').click();
  const videoName = `${TITLE}.mp4`;
  await card(win, videoName).waitFor();
  check('video card shows its quality', (await card(win, videoName).locator('.media-tag').textContent()) === '720p60 · H.264');
  await card(win, videoName).locator('.meta-text', { hasText: 'Downloading' }).waitFor({ timeout: 20_000 });
  await win.screenshot({ path: path.join(outDir, '10-video-downloading.png') });
  await card(win, videoName).getByRole('button', { name: 'Pause' }).click();
  await waitPill(win, videoName, 'Paused');
  await card(win, videoName).getByRole('button', { name: 'Resume' }).click();
  await waitPill(win, videoName, 'Done', 60_000);
  check('paused and resumed YouTube video is exact (video + sound joined)', sameBytes(path.join(downloads, videoName), expectedMedia([{ id: '298', size: 600_000 }, { id: '140', size: 200_000 }])));
  check('no partial-stream folder left behind', !fs.existsSync(path.join(downloads, `${videoName}.haulparts`)));

  await addUrl(win, VIDEO);
  await win.locator('.picker-row').first().waitFor({ timeout: 30_000 });
  await win.getByRole('tab', { name: 'Audio only' }).click();
  await win.locator('.picker-row', { hasText: 'MP3' }).click();
  await win.getByLabel('Also save the thumbnail image (JPG)').check();
  await win.locator('.picker .btn-accent').click();
  await waitPill(win, `${TITLE}.mp3`, 'Done', 60_000);
  check('audio-only MP3 + thumbnail saved', sameBytes(path.join(downloads, `${TITLE}.mp3`), expectedMedia([{ id: '140', size: 200_000 }])) && fs.existsSync(path.join(downloads, `${TITLE}.jpg`)));

  // Interrupt by closing the app mid-download
  await addUrl(win, `${base}/files/survives-restart.bin`);
  await waitBytes(win, 'survives-restart.bin', 5);
  await app.close();
  app = null;
  const part2 = path.join(downloads, 'survives-restart.bin.haulpart');
  check('closing the app keeps the partial file', fs.existsSync(part2) && fs.statSync(part2).size > 0);

  // ------------------------------------------------------------ second run
  s = await launch();
  app = s.app;
  win = s.win;
  await waitPill(win, 'quick.zip', 'Done');
  check('history persists across restart', (await win.locator('article.card').count()) === 6);
  check('settings persist across restart', (await win.locator('.statusbar').textContent()).includes('2 at a time'));
  await waitPill(win, 'survives-restart.bin', 'Done', 60_000);
  check('interrupted download continues after restart', sameBytes(path.join(downloads, 'survives-restart.bin'), files['/files/survives-restart.bin'].body));
  await win.screenshot({ path: path.join(outDir, '06-after-restart.png') });
  await win.emulateMedia({ colorScheme: 'dark' });
  await win.screenshot({ path: path.join(outDir, '07-dark-theme.png') });
  await win.emulateMedia({ colorScheme: 'light' });

  // Remove with file deletion
  await card(win, 'quick.zip').getByRole('button', { name: 'Remove from list' }).click();
  await win.getByLabel('Also delete the file from disk').check();
  await win.getByRole('button', { name: 'Remove and delete file' }).click();
  await card(win, 'quick.zip').waitFor({ state: 'detached' });
  check('remove + delete file', !fs.existsSync(path.join(downloads, 'quick.zip')));

  // ------------------------------------------- Windows shutting down mid-download
  // Needs access to the main process, so only in development mode. Windows sends 'session-end'
  // and may terminate the app right after it returns: simulate exactly that.
  if (!exe) {
    await addUrl(win, `${base}/files/windows-shutdown.bin`);
    await waitBytes(win, 'windows-shutdown.bin', 20);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('session-end', {}));
    await s.kill();
    app = null;
    const logFile = path.join(profile, 'logs', 'haul.log');
    check('Windows shutdown handler saved progress', fs.readFileSync(logFile, 'utf8').includes('Windows is ending the session'));
    s = await launch();
    app = s.app;
    win = s.win;
    await waitPill(win, 'windows-shutdown.bin', 'Done', 60_000);
    const resumed = /windows-shutdown\.bin from byte ([1-9]\d*)/.exec(fs.readFileSync(logFile, 'utf8'));
    check('after Windows shutdown + kill, the download continued from the saved point', !!resumed, resumed ? `from byte ${resumed[1]}` : 'started over');
    check('...and the file is byte-identical', sameBytes(path.join(downloads, 'windows-shutdown.bin'), files['/files/windows-shutdown.bin'].body));
  }
  await app.close();
  app = null;

  // ------------------------------------------------------------ damaged database
  fs.writeFileSync(path.join(profile, 'data', 'haul.db'), randomBytes(64 * 1024));
  s = await launch();
  app = s.app;
  win = s.win;
  await win.locator('.empty').waitFor();
  const kept = fs.readdirSync(path.join(profile, 'data')).filter((f) => f.includes('.corrupt-'));
  check('damaged history database: app still starts (empty list) and keeps the damaged file', kept.length > 0, kept.join(', '));
  check('downloaded files are untouched by the database reset', sameBytes(path.join(downloads, 'slow-ranged.iso'), files['/files/slow-ranged.iso'].body));
  await s.kill(); // a native "history was reset" message box is open; end the process directly
  app = null;

  console.log(`\nAll ${results.length} end-to-end checks passed. Screenshots: ${outDir}`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  server.close();
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    console.warn(`Could not remove ${work} (files still in use); delete it later.`);
  }
}
