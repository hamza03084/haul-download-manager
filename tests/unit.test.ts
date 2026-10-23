import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  fileNameFromUrl,
  parseContentDisposition,
  sanitizeFileName,
  uniqueFileName,
  withExtensionForMime,
} from '../src/main/engine/filename';
import { parseContentRange, parseRetryAfter, parseUnsatisfiedRange, isStrongEtag } from '../src/main/engine/http';
import { ValidationError, extractProtocolUrls, redactText, redactUrl, validateDownloadUrl } from '../src/main/engine/urls';
import { SpeedMeter } from '../src/main/engine/speed';
import { validateSettings } from '../src/main/engine/manager';
import { formatBytes, formatDuration } from '../src/shared/format';

test('validateDownloadUrl accepts http(s) and rejects everything else', () => {
  assert.equal(validateDownloadUrl('  https://example.com/a.zip ').href, 'https://example.com/a.zip');
  assert.equal(validateDownloadUrl('http://127.0.0.1:8080/x').protocol, 'http:');
  for (const bad of ['', '   ', 'not a url', 'ftp://example.com/a', 'javascript:alert(1)', 'file:///C:/Windows/win.ini', 'example.com/a.zip', 42]) {
    assert.throws(() => validateDownloadUrl(bad), ValidationError, `should reject ${String(bad)}`);
  }
  assert.throws(() => validateDownloadUrl(`https://e.com/${'a'.repeat(9000)}`), /too long/);
});

test('redactUrl hides credentials, query values and fragments', () => {
  assert.equal(
    redactUrl('https://user:secret@cdn.example.com/f.zip?token=abc123&sig=xyz#frag'),
    'https://cdn.example.com/f.zip?token=***&sig=***',
  );
  assert.equal(redactUrl('https://example.com/plain.iso'), 'https://example.com/plain.iso');
  assert.equal(redactText('GET https://x.io/a?key=SECRET failed'), 'GET https://x.io/a?key=*** failed');
  assert.ok(!redactText('see https://a.b/c?token=hunter2').includes('hunter2'));
});

test('sanitizeFileName produces safe Windows names', () => {
  assert.equal(sanitizeFileName('report:2024?.pdf'), 'report_2024_.pdf');
  assert.equal(sanitizeFileName('../../Windows/System32/evil.dll'), 'evil.dll');
  assert.equal(sanitizeFileName('..\\..\\boot.ini'), 'boot.ini');
  assert.equal(sanitizeFileName('CON'), '_CON');
  assert.equal(sanitizeFileName('nul.txt'), '_nul.txt');
  assert.equal(sanitizeFileName('lpt1'), '_lpt1');
  assert.equal(sanitizeFileName('trailing dots... '), 'trailing dots');
  assert.equal(sanitizeFileName('a\u0000b\u001fc.txt'), 'abc.txt');
  assert.equal(sanitizeFileName(''), 'download');
  assert.equal(sanitizeFileName('...'), 'download');
  assert.equal(sanitizeFileName('.gitignore'), '.gitignore');
  // Reserved device names are reserved whatever follows the first dot.
  assert.equal(sanitizeFileName('NUL.tar.gz'), '_NUL.tar.gz');
  assert.equal(sanitizeFileName('con.min.js'), '_con.min.js');
  assert.equal(sanitizeFileName('aux .txt'), '_aux .txt');
  assert.equal(sanitizeFileName('console.log'), 'console.log');
  // Invisible direction marks cannot disguise an extension.
  assert.equal(sanitizeFileName('invoice\u202Efdp.exe'), 'invoicefdp.exe');
  assert.equal(sanitizeFileName('a\u200Bb\u2066c\uFEFF.txt'), 'abc.txt');
  const long = sanitizeFileName(`${'x'.repeat(400)}.tar.gz`);
  assert.ok(long.length <= 180, `length ${long.length}`);
  assert.ok(long.endsWith('.gz'));
});

test('parseContentDisposition handles quoted, plain and RFC 5987 names', () => {
  assert.equal(parseContentDisposition('attachment; filename="My File.zip"'), 'My File.zip');
  assert.equal(parseContentDisposition('attachment; filename=plain.bin'), 'plain.bin');
  assert.equal(parseContentDisposition(`attachment; filename="fallback.txt"; filename*=UTF-8''%E2%82%AC%20rates.txt`), '€ rates.txt');
  assert.equal(parseContentDisposition('attachment; filename="say \\"hi\\".txt"'), 'say "hi".txt');
  assert.equal(parseContentDisposition('inline'), null);
  assert.equal(parseContentDisposition(undefined), null);
});

test('fileNameFromUrl and withExtensionForMime', () => {
  assert.equal(fileNameFromUrl('https://e.com/dir/My%20Setup.exe?x=1'), 'My Setup.exe');
  assert.equal(fileNameFromUrl('https://e.com/'), null);
  assert.equal(withExtensionForMime('index', 'text/html; charset=utf-8'), 'index.html');
  assert.equal(withExtensionForMime('a.bin', 'text/html'), 'a.bin');
  assert.equal(withExtensionForMime('blob', 'application/x-unknown'), 'blob');
});

test('uniqueFileName appends (n) before the extension', () => {
  const dir = path.resolve('/tmp/x');
  const taken = new Set([path.join(dir, 'a.zip'), path.join(dir, 'a (1).zip')]);
  assert.equal(uniqueFileName(dir, 'a.zip', (p) => taken.has(p)), 'a (2).zip');
  assert.equal(uniqueFileName(dir, 'b.zip', (p) => taken.has(p)), 'b.zip');
  assert.equal(uniqueFileName(dir, 'noext', () => false), 'noext');
});

test('Content-Range and Retry-After parsing', () => {
  assert.deepEqual(parseContentRange('bytes 100-199/200'), { start: 100, end: 199, total: 200 });
  assert.deepEqual(parseContentRange('bytes 0-9/*'), { start: 0, end: 9, total: null });
  assert.equal(parseContentRange('bytes 10-5/100'), null);
  assert.equal(parseContentRange('bytes 0-200/200'), null);
  assert.equal(parseContentRange('garbage'), null);
  assert.equal(parseUnsatisfiedRange('bytes */1234'), 1234);
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 0), 10_000);
  assert.equal(parseRetryAfter('soon'), null);
  assert.ok(isStrongEtag('"abc"'));
  assert.ok(!isStrongEtag('W/"abc"'));
});

test('SpeedMeter measures a steady rate and decays when stalled', () => {
  let now = 0;
  const m = new SpeedMeter(3000, () => now);
  m.reset(0);
  for (let i = 1; i <= 20; i++) {
    now = i * 200;
    m.sample(i * 200_000); // 1 MB/s
  }
  assert.ok(Math.abs(m.rate() - 1_000_000) < 50_000, `rate ${m.rate()}`);
  now += 10_000;
  m.sample(20 * 200_000);
  assert.ok(m.rate() < 100_000, `stalled rate ${m.rate()}`);
});

test('SpeedMeter reports a speed for a download that arrives in a burst (fast servers, CI runners)', () => {
  let now = 1_000_000;
  const m = new SpeedMeter(3000, () => now);
  m.reset(0);
  // 2 MB within 60 ms, as a local or very fast server delivers it.
  for (let i = 1; i <= 32; i++) {
    now += 2;
    m.sample(i * 65536);
  }
  now += 300;
  m.sample(32 * 65536);
  assert.ok(m.rate() > 0, 'a speed is reported once enough time has passed');
  now += 3500;
  m.sample(32 * 65536);
  assert.equal(m.rate(), 0, 'and it decays to zero while nothing arrives');
});

test('validateSettings enforces limits', () => {
  const dir = path.resolve('/downloads');
  // Settings saved by 1.0 have no yt-dlp location, by 1.1 no automatic-tools choice and by 1.2 none of
  // the 1.3 values: they stay valid and get the defaults.
  assert.deepEqual(validateSettings({ downloadDirectory: dir, maxConcurrent: 4, resumeOnStartup: false }), {
    downloadDirectory: dir,
    maxConcurrent: 4,
    resumeOnStartup: false,
    ytDlpPath: '',
    autoMediaTools: true,
    speedLimit: 0,
    categoriesEnabled: false,
    startWithWindows: false,
    closeToTray: false,
    connections: 4,
  });
  const base = { downloadDirectory: dir, maxConcurrent: 1, resumeOnStartup: true };
  assert.equal(validateSettings({ ...base, speedLimit: 512_000 }).speedLimit, 512_000);
  for (const bad of [-1, 1.5, 'fast', 2 ** 40]) assert.throws(() => validateSettings({ ...base, speedLimit: bad }), ValidationError, `speedLimit ${bad}`);
  const flags = validateSettings({ ...base, categoriesEnabled: true, startWithWindows: true, closeToTray: true });
  assert.deepEqual([flags.categoriesEnabled, flags.startWithWindows, flags.closeToTray], [true, true, true]);
  for (const key of ['categoriesEnabled', 'startWithWindows', 'closeToTray']) {
    assert.throws(() => validateSettings({ ...base, [key]: 'yes' }), ValidationError, key);
  }
  assert.equal(validateSettings({ downloadDirectory: dir, maxConcurrent: 1, resumeOnStartup: true, autoMediaTools: false }).autoMediaTools, false);
  assert.throws(() => validateSettings({ downloadDirectory: dir, maxConcurrent: 1, resumeOnStartup: true, autoMediaTools: 'yes' }), ValidationError);
  const yt = path.resolve('/tools/yt-dlp.exe');
  assert.equal(validateSettings({ downloadDirectory: dir, maxConcurrent: 1, resumeOnStartup: true, ytDlpPath: yt }).ytDlpPath, yt);
  assert.throws(() => validateSettings({ downloadDirectory: dir, maxConcurrent: 1, resumeOnStartup: true, ytDlpPath: 'yt-dlp.exe' }), ValidationError);
  assert.throws(() => validateSettings({ downloadDirectory: dir, maxConcurrent: 1, resumeOnStartup: true, ytDlpPath: 42 }), ValidationError);
  assert.throws(() => validateSettings({ downloadDirectory: 'relative', maxConcurrent: 1, resumeOnStartup: true }), ValidationError);
  assert.throws(() => validateSettings({ downloadDirectory: dir, maxConcurrent: 0, resumeOnStartup: true }), ValidationError);
  assert.throws(() => validateSettings({ downloadDirectory: dir, maxConcurrent: 11, resumeOnStartup: true }), ValidationError);
  assert.throws(() => validateSettings({ downloadDirectory: dir, maxConcurrent: 2.5, resumeOnStartup: true }), ValidationError);
});

test('format helpers', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatDuration(75), '1m 15s');
  assert.equal(formatDuration(null), '—');
});

test('extractProtocolUrls accepts only haul://add with an http(s) target', () => {
  const target = 'https://example.com/files/a b.zip?x=1&y=2';
  const argv = [
    'C:\Program Files\Haul\Haul.exe',
    `haul://add?url=${encodeURIComponent(target)}`,
    `haul://add?url=${encodeURIComponent('javascript:alert(1)')}`,
    `haul://add?url=${encodeURIComponent('file:///C:/Windows/win.ini')}`,
    `haul://delete?url=${encodeURIComponent(target)}`,
    'haul://add',
    '--some-flag',
  ];
  assert.deepEqual(extractProtocolUrls(argv), [new URL(target).href]);
});
