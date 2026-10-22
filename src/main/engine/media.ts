// Video pages (YouTube, Vimeo and the other sites yt-dlp knows) through yt-dlp: finding the tools, asking what formats a video offers,
// building the download command and reading its progress. Haul does not ship yt-dlp: it downloads it on
// first use (see tools.ts) or uses a copy the user installed. No Electron imports: this runs and is
// tested under plain Node.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mediaSiteOf, type MediaInfo, type MediaQuality, type MediaSpec, type MediaToolsStatus } from '../../shared/types';

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

  if (!problem && !ytDlp) problem = `Video downloads need yt-dlp, which was not found. ${INSTALL_HINT}`;
  else if (!problem && !ffmpeg && !opts.command?.length) {
    problem = `Video downloads need FFmpeg (to join HD video with its sound), which was not found. ${INSTALL_HINT}`;
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
  url?: string;
}

/** Streams yt-dlp can fetch by itself: plain files, HLS (m3u8) and DASH. RTMP and the like need extra tools. */
const FETCHABLE = /^(https?|m3u8|m3u8_native|http_dash_segments|dash|websocket_frag)/i;
const fetchable = (f: Fmt) => !!f.format_id && (!f.protocol || FETCHABLE.test(f.protocol));
/** Plain files first: progress and sizes are exact, and no stream joining is needed. */
const protocolRank = (f: Fmt) => (!f.protocol || /^https?$/i.test(f.protocol) ? 0 : /dash/i.test(f.protocol) ? 1 : 2);
// Some sites (the Internet Archive, plain files found by the generic extractor) report only the
// container, not the codecs. A video container then counts as picture with sound: only an explicit
// "none" says a stream has no sound.
const VIDEO_EXT = /^(mp4|webm|mkv|mov|flv|3gp|m4v|ts|ogv|avi|wmv|mpg|mpeg)$/i;
const AUDIO_EXT = /^(m4a|mp3|ogg|oga|opus|aac|flac|wav)$/i;
const hasVideo = (f: Fmt) => (f.vcodec ? f.vcodec !== 'none' : !!f.ext && VIDEO_EXT.test(f.ext));
const hasAudio = (f: Fmt) => (f.acodec ? f.acodec !== 'none' : !!f.ext && (AUDIO_EXT.test(f.ext) || VIDEO_EXT.test(f.ext)));
const isVideo = (f: Fmt) => hasVideo(f) && (f.height ?? 0) > 0;
const isAudioOnly = (f: Fmt) => !hasVideo(f) && hasAudio(f);
const sizeOf = (f: Fmt | undefined, duration: number | null) =>
  !f ? null : f.filesize ?? f.filesize_approx ?? (f.tbr && duration ? Math.round((f.tbr * 1000 * duration) / 8) : null);

/** H.264 plays everywhere, VP9 on any current Windows, AV1 needs newer hardware or an extension. */
function codecRank(vcodec: string | null | undefined): number {
  if (!vcodec) return 3;
  if (vcodec.startsWith('avc1') || vcodec.startsWith('h264')) return 0;
  if (vcodec.startsWith('vp9') || vcodec.startsWith('vp09')) return 1;
  if (vcodec.startsWith('av01')) return 2;
  return 3;
}
function codecName(f: Fmt): string {
  const v = f.vcodec;
  if (!v) return (f.ext ?? 'video').toUpperCase();
  return ['H.264', 'VP9', 'AV1'][codecRank(v)] ?? v.split('.')[0].toUpperCase();
}

const byPreference = (a: Fmt, b: Fmt) =>
  protocolRank(a) - protocolRank(b) || (b.fps ?? 0) - (a.fps ?? 0) || codecRank(a.vcodec) - codecRank(b.vcodec) || (sizeOf(a, null) ?? 0) - (sizeOf(b, null) ?? 0);

/**
 * Video-only stream Haul picks for a height: a plain file over HLS/DASH, then the highest frame rate,
 * then the most compatible codec. YouTube and the bigger sites offer these; many sites do not.
 */
export function pickVideoFormat(formats: Fmt[], height: number): Fmt | undefined {
  return formats.filter((f) => isVideo(f) && !hasAudio(f) && f.height === height && fetchable(f)).sort(byPreference)[0];
}

/** Stream with picture and sound in one, as most sites other than YouTube serve (no joining needed). */
export function pickCombinedFormat(formats: Fmt[], height: number): Fmt | undefined {
  return formats.filter((f) => isVideo(f) && hasAudio(f) && f.height === height && fetchable(f)).sort(byPreference)[0];
}

/** Audio stream Haul picks: stereo AAC (most compatible), avoiding loudness-compressed (DRC) copies. */
export function pickAudioFormat(formats: Fmt[]): Fmt | undefined {
  const audio = formats.filter((f) => isAudioOnly(f) && fetchable(f) && !/drc/i.test(f.format_id + (f.format_note ?? '')));
  const aac = audio.filter((f) => (f.acodec ?? '').startsWith('mp4a') && (f.audio_channels ?? 2) <= 2);
  const pool = aac.length ? aac : audio;
  return pool.sort((a, b) => protocolRank(a) - protocolRank(b) || (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0];
}

/** How yt-dlp names the site, made readable ("Youtube" -> "YouTube", "TwitterSpaces" -> "Twitter Spaces"). */
export function siteName(info: Record<string, unknown>, url: string): string {
  const key = typeof info.extractor_key === 'string' ? info.extractor_key : typeof info.extractor === 'string' ? info.extractor : '';
  const known: Record<string, string> = {
    youtube: 'YouTube',
    generic: 'this page',
    tiktok: 'TikTok',
    soundcloud: 'SoundCloud',
    okru: 'OK.ru',
    archiveorg: 'Internet Archive',
    twitter: 'X',
    dailymotion: 'Dailymotion',
    bilibili: 'Bilibili',
  };
  const base = key.split(':')[0];
  if (known[base.toLowerCase()]) return known[base.toLowerCase()];
  if (base) return base.replace(/([a-z])([A-Z])/g, '$1 $2');
  try {
    return mediaSiteOf(new URL(url)) ?? 'this page';
  } catch {
    return 'this page';
  }
}

export function summarizeInfo(raw: unknown, url: string): MediaInfo {
  const info = (raw ?? {}) as Record<string, unknown>;
  if (info._type === 'playlist' || Array.isArray(info.entries)) {
    throw new MediaError('This link is a playlist. Open one video from it and paste that video\'s link.');
  }
  if (info.is_live === true || info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
    throw new MediaError('Live streams and premieres cannot be downloaded until they have ended.');
  }
  // A page with one plain video file (the generic extractor) reports it as the single "format".
  const formats = (Array.isArray(info.formats) ? info.formats : typeof info.url === 'string' ? [info as Fmt] : []) as Fmt[];
  const duration = typeof info.duration === 'number' ? info.duration : null;
  const audio = pickAudioFormat(formats);
  const heights = [...new Set(formats.filter((f) => isVideo(f) && fetchable(f)).map((f) => f.height!))].sort((a, b) => b - a);
  const qualities: MediaQuality[] = [];
  for (const h of heights) {
    if (h < 144) continue;
    const separate = pickVideoFormat(formats, h);
    const combined = pickCombinedFormat(formats, h);
    // Video-only plus a separate audio stream gives the best picture (YouTube); otherwise the
    // stream that has sound built in. Video only needs a stream without sound.
    const chosen = separate && audio ? separate : combined ?? separate;
    if (!chosen) continue;
    const fps = chosen.fps ? Math.round(chosen.fps) : null;
    const tag = h >= 2160 ? ' (4K)' : h >= 1440 ? ' (2K)' : h >= 720 ? ' (HD)' : '';
    qualities.push({
      height: h,
      fps,
      codec: codecName(chosen),
      label: `${h}p${fps && fps > 30 ? fps : ''}${tag}`,
      videoBytes: sizeOf(chosen, duration),
      formatId: chosen.format_id!,
      hasAudio: chosen === combined,
      videoOnlyFormatId: separate?.format_id ?? null,
    });
  }
  if (qualities.length === 0) {
    // Sites that do not say how tall their video is: let yt-dlp take the best it finds.
    const best = formats.filter((f) => hasVideo(f) && fetchable(f)).sort(byPreference)[0];
    if (best) {
      qualities.push({
        height: 0,
        fps: null,
        codec: codecName(best),
        label: 'Best available',
        videoBytes: sizeOf(best, duration),
        formatId: best.format_id!,
        hasAudio: hasAudio(best) || !audio,
        videoOnlyFormatId: hasAudio(best) ? null : best.format_id!,
      });
    }
  }
  if (qualities.length === 0 && !audio) throw new MediaError('yt-dlp found no downloadable video or audio on this page.');
  const subs = (info.subtitles ?? {}) as Record<string, { name?: string }[]>;
  return {
    url,
    site: siteName(info, url),
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

/**
 * Containers whose usual codecs fit into MP4 are remuxed to MP4 (no re-encoding, so it is quick and
 * lossless). Others (Ogg Theora, AVI, WMV…) would make the remux fail, so they are kept as they are.
 */
const REMUX_TO_MP4 = 'mov>mp4/m4v>mp4/3gp>mp4/ts>mp4/flv>mp4/mkv>mp4/webm>mp4';

/** In yt-dlp output templates `%` starts a field, so literal percent signs in a title are doubled. */
const literal = (s: string) => s.replace(/%/g, '%%');

/** Extension of the finished file for a choice. */
export function mediaExtension(spec: Pick<MediaSpec, 'mode' | 'audioFormat'>): string {
  return spec.mode === 'audio' ? `.${spec.audioFormat ?? 'm4a'}` : '.mp4';
}

export function buildDownloadArgs(
  spec: MediaSpec,
  o: { url: string; home: string; temp: string; stem: string; tools: MediaTools; rateLimit?: number },
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
  // yt-dlp's own limiter, in bytes per second. It applies to this yt-dlp process only.
  if (o.rateLimit && o.rateLimit > 0) args.push('--limit-rate', String(Math.floor(o.rateLimit)));
  const h = spec.height || null; // 0 = best available (the site does not say how tall its video is)
  const alt = (...xs: (string | null | undefined | false)[]) => xs.filter(Boolean).join('/');
  const atMost = (sel: string) => (h ? `${sel}[height<=${h}]` : sel);
  // The codec preference (H.264 and AAC play everywhere) matters on YouTube, which offers several
  // codecs per size. Elsewhere it is left out: sites whose streams have no IDs of their own get them
  // numbered in sort order, so a sort would make the IDs from the picker point at other streams.
  let site: string | null = null;
  try {
    site = mediaSiteOf(new URL(o.url));
  } catch {
    /* no site */
  }
  const sort = (...keys: string[]) => (site === 'YouTube' ? ['-S', (h ? [`res:${h}`, ...keys] : ['res', ...keys]).join(',')] : []);
  if (spec.mode === 'video') {
    // The exact streams shown in the picker first (a video stream plus a sound stream, or one stream
    // with both); generic fallbacks if the site changed them since.
    const exact = spec.videoFormatId && (spec.audioFormatId ? `${spec.videoFormatId}+${spec.audioFormatId}` : spec.videoFormatId);
    args.push('-f', alt(exact, `${atMost('bv*')}+ba`, atMost('b')), ...sort('fps', 'vcodec:h264', 'acodec:aac'));
    args.push('--merge-output-format', 'mp4', '--remux-video', REMUX_TO_MP4);
  } else if (spec.mode === 'video-only') {
    args.push('-f', alt(spec.videoFormatId, atMost('bv')), ...sort('fps', 'vcodec:h264'), '--remux-video', REMUX_TO_MP4);
  } else {
    // "ba" needs a separate sound stream; sites without one get the sound taken out of the best video.
    args.push('-f', alt(spec.audioFormatId, 'ba', 'b'), ...(site === 'YouTube' ? ['-S', 'acodec:aac'] : []), '-x', '--audio-format', spec.audioFormat ?? 'm4a', '--audio-quality', '0');
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
    msg = 'The site asked to confirm you are not a bot and refused the download. Wait a while and retry, or update yt-dlp (yt-dlp -U).';
  } else if (/unsupported url/i.test(msg)) msg = 'yt-dlp found no video on this page (unsupported site or link). Try the link of the video itself.';
  else if (/requested format is not available/i.test(msg)) msg = 'The chosen quality is no longer offered by the site. Remove the download and add the link again.';
  else if (/login required|log in|requires? (an? )?account|logged.in/i.test(msg)) msg = 'This video needs a signed-in account, which Haul does not use.';
  else if (/private video/i.test(msg)) msg = 'This video is private.';
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
