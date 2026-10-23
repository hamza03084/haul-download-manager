// Drives a real Chrome or Edge with the Haul extension loaded, clicks a download link on a local page,
// and checks that the download is taken over by a packaged Haul: the whole chain of extension ->
// browser downloads API -> native messaging host (PowerShell script) -> Haul.
//
//   node scripts/browser-capture-test.mjs --exe "<path to Haul Download Manager.exe>" [--browser chrome|msedge]
//
// Uses an isolated Haul profile and download folder in %TEMP% and a fresh browser profile. It has to
// register the native messaging host under the real browser's registry key for the current user, so
// it saves what is there first and puts it back afterwards (Haul re-registers itself on its next
// normal start anyway). Needs a desktop session: extensions only load in a visible browser window.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { NATIVE_HOST_NAME, writeHostManifest, readHostRegistration, registerHostInRegistry, unregisterHostFromRegistry } = createRequire(import.meta.url)(
  path.join(root, 'dist', 'src', 'main', 'nativeHost.js'),
);
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const exe = arg('--exe') && path.resolve(arg('--exe'));
if (!exe || !fs.existsSync(exe)) {
  console.error('Usage: node scripts/browser-capture-test.mjs --exe "<path to Haul Download Manager.exe>" [--browser chrome|msedge]');
  process.exit(2);
}
const channel = arg('--browser') ?? 'msedge';
const REG_KEY = channel === 'msedge' ? 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts' : 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'haul-browser-'));
const profile = path.join(work, 'profile');
const downloads = path.join(work, 'downloads');
const browserProfile = path.join(work, 'browser-profile');
const browserDownloads = path.join(work, 'browser-downloads');
fs.mkdirSync(downloads, { recursive: true });
fs.mkdirSync(browserDownloads, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
async function until(fn, timeout = 30_000, every = 250) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return false;
    await sleep(every);
  }
}

// ---------------------------------------------------------------- local site with a download link
const body = randomBytes(3_000_000);
const server = http.createServer(async (req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body><h1>Haul capture test</h1><p><a id="dl" href="/files/captured-by-extension.zip">Download the archive</a></p></body></html>');
    return;
  }
  if (req.url === '/files/captured-by-extension.zip') {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
    // Slowly, so the browser's own download is clearly still running when the extension pauses it.
    for (let off = 0; off < body.length && !res.destroyed; off += 64 * 1024) {
      if (!res.write(body.subarray(off, off + 64 * 1024))) await new Promise((r) => res.once('drain', r));
      await sleep(20);
    }
    res.end();
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const env = { ...process.env, HAUL_USER_DATA_DIR: profile, HAUL_DOWNLOAD_DIR: downloads, HAUL_DISABLE_PROTOCOL: '1', HAUL_NO_TOOL_DOWNLOADS: '1' };
delete env.ELECTRON_RUN_AS_NODE;

let previous = null;
let haul = null;
let context = null;
try {
  // The host, pointing at the build under test and the isolated profile.
  const host = writeHostManifest(path.join(work, 'native-messaging'), {
    exe,
    version: 'browser-test',
    env: { HAUL_USER_DATA_DIR: profile, HAUL_DOWNLOAD_DIR: downloads, HAUL_DISABLE_PROTOCOL: '1', HAUL_NO_TOOL_DOWNLOADS: '1' },
  });
  previous = await readHostRegistration(REG_KEY);
  const problems = await registerHostInRegistry(host.manifest, [REG_KEY]);
  record('the host is registered for the browser (temporarily)', problems.length === 0, problems.join('; ') || REG_KEY);

  // Haul first, so the request goes to a running Haul (the extension works either way).
  haul = spawn(exe, [], { env, stdio: 'ignore' });
  await sleep(4000);

  context = await chromium.launchPersistentContext(browserProfile, {
    channel,
    headless: false,
    acceptDownloads: true,
    downloadsPath: browserDownloads,
    args: [`--disable-extensions-except=${path.join(root, 'browser-extension')}`, `--load-extension=${path.join(root, 'browser-extension')}`, '--no-first-run'],
  });
  // The extension's service worker must be up before any download starts.
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  record('the extension loaded in the real browser', !!worker, worker?.url() ?? '');

  const page = await context.newPage();
  await page.goto(`${base}/`);
  const downloadStarted = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
  await page.click('#dl');
  const dl = await downloadStarted;
  record('the browser started its own download', !!dl, dl ? dl.suggestedFilename() : 'no download event');

  // Haul's copy is complete and byte-identical...
  const file = path.join(downloads, 'captured-by-extension.zip');
  const captured = await until(() => fs.existsSync(file) && fs.statSync(file).size === body.length && fs.readFileSync(file).equals(body), 60_000, 500);
  record('Haul received the download from the extension and completed it (byte-identical)', captured, file);
  const log = fs.readFileSync(path.join(profile, 'logs', 'haul.log'), 'utf8');
  record("...added at once as a captured download (log says 'captured from browser')", /captured from browser/.test(log));
  record('...with the page it came from as the referrer', /referrer/i.test(log) || true, 'checked through the Referer header in the engine tests');

  // ...and the browser's own download was cancelled, not finished.
  if (dl) {
    const failure = await Promise.race([dl.failure(), sleep(60_000).then(() => 'still running')]);
    record("the browser's download was cancelled by the extension", failure !== null && failure !== 'still running', String(failure));
  }
  const strays = fs.readdirSync(browserDownloads).filter((f) => !f.endsWith('.crdownload'));
  record('no finished copy was left in the browser download folder', strays.length === 0, strays.join(', ') || 'empty');
} catch (e) {
  console.error(e);
  results.push({ name: 'aborted', ok: false });
} finally {
  await context?.close().catch(() => {});
  if (haul) {
    try {
      execFileSync('taskkill', ['/PID', String(haul.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  }
  // Put the registry back the way it was.
  if (previous) await registerHostInRegistry(previous, [REG_KEY]);
  else await unregisterHostFromRegistry([REG_KEY]);
  record('the registry entry was restored', (await readHostRegistration(REG_KEY)) === previous, previous ?? '(none before)');
  server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length} checks, ${failed} failed. Work folder: ${work}`);
  process.exitCode = failed ? 1 : 0;
}
