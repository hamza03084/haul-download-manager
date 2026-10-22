// End-to-end check of the real desktop app, driven through its UI with Playwright.
//   node scripts/e2e.mjs                 -> runs the development build (electron .)
//   node scripts/e2e.mjs --exe <path>    -> runs a packaged Haul Download Manager.exe
// Uses an isolated profile and download folder in %TEMP%; never touches your real data. The one
// exception is the packaged run's "start with Windows" check, which registers the exe under test in
// your HKCU Run key for a few seconds and removes it again.
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
const logFile = path.join(profile, 'logs', 'haul.log');
const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');

// ---------------------------------------------------------------- local server
const expiringBody = randomBytes(6_000_000);
const files = {
  '/files/quick.zip': { body: randomBytes(1_500_000), delay: 0 },
  '/files/slow-ranged.iso': { body: randomBytes(10_000_000), delay: 60 },
  '/files/to-cancel.bin': { body: randomBytes(6_000_000), delay: 25 },
  '/files/survives-restart.bin': { body: randomBytes(6_000_000), delay: 25 },
  '/files/windows-shutdown.bin': { body: randomBytes(6_000_000), delay: 25 },
  '/files/sorted.mp4': { body: randomBytes(300_000), delay: 0 },
  '/files/limited.bin': { body: randomBytes(1_500_000), delay: 0 },
  // The same file under two links: the first "expires" (403) once the test says so.
  '/files/expiring.bin': { body: expiringBody, delay: 25, expired: false },
  '/files/renewed.bin': { body: expiringBody, delay: 0 },
  '/files/shutdown-test.bin': { body: randomBytes(6_000_000), delay: 40 },
  '/files/background.bin': { body: randomBytes(3_000_000), delay: 25 },
};
const server = http.createServer(async (req, res) => {
  const f = files[req.url];
  if (!f) return res.writeHead(404).end();
  if (f.expired) return res.writeHead(403, { 'Content-Type': 'text/plain' }).end('link expired');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 20_000, every = 100) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return false;
    await sleep(every);
  }
}

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

/** Number of visible top-level windows titled "Haul Download Manager" (Windows API; a hidden window does not count). */
const winProbe = path.join(work, 'visible-windows.ps1');
fs.writeFileSync(
  winProbe,
  `Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class WinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static List<string> Visible() { var r = new List<string>(); EnumWindows((h,l)=>{ if(IsWindowVisible(h)){ var sb=new StringBuilder(256); GetWindowText(h,sb,256); if(sb.Length>0) r.Add(sb.ToString()); } return true; }, IntPtr.Zero); return r; }
}
"@
[WinEnum]::Visible() | Where-Object { $_ -eq 'Haul Download Manager' } | Measure-Object | Select-Object -ExpandProperty Count
`,
);
const visibleHaulWindows = () => Number(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winProbe], { encoding: 'utf8' }).trim());

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
function runKeyEntries() {
  try {
    return execFileSync('reg', ['query', RUN_KEY], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

async function launch(extraArgs = []) {
  const env = {
    ...process.env,
    HAUL_USER_DATA_DIR: profile,
    HAUL_DOWNLOAD_DIR: downloads,
    HAUL_DISABLE_PROTOCOL: '1',
    HAUL_NO_TOOL_DOWNLOADS: '1',
    // "Shut down when done" only logs instead of shutting down this PC, after a 3 s countdown.
    HAUL_FAKE_SHUTDOWN: '1',
    HAUL_SHUTDOWN_COUNTDOWN_MS: '3000',
    // Offline stand-in for yt-dlp (see tests/fixtures/fakeYtDlp.ts); the real one is exercised by live-test.mjs.
    HAUL_YTDLP_COMMAND: JSON.stringify([process.execPath, path.join(root, 'dist', 'tests', 'fixtures', 'fakeYtDlp.js')]),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!exe) {
    const app = await electron.launch({ args: [root, ...extraArgs], env, cwd: root });
    const win = await app.firstWindow();
    await win.waitForSelector('.app');
    await hideClipboardSuggestion(win);
    const pid = app.process().pid;
    return { app, win, kill: async () => killTree(pid), exited: null };
  }
  // Packaged builds disable Node's inspector via Electron fuses, so attach through Chromium's
  // DevTools protocol instead (the same thing a real user would run, no special build).
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(exe, [`--remote-debugging-port=${port}`, ...extraArgs], { env, stdio: 'ignore' });
  const exited = new Promise((r) => proc.once('exit', r));
  let browser;
  for (let i = 0; i < 100 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    if (!browser) await sleep(200);
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
      await Promise.race([exited, sleep(15_000)]);
      await browser.close().catch(() => {});
    },
  };
  const kill = async () => {
    killTree(proc.pid);
    await Promise.race([exited, sleep(10_000)]);
    await browser.close().catch(() => {});
  };
  return { app, win, kill, exited };
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
    await sleep(100);
  }
  throw new Error(`no progress for ${name}`);
}
async function openSettings(win) {
  await win.getByRole('button', { name: 'Settings' }).click();
  await win.locator('.sheet').waitFor();
}
async function saveSettings(win) {
  await win.getByRole('button', { name: 'Save settings' }).click();
  await win.locator('.sheet').waitFor({ state: 'detached' });
}

let app;
let lastWin = null;
let registeredStartup = false;
try {
  // ------------------------------------------------------------ first run
  let s = await launch();
  app = s.app;
  let win = s.win;
  lastWin = win;
  lastWin = win;
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
    await sleep(300);
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
  await openSettings(win);
  await win.getByRole('button', { name: 'Fewer' }).click();
  check('settings panel shows the app version', /Haul \d+\.\d+\.\d+/.test(await win.locator('.version').textContent()));
  check('settings offer start with Windows and keep-running-in-background', (await win.getByLabel('Start Haul when I sign in to Windows').count()) === 1 && (await win.getByLabel('Keep running in the background when the window is closed').count()) === 1);
  await win.screenshot({ path: path.join(outDir, '04-settings.png') });
  await saveSettings(win);
  await win.locator('.statusbar', { hasText: '2 at a time' }).waitFor();
  check('settings save (3 -> 2 simultaneous downloads)', true);

  // Expand details
  await card(win, 'quick.zip').locator('.card-main').click();
  await win.screenshot({ path: path.join(outDir, '05-details.png') });

  // --------------------------------------------- speed limit and categories (Settings)
  await openSettings(win);
  await win.getByLabel('Limit the download speed to').check();
  await win.getByLabel('Speed limit in KB/s').fill('abc');
  await win.getByRole('button', { name: 'Save settings' }).click();
  check('a non-numeric speed limit is refused with a message', (await win.locator('.sheet .form-error').textContent()).includes('whole number'));
  await win.getByLabel('Speed limit in KB/s').fill('200');
  await win.getByLabel('Sort downloads into folders by type').check();
  await saveSettings(win);
  const status = await win.locator('.statusbar').textContent();
  check('status bar shows the speed limit and sorting', status.includes('limit 200 KB/s') && status.includes('sorted by type'), status.trim());

  const t0 = Date.now();
  await addUrl(win, `${base}/files/limited.bin`);
  await waitPill(win, 'limited.bin', 'Done', 60_000);
  const limitedMs = Date.now() - t0;
  // 1.5 MB at 200 KB/s takes about 7 s; the local server would otherwise finish in well under a second.
  check('speed limit holds a 1.5 MB download to 200 KB/s', limitedMs >= 5_000 && sameBytes(path.join(downloads, 'limited.bin'), files['/files/limited.bin'].body), `${(limitedMs / 1000).toFixed(1)} s`);

  await addUrl(win, `${base}/files/sorted.mp4`);
  await waitPill(win, 'sorted.mp4', 'Done', 60_000);
  check('categories: an .mp4 is saved in the Video subfolder', sameBytes(path.join(downloads, 'Video', 'sorted.mp4'), files['/files/sorted.mp4'].body));
  await card(win, 'sorted.mp4').locator('.card-main').click();
  check('card details show the subfolder', (await card(win, 'sorted.mp4').locator('.card-details').textContent()).includes(`${path.join(downloads, 'Video')}\\sorted.mp4`));
  await card(win, 'sorted.mp4').locator('.card-main').click();
  await win.getByLabel('Filter by type').selectOption('video');
  check('type filter: Video shows only the video', (await win.locator('article.card').count()) === 1 && (await card(win, 'sorted.mp4').isVisible()));
  await win.getByLabel('Filter by type').selectOption('archives');
  check('type filter: Archives shows the .zip and .iso', (await win.locator('article.card').count()) === 2);
  await win.getByLabel('Filter by type').selectOption('all');

  await openSettings(win);
  await win.getByLabel('Limit the download speed to').uncheck();
  await saveSettings(win);
  check('speed limit can be turned off again', !(await win.locator('.statusbar').textContent()).includes('limit'));

  // ---------------------------------------------------------- change link (expired link)
  await addUrl(win, `${base}/files/expiring.bin`);
  await waitBytes(win, 'expiring.bin', 5);
  await card(win, 'expiring.bin').getByRole('button', { name: 'Pause' }).click();
  await waitPill(win, 'expiring.bin', 'Paused');
  files['/files/expiring.bin'].expired = true;
  await card(win, 'expiring.bin').getByRole('button', { name: 'Resume' }).click();
  await waitPill(win, 'expiring.bin', 'Failed', 60_000);
  check('an expired link fails with HTTP 403 and keeps the partial file', (await card(win, 'expiring.bin').locator('.card-error').textContent()).includes('HTTP 403') && fs.existsSync(path.join(downloads, 'expiring.bin.haulpart')));
  const keptBytes = fs.statSync(path.join(downloads, 'expiring.bin.haulpart')).size;
  await card(win, 'expiring.bin').getByRole('button', { name: 'Change link' }).click();
  await win.locator('.modal').waitFor();
  await win.screenshot({ path: path.join(outDir, '11-change-link.png') });
  await win.getByLabel('New link').fill('not a link');
  await win.getByRole('button', { name: 'Use this link' }).click();
  check('an invalid new link is refused inside the dialog', (await win.locator('.modal .form-error').textContent()).includes('not a valid URL'));
  await win.getByLabel('New link').fill(`${base}/files/renewed.bin`);
  await win.getByRole('button', { name: 'Use this link' }).click();
  await win.locator('.modal').waitFor({ state: 'detached' });
  await waitPill(win, 'expiring.bin', 'Done', 60_000);
  check('after changing the link, the download finished and is byte-identical', sameBytes(path.join(downloads, 'expiring.bin'), expiringBody));
  const resumedFrom = /renewed\.bin from byte (\d+)/.exec(readLog());
  check('...and it continued from the partial file instead of starting over', !!resumedFrom && Number(resumedFrom[1]) === keptBytes, resumedFrom ? `from byte ${resumedFrom[1]} of ${keptBytes}` : 'no Range request logged');

  // ---------------------------------------------------------- shut down when done
  await addUrl(win, `${base}/files/shutdown-test.bin`);
  await waitBytes(win, 'shutdown-test.bin', 1);
  await win.getByRole('button', { name: 'Shut down when done' }).click();
  await win.locator('button', { hasText: 'Shutting down when done' }).waitFor();
  check('shut down when done can be armed while a download runs', true);
  await win.locator('.modal.shutdown').waitFor({ timeout: 60_000 });
  check('once every download finished, a countdown appears', /shut down in \d+ seconds?/.test(await win.locator('.modal.shutdown').textContent()));
  await win.screenshot({ path: path.join(outDir, '12-shutdown-countdown.png') });
  await win.getByRole('button', { name: 'Cancel shutdown' }).click();
  await win.locator('.modal.shutdown').waitFor({ state: 'detached' });
  await sleep(3_500);
  check('cancelling the countdown prevents the shutdown', !readLog().includes('would be shut down now') && (await win.locator('button', { hasText: 'Shut down when done' }).count()) === 1);
  await win.getByRole('button', { name: 'Shut down when done' }).click();
  await win.locator('.modal.shutdown').waitFor({ timeout: 10_000 });
  check('arming it with nothing left to download starts the countdown at once', true);
  const shutDown = await until(() => readLog().includes('Windows would be shut down now'), 10_000);
  check('when the countdown ends, Haul asks Windows to shut down (simulated by HAUL_FAKE_SHUTDOWN)', shutDown);
  await win.locator('.modal.shutdown').waitFor({ state: 'detached' });

  // ---------------------------------------------------------- notification area (dev build only)
  // Needs the main process: closing the window must hide it instead of quitting, and the tray icon
  // (which Playwright cannot click) brings it back.
  if (!exe) {
    await openSettings(win);
    await win.getByLabel('Keep running in the background when the window is closed').check();
    await saveSettings(win);
    await addUrl(win, `${base}/files/background.bin`);
    await waitBytes(win, 'background.bin', 1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await sleep(500);
    const hidden = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1 && !BrowserWindow.getAllWindows()[0].isVisible());
    check('with "keep running in the background", closing the window hides it instead of quitting', hidden);
    check('a notification area icon exists', await app.evaluate(() => !!globalThis.__haulTray && !globalThis.__haulTray.isDestroyed()));
    const finished = await until(() => sameBytes(path.join(downloads, 'background.bin'), files['/files/background.bin'].body), 30_000, 250);
    check('downloads continue while the window is hidden', finished);
    await app.evaluate(() => globalThis.__haulTray.emit('click'));
    await sleep(500);
    check('clicking the notification area icon brings the window back', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()));
    await openSettings(win);
    await win.getByLabel('Keep running in the background when the window is closed').uncheck();
    await saveSettings(win);
  }

  // ---------------------------------------------------------- start with Windows (packaged build only)
  // Registers this exe in the current user's Run key for a moment, then removes it again.
  if (exe) {
    await openSettings(win);
    await win.getByLabel('Start Haul when I sign in to Windows').check();
    await saveSettings(win);
    registeredStartup = true;
    const entries = runKeyEntries();
    const line = entries.split(/\r?\n/).find((l) => l.toLowerCase().includes(exe.toLowerCase()));
    // The value name must match what build/installer.nsh removes on uninstall.
    check('start with Windows registers the exe (with --hidden) in the user\'s Run key', !!line && line.includes('--hidden') && line.includes('electron.app.Haul Download Manager'), line?.trim());
    await openSettings(win);
    await win.getByLabel('Start Haul when I sign in to Windows').uncheck();
    await saveSettings(win);
    registeredStartup = false;
    check('turning it off removes the Run key entry', !runKeyEntries().toLowerCase().includes(exe.toLowerCase()));
  }

  // Interrupt by closing the app mid-download
  await addUrl(win, `${base}/files/survives-restart.bin`);
  await waitBytes(win, 'survives-restart.bin', 5);
  const cardsBeforeRestart = await win.locator('article.card').count();
  await app.close();
  app = null;
  const part2 = path.join(downloads, 'survives-restart.bin.haulpart');
  check('closing the app keeps the partial file', fs.existsSync(part2) && fs.statSync(part2).size > 0);

  // ------------------------------------------------------------ second run
  s = await launch();
  app = s.app;
  win = s.win;
  lastWin = win;
  await waitPill(win, 'quick.zip', 'Done');
  check('history persists across restart', (await win.locator('article.card').count()) === cardsBeforeRestart, `${cardsBeforeRestart} entries`);
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
  // Categories are on: videos go to the Video subfolder, audio to Music.
  check('paused and resumed YouTube video is exact (video + sound joined) and sorted into Video', sameBytes(path.join(downloads, 'Video', videoName), expectedMedia([{ id: '298', size: 600_000 }, { id: '140', size: 200_000 }])));
  check('no partial-stream folder left behind', !fs.existsSync(path.join(downloads, 'Video', `${videoName}.haulparts`)));

  await addUrl(win, VIDEO);
  await win.locator('.picker-row').first().waitFor({ timeout: 30_000 });
  await win.getByRole('tab', { name: 'Audio only' }).click();
  await win.locator('.picker-row', { hasText: 'MP3' }).click();
  await win.getByLabel('Also save the thumbnail image (JPG)').check();
  await win.locator('.picker .btn-accent').click();
  await waitPill(win, `${TITLE}.mp3`, 'Done', 60_000);
  check('audio-only MP3 + thumbnail saved into Music', sameBytes(path.join(downloads, 'Music', `${TITLE}.mp3`), expectedMedia([{ id: '140', size: 200_000 }])) && fs.existsSync(path.join(downloads, 'Music', `${TITLE}.jpg`)));

  // ------------------------------------------- Windows shutting down mid-download
  // Needs access to the main process, so only in development mode. Windows sends 'session-end'
  // and may terminate the app right after it returns: simulate exactly that.
  if (!exe) {
    await addUrl(win, `${base}/files/windows-shutdown.bin`);
    await waitBytes(win, 'windows-shutdown.bin', 20);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('session-end', {}));
    await s.kill();
    app = null;
    check('Windows shutdown handler saved progress', readLog().includes('Windows is ending the session'));
    s = await launch();
    app = s.app;
    win = s.win;
  lastWin = win;
    await waitPill(win, 'windows-shutdown.bin', 'Done', 60_000);
    const resumed = /windows-shutdown\.bin from byte ([1-9]\d*)/.exec(readLog());
    check('after Windows shutdown + kill, the download continued from the saved point', !!resumed, resumed ? `from byte ${resumed[1]}` : 'started over');
    check('...and the file is byte-identical', sameBytes(path.join(downloads, 'windows-shutdown.bin'), files['/files/windows-shutdown.bin'].body));
  }
  await app.close();
  app = null;

  // ------------------------------------------------------------ started hidden (as at Windows sign-in)
  // The user's own Haul may be open too, so only the change in visible windows counts.
  const windowsBefore = visibleHaulWindows();
  s = await launch(['--hidden']);
  app = s.app;
  win = s.win;
  lastWin = win;
  await sleep(1_000);
  check('started with --hidden, the window stays hidden', visibleHaulWindows() === windowsBefore && /\) hidden\r?\n/.test(readLog()), `${windowsBefore} visible before and after`);
  if (!exe) await app.evaluate(() => globalThis.__haulTray.emit('click'));
  else spawn(exe, [], { env: { ...process.env, HAUL_USER_DATA_DIR: profile, HAUL_DISABLE_PROTOCOL: '1' }, stdio: 'ignore', detached: true }).unref(); // a second start brings the first one to the front
  const shown = await until(() => visibleHaulWindows() === windowsBefore + 1, 15_000, 500);
  check(exe ? 'starting Haul again shows the hidden window' : 'the notification area icon shows the hidden window', shown);
  await app.close();
  app = null;

  // ------------------------------------------------------------ damaged database
  fs.writeFileSync(path.join(profile, 'data', 'haul.db'), randomBytes(64 * 1024));
  s = await launch();
  app = s.app;
  win = s.win;
  lastWin = win;
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
  // Diagnostics: what the list showed, and the end of the app's log.
  try {
    const win = app?.win ?? lastWin;
    if (win) {
      const cards = await win.locator('article.card').evaluateAll((els) =>
        els.map((el) => `${el.querySelector('.card-name')?.textContent} | ${el.querySelector('.state-pill')?.textContent} | ${el.querySelector('.meta-text')?.textContent} | ${el.querySelector('.card-error, .card-notice')?.textContent ?? ''}`),
      );
      console.error('Cards:\n  ' + cards.join('\n  '));
      await win.screenshot({ path: path.join(outDir, '99-failure.png') }).catch(() => {});
    }
  } catch {}
  console.error('Log tail:\n' + readLog().split('\n').slice(-40).join('\n'));
} finally {
  if (app) await app.close().catch(() => {});
  if (registeredStartup && exe) {
    // Never leave the test build registered to start with Windows.
    try {
      execFileSync('reg', ['delete', RUN_KEY, '/v', 'electron.app.Haul Download Manager', '/f'], { stdio: 'ignore' });
    } catch {}
  }
  server.close();
  if (process.exitCode) {
    // Kept for inspection: the profile holds logs\haul.log and data\haul.db.
    console.error(`Kept the test profile and downloads for inspection: ${work}`);
  } else {
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      console.warn(`Could not remove ${work} (files still in use); delete it later.`);
    }
  }
}
