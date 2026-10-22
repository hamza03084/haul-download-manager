// A stand-in for yt-dlp used by the tests (run as `node fakeYtDlp.js <yt-dlp arguments>`).
// It mimics the behaviour of the real program that Haul relies on, as observed with yt-dlp 2026.10:
// the same output lines, `.part` files in the temp folder, resuming them, merging, moving the result
// to the home folder and writing its path for --print-to-file. Test controls go in the URL query:
//   vsize, asize   stream sizes in bytes        delay   ms to wait after each 32 KiB
//   mode=unavailable | playlist | slowprobe     failat  fail with an HTTP 403 after this many bytes
//   mergedelay     ms spent "joining" video and sound
import * as fs from 'node:fs';
import * as path from 'node:path';
import { streamBytes } from '../helpers/fakeMedia';

const args = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = (s: string) => process.stdout.write(`${s}\n`);
const value = (flag: string) => args[args.indexOf(flag) + 1];

async function main(): Promise<number> {
  if (args.includes('--version')) {
    out('2099.01.01-fake');
    return 0;
  }
  const url = new URL(args[args.indexOf('--') + 1]);
  const q = url.searchParams;

  if (args.includes('-J')) {
    if (q.get('mode') === 'unavailable') {
      process.stderr.write('ERROR: [youtube] aqz-KE-bpKQ: Video unavailable. This video has been removed by the uploader\n');
      return 1;
    }
    if (q.get('mode') === 'playlist') {
      out(JSON.stringify({ _type: 'playlist', id: 'PL1', entries: [] }));
      return 0;
    }
    if (q.get('mode') === 'slowprobe') await sleep(60_000);
    const fixture = path.resolve(__dirname, '..', '..', '..', 'tests', 'fixtures', 'youtube-probe.json');
    const info = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    if (q.get('title')) info.title = q.get('title');
    out(JSON.stringify(info));
    return 0;
  }

  // ------------------------------------------------------------- download
  const paths: Record<string, string> = {};
  args.forEach((a, i) => {
    if (a === '-P') {
      const [k, ...rest] = args[i + 1].split(':');
      paths[k] = rest.join(':');
    }
  });
  // Like yt-dlp, treat the output name and the --print-to-file name as templates: %(field)s is
  // replaced and %% becomes %.
  const template = (s: string) => s.replace(/%%|%\((\w+)\)s/g, (m, k) => (m === '%%' ? '%' : k === 'title' ? 'FAKE TITLE' : 'NA'));
  const stem = template(value('-o').replace(/\.%\(ext\)s$/, ''));
  const printTo = template(args[args.indexOf('--print-to-file') + 2]);
  const first = value('-f').split('/')[0];
  const ids = first.split('+');
  const audioMode = args.includes('-x');
  const audioFormat = audioMode ? value('--audio-format') : null;
  const vsize = Number(q.get('vsize') ?? 600_000);
  const asize = Number(q.get('asize') ?? 200_000);
  const delay = Number(q.get('delay') ?? 0);
  const failAt = q.get('failat') ? Number(q.get('failat')) : null;
  const temp = paths.temp ?? paths.home;
  fs.mkdirSync(temp, { recursive: true });
  out(`[youtube] Extracting URL: ${url.href}`);
  out(`[info] ${url.searchParams.get('v') ?? 'x'}: Downloading 1 format(s): ${first}`);

  let sent = 0;
  const streamFiles: string[] = [];
  for (const [i, id] of ids.entries()) {
    const isAudio = audioMode || (ids.length === 2 && i === 1);
    const size = isAudio ? asize : vsize;
    const file = path.join(temp, `${stem}.f${id}.${isAudio ? 'm4a' : 'mp4'}`);
    streamFiles.push(file);
    if (fs.existsSync(file)) {
      out(`[download] ${file} has already been downloaded`);
      out(`[haul] finished|NA|${size}|NA|NA|${id}`);
      continue;
    }
    const part = `${file}.part`;
    let n = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (n > 0) out(`[download] Resuming download at byte ${n}`);
    out(`[download] Destination: ${file}`);
    const fd = fs.openSync(part, 'a');
    while (n < size) {
      const len = Math.min(32 * 1024, size - n);
      fs.writeSync(fd, streamBytes(id, n, len));
      n += len;
      sent += len;
      out(`[haul] downloading|${n}|${size}|NA|1048576.5|${id}`);
      if (failAt !== null && sent >= failAt) {
        fs.closeSync(fd);
        process.stderr.write(`ERROR: unable to download video data: HTTP Error 403: Forbidden\n`);
        return 1;
      }
      if (delay) await sleep(delay);
    }
    fs.closeSync(fd);
    fs.renameSync(part, file);
    out(`[haul] finished|${size}|${size}|NA|1048576.5|${id}`);
  }

  const finalExt = audioMode ? audioFormat : 'mp4';
  const joined = path.join(temp, `${stem}.${finalExt}`);
  if (streamFiles.length === 2) {
    out(`[Merger] Merging formats into "${joined}"`);
    await sleep(Number(q.get('mergedelay') ?? 0));
    fs.writeFileSync(joined, Buffer.concat(streamFiles.map((f) => fs.readFileSync(f))));
    for (const f of streamFiles) fs.rmSync(f);
  } else if (audioMode) {
    out(`[ExtractAudio] Destination: ${joined}`);
    fs.renameSync(streamFiles[0], joined);
  } else {
    fs.renameSync(streamFiles[0], joined);
  }
  if (args.includes('--write-thumbnail')) {
    out(`[ThumbnailsConvertor] Converting thumbnail to jpg`);
    fs.writeFileSync(path.join(paths.home, `${stem}.jpg`), Buffer.from('fake jpeg'));
  }
  const dest = path.join(paths.home, `${stem}.${finalExt}`);
  out(`[MoveFiles] Moving file "${joined}" to "${dest}"`);
  fs.mkdirSync(paths.home, { recursive: true });
  fs.renameSync(joined, dest);
  fs.appendFileSync(printTo, `${dest}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`ERROR: fake yt-dlp crashed: ${e?.stack ?? e}\n`);
    process.exit(1);
  },
);
