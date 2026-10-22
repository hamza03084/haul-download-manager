// Video pages (YouTube) through yt-dlp: finding the tools, asking what formats a video offers,
// building the download command and reading its progress. Haul does not ship yt-dlp: it downloads it on
// first use (see tools.ts) or uses a copy the user installed. No Electron imports: this runs and is
// tested under plain Node.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MediaInfo, MediaQuality, MediaSpec, MediaToolsStatus } from '../../shared/types';

export interface MediaTools {
  /** Command plus leading arguments that run yt-dlp (normally just the path of yt-dlp.exe). */
  ytDlp: string[];
  ffmpeg: string | null;
  /** Value for yt-dlp's --js-runtimes, e.g. "deno:C:\\Tools\\deno.exe". */
  jsRuntime: string | null;
}

export interface LocatedTools {
  tools: MediaTools | null;
  status: MediaToolsStatus;
}

/** Problem with the external tools or with what yt-dlp reported; the message is shown to the user. */
export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaError';
  }
}

/** Folder (next to the final file) where yt-dlp keeps partial streams until the download finishes. */
export const MEDIA_PARTS_SUFFIX = '.haulparts';
const FINAL_PATH_FILE = 'final-path.txt';
const PID_FILE = 'yt-dlp.pid';

export const INSTALL_HINT =
  'Turn on "Get these tools automatically" in Settings, or install the free tools yourself, for example in PowerShell: ' +
  'winget install yt-dlp.yt-dlp; winget install yt-dlp.FFmpeg; winget install DenoLand.Deno. ' +
  'Then restart Haul, or set the location of yt-dlp.exe in Settings.';

// ------------------------------------------------------------------ locating the tools

const exeName = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

function findIn(dirs: (string | undefined)[], name: string): string | null {
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, exeName(name));
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * Finds yt-dlp, FFmpeg and a JavaScript runtime. Search order: the path set in Settings, the folder
 * of yt-dlp (portable setups keep everything together), Haul's own tools folder (`managedDir`, kept up
 * to date by Haul), PATH, and winget's links folder. `command` (tests only) replaces yt-dlp with an
 * arbitrary command.
 */
export function locateMediaTools(opts: {
  ytDlpPath?: string;
  env?: NodeJS.ProcessEnv;
  command?: string[] | null;
  managedDir?: string | null;
}): LocatedTools {
  const env = opts.env ?? process.env;
  const pathDirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const winget = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : undefined;
  const home = env.USERPROFILE ?? env.HOME;
  const managed = opts.managedDir ?? undefined;

  let ytDlp: string | null = null;
  let problem: string | null = null;
  if (opts.command?.length) {
    ytDlp = opts.command[0];
  } else if (opts.ytDlpPath) {
    if (fs.existsSync(opts.ytDlpPath) && fs.statSync(opts.ytDlpPath).isFile()) ytDlp = opts.ytDlpPath;
    else problem = `yt-dlp was not found at the location set in Settings (${opts.ytDlpPath}).`;
  } else {
    ytDlp = findIn([managed, ...pathDirs, winget], 'yt-dlp');
  }
  const ytDir = ytDlp && !opts.command?.length ? path.dirname(ytDlp) : undefined;
  const ffmpeg = findIn([ytDir, managed, ...pathDirs, winget], 'ffmpeg');
  const deno = findIn([ytDir, managed, ...pathDirs, home && path.join(home, '.deno', 'bin'), winget], 'deno');
  const node = deno ? null : findIn([ytDir, ...pathDirs], 'node');
  const jsRuntime = deno ? `deno:${deno}` : node ? `node:${node}` : null;

  if (!problem && !ytDlp) problem = `YouTube downloads need yt-dlp, which was not found. ${INSTALL_HINT}`;
  else if (!problem && !ffmpeg && !opts.command?.length) {
    problem = `YouTube downloads need FFmpeg (to join HD video with its sound), which was not found. ${INSTALL_HINT}`;
  }
  const status: MediaToolsStatus = {
    ytDlp,
    ytDlpVersion: null,
    ffmpeg,
    jsRuntime: deno ?? node,
    problem,
    managed: !!ytDlp && !!managed && path.resolve(path.dirname(ytDlp)) === path.resolve(managed),
    install: null,
  };
  const tools = problem || !ytDlp ? null : { ytDlp: opts.command?.length ? opts.command : [ytDlp], ffmpeg, jsRuntime };
  return { tools, status };
}

/** `yt-dlp --version`, or null if it cannot be run. Asynchronous: starting yt-dlp.exe takes a second or two. */
export async function ytDlpVersion(tools: MediaTools): Promise<string | null> {
  try {
    const { code, stdout } = await run(tools, ['--version'], new AbortController().signal, 30_000);
    return code === 0 ? stdout.trim() || null : null;
  } catch {
    return null;
  }
}

/** yt-dlp is a Python program: make it read and write UTF-8 so non-English titles survive. */
function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

// ------------------------------------------------------------------ asking what a video offers

/** Runs `yt-dlp -J` and summarises the formats into the choices shown in the quality picker. */
export async function probeMedia(tools: MediaTools, url: string, signal: AbortSignal, timeoutMs = 120_000): Promise<MediaInfo> {
  const args = ['--ignore-config', '--no-playlist', '--no-warnings', '-J'];
  if (tools.jsRuntime) args.push('--js-runtimes', tools.jsRuntime);
  args.push('--', url);
  const { code, stdout, stderr } = await run(tools, args, signal, timeoutMs);
  if (code !== 0) throw new MediaError(cleanError(stderr) || `yt-dlp stopped with exit code ${code}.`);
  let info: unknown;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new MediaError('yt-dlp returned information Haul could not read. Try updating yt-dlp (yt-dlp -U).');
  }
  return summarizeInfo(info, url);
}

interface Fmt {
  format_id?: string;
  ext?: string;
  vcodec?: string | null;
  acodec?: string | null;
  height?: number | null;
  fps?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  tbr?: number | null;
  abr?: number | null;
  audio_channels?: number | null;
  protocol?: string;
  format_note?: string | null;
}

const isVideo = (f: Fmt) => !!f.vcodec && f.vcodec !== 'none' && (f.height ?? 0) > 0;
const isAudioOnly = (f: Fmt) => (!f.vcodec || f.vcodec === 'none') && !!f.acodec && f.acodec !== 'none';
const sizeOf = (f: Fmt | undefined, duration: number | null) =>
  !f ? null : f.filesize ?? f.filesize_approx ?? (f.tbr && duration ? Math.round((f.tbr * 1000 * duration) / 8) : null);

/** H.264 plays everywhere, VP9 on any current Windows, AV1 needs newer hardware or an extension. */
function codecRank(vcodec: string): number {
  if (vcodec.startsWith('avc1') || vcodec.startsWith('h264')) return 0;
  if (vcodec.startsWith('vp9') || vcodec.startsWith('vp09')) return 1;
  if (vcodec.startsWith('av01')) return 2;
  return 3;
}
function codecName(vcodec: string): string {
  return ['H.264', 'VP9', 'AV1'][codecRank(vcodec)] ?? vcodec.split('.')[0].toUpperCase();
}

/** Video-only stream Haul picks for a height: highest frame rate, then the most compatible codec. */
export function pickVideoFormat(formats: Fmt[], height: number): Fmt | undefined {
  return formats
    .filter((f) => isVideo(f) && f.acodec === 'none' && f.height === height && f.protocol?.startsWith('http') && f.format_id)
    .sort((a, b) => (b.fps ?? 0) - (a.fps ?? 0) || codecRank(a.vcodec!) - codecRank(b.vcodec!) || (sizeOf(a, null) ?? 0) - (sizeOf(b, null) ?? 0))[0];
}

/** Audio stream Haul picks: stereo AAC (most compatible), avoiding loudness-compressed (DRC) copies. */
export function pickAudioFormat(formats: Fmt[]): Fmt | undefined {
  const audio = formats.filter((f) => isAudioOnly(f) && f.protocol?.startsWith('http') && f.format_id && !/drc/i.test(f.format_id + (f.format_note ?? '')));
  const aac = audio.filter((f) => f.acodec!.startsWith('mp4a') && (f.audio_channels ?? 2) <= 2);
  const pool = aac.length ? aac : audio;
  return pool.sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0];
}

export function summarizeInfo(raw: unknown, url: string): MediaInfo {
  const info = (raw ?? {}) as Record<string, unknown>;
  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    throw new MediaError('This link is a playlist. Open one video from it and paste that video\'s link.');
  }
  if (info.is_live === true || info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
    throw new MediaError('Live streams and premieres cannot be downloaded until they have ended.');
  }
  const formats = (Array.isArray(info.formats) ? info.formats : []) as Fmt[];
  const duration = typeof info.duration === 'number' ? info.duration : null;
  const audio = pickAudioFormat(formats);
  const heights = [...new Set(formats.filter((f) => isVideo(f) && f.acodec === 'none').map((f) => f.height!))].sort((a, b) => b - a);
  const qualities: MediaQuality[] = [];
  for (const h of heights) {
    if (h < 144) continue;
    const v = pickVideoFormat(formats, h);
    if (!v) continue;
    const fps = v.fps ? Math.round(v.fps) : null;
    const tag = h >= 2160 ? ' (4K)' : h >= 1440 ? ' (2K)' : h >= 720 ? ' (HD)' : '';
    qualities.push({
      height: h,
      fps,
      codec: codecName(v.vcodec!),
      label: `${h}p${fps && fps > 30 ? fps : ''}${tag}`,
      videoBytes: sizeOf(v, duration),
      formatId: v.format_id!,
    });
  }
  if (qualities.length === 0 && !audio) throw new MediaError('yt-dlp found no downloadable formats for this video.');
  const subs = (info.subtitles ?? {}) as Record<string, { name?: string }[]>;
  return {
    url,
    videoId: String(info.id ?? ''),
    title: String(info.title ?? info.id ?? 'video'),
    uploader: typeof info.uploader === 'string' ? info.uploader : typeof info.channel === 'string' ? info.channel : null,
    durationSeconds: duration,
    qualities,
    audioBytes: sizeOf(audio, duration),
    audioKbps: audio?.abr ? Math.round(audio.abr) : null,
    audioFormatId: audio?.format_id ?? null,
    subtitles: Object.entries(subs)
      .filter(([code]) => code !== 'live_chat')
      .map(([code, list]) => ({ code, name: list?.[0]?.name ?? code })),
    hasThumbnail: typeof info.thumbnail === 'string' || Array.isArray(info.thumbnails),
  };
}

// ------------------------------------------------------------------ downloading

const PROGRESS_TEMPLATE =
  'download:[haul] %(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(info.format_id)s';

/** In yt-dlp output templates `%` starts a field, so literal percent signs in a title are doubled. */
const literal = (s: string) => s.replace(/%/g, '%%');

/** Extension of the finished file for a choice. */
export function mediaExtension(spec: Pick<MediaSpec, 'mode' | 'audioFormat'>): string {
  return spec.mode === 'audio' ? `.${spec.audioFormat ?? 'm4a'}` : '.mp4';
}

export function buildDownloadArgs(
  spec: MediaSpec,
  o: { url: string; home: string; temp: string; stem: string; tools: MediaTools },
): string[] {
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--newline',
    '--no-colors',
    '--progress',
    '--progress-template',
    PROGRESS_TEMPLATE,
    '--print-to-file',
    'after_move:filepath',
    // This file name is an output template too, and it contains the video title.
    literal(path.join(o.temp, FINAL_PATH_FILE)),
    '-P',
    `home:${o.home}`,
    '-P',
    `temp:${o.temp}`,
    '-o',
    `${literal(o.stem)}.%(ext)s`,
    '--no-mtime',
    '--retries',
    '10',
    '--fragment-retries',
    '10',
  ];
  if (o.tools.ffmpeg) args.push('--ffmpeg-location', o.tools.ffmpeg);
  if (o.tools.jsRuntime) args.push('--js-runtimes', o.tools.jsRuntime);
  const h = spec.height ?? 1080;
  const alt = (...xs: (string | null | undefined | false)[]) => xs.filter(Boolean).join('/');
  if (spec.mode === 'video') {
    // The exact streams shown in the picker first; generic fallbacks if YouTube changed them since.
    const exact = spec.videoFormatId && spec.audioFormatId && `${spec.videoFormatId}+${spec.audioFormatId}`;
    args.push('-f', alt(exact, `bv*[height<=${h}]+ba`, `b[height<=${h}]`), '-S', `res:${h},fps,vcodec:h264,acodec:aac`);
    args.push('--merge-output-format', 'mp4', '--remux-video', 'mp4');
  } else if (spec.mode === 'video-only') {
    args.push('-f', alt(spec.videoFormatId, `bv[height<=${h}]`), '-S', `res:${h},fps,vcodec:h264`, '--remux-video', 'mp4');
  } else {
    args.push('-f', alt(spec.audioFormatId, 'ba'), '-S', 'acodec:aac', '-x', '--audio-format', spec.audioFormat ?? 'm4a', '--audio-quality', '0');
  }
  if (spec.thumbnail) args.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
  if (spec.subtitles) args.push('--write-subs', '--sub-langs', spec.subtitles, '--convert-subs', 'srt');
  args.push('--', o.url);
  return args;
}

export type MediaEvent =
  | { type: 'progress'; status: string; downloaded: number; total: number | null; speed: number | null; formatId: string }
  | { type: 'destination'; file: string; stream: boolean }
  | { type: 'phase'; phase: string }
  | { type: 'already'; file: string }
  | { type: 'resume'; at: number };

const num = (s: string | undefined) => (s && /^\d+(\.\d+)?$/.test(s) ? Math.round(Number(s)) : null);
const EXTRA_FILE = /\.(jpe?g|png|webp|vtt|srt|ass|lrc|json|description)$/i;

/** Interprets one line of yt-dlp output. Returns null for lines that do not matter. */
export function parseOutputLine(line: string): MediaEvent | null {
  const l = line.trim();
  if (l.startsWith('[haul] ')) {
    const [status, downloaded, total, estimate, speed, formatId] = l.slice(7).split('|');
    return { type: 'progress', status, downloaded: num(downloaded) ?? 0, total: num(total) ?? num(estimate), speed: num(speed), formatId: formatId ?? '' };
  }
  let m = /^\[download\] Destination: (.+)$/.exec(l);
  if (m) return { type: 'destination', file: m[1], stream: !EXTRA_FILE.test(m[1]) };
  m = /^\[download\] (.+) has already been downloaded/.exec(l);
  if (m) return { type: 'already', file: m[1] };
  m = /^\[download\] Resuming download at byte (\d+)/.exec(l);
  if (m) return { type: 'resume', at: Number(m[1]) };
  if (l.startsWith('[Merger]')) return { type: 'phase', phase: 'Joining video and sound…' };
  if (l.startsWith('[ExtractAudio]')) return { type: 'phase', phase: 'Converting audio…' };
  if (l.startsWith('[VideoRemuxer] Remuxing')) return { type: 'phase', phase: 'Converting to MP4…' };
  if (l.startsWith('[ThumbnailsConvertor]') || l.startsWith('[info] Downloading video thumbnail')) return { type: 'phase', phase: 'Saving the thumbnail…' };
  if (l.startsWith('[info] Writing video subtitles') || l.startsWith('[SubtitlesConvertor]')) return { type: 'phase', phase: 'Saving subtitles…' };
  if (l.startsWith('[MoveFiles]')) return { type: 'phase', phase: 'Finishing…' };
  return null;
}

/** Turns yt-dlp's error output into one readable sentence. */
export function cleanError(stderr: string): string {
  const errors = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ERROR:'));
  const last = errors[errors.length - 1];
  if (!last) return '';
  let msg = last
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*[\w-]{6,}:\s*/, '')
    .replace(/\s*\(caused by .*$/i, '');
  if (/confirm you.?re not a bot|sign in to confirm/i.test(msg)) {
    msg = 'YouTube asked to confirm you are not a bot and refused the download. Wait a while and retry, or update yt-dlp (yt-dlp -U).';
  } else if (/private video/i.test(msg)) msg = 'This video is private.';
  else if (/members-only|join this channel/i.test(msg)) msg = 'This video is for channel members only.';
  else if (/age/i.test(msg) && /sign in|confirm/i.test(msg)) msg = 'This video is age-restricted and needs a signed-in account, which Haul does not use.';
  else if (/video unavailable|not available/i.test(msg)) msg = `The video is not available: ${msg}`;
  return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
}

// ------------------------------------------------------------------ processes

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(tools: MediaTools, args: string[], signal: AbortSignal, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const [cmd, ...pre] = tools.ytDlp;
    let child: ChildProcess;
    try {
      child = spawn(cmd, [...pre, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    } catch (e) {
      reject(new MediaError(`Could not start yt-dlp: ${(e as Error).message}`));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on('data', (c: Buffer) => out.push(c));
    child.stderr!.on('data', (c: Buffer) => err.push(c));
    const timer = setTimeout(() => killTree(child), timeoutMs);
    const onAbort = () => killTree(child);
    signal.addEventListener('abort', onAbort);
    child.once('error', (e) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new MediaError(`Could not start yt-dlp: ${e.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        reject(e);
        return;
      }
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

/**
 * Ends a process and everything it started. yt-dlp.exe is itself a launcher with a child process,
 * and it starts FFmpeg, so killing only the top process would leave the download running.
 */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  killPidTree(child.pid);
}

export function killPidTree(pid: number): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Whether a process with this ID is running and is (still) yt-dlp, so a reused ID is never killed. */
function isYtDlpRunning(pid: number, command: string): boolean {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  try {
    const image = path.basename(command).toLowerCase();
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return out.toLowerCase().includes(`"${image}"`);
  } catch {
    return false;
  }
}

/**
 * yt-dlp keeps running if Haul itself crashes. Before starting again on the same partial files,
 * stop a copy left over from an earlier run (recorded in the parts folder), so two processes never
 * write the same file.
 */
export function stopLeftoverProcess(partsDir: string, tools: MediaTools): void {
  const file = path.join(partsDir, PID_FILE);
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && isYtDlpRunning(pid, tools.ytDlp[0])) killPidTree(pid);
  } catch {
    /* no leftover */
  }
}

export function recordProcess(partsDir: string, pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    fs.writeFileSync(path.join(partsDir, PID_FILE), String(pid));
  } catch {
    /* best effort */
  }
}

/** Path yt-dlp reported for the finished file, if any. */
export function reportedFinalPath(partsDir: string): string | null {
  try {
    const lines = fs.readFileSync(path.join(partsDir, FINAL_PATH_FILE), 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.length ? lines[lines.length - 1].trim() : null;
  } catch {
    return null;
  }
}

export function startYtDlp(tools: MediaTools, args: string[]): ChildProcess {
  const [cmd, ...pre] = tools.ytDlp;
  return spawn(cmd, [...pre, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
}
