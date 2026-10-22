// Downloads the free tools YouTube downloads need (yt-dlp, FFmpeg, Deno) from their official GitHub
// releases into Haul's own folder, and keeps yt-dlp up to date (YouTube changes often and an old
// yt-dlp stops working). Every file is checked against the SHA-256 sum its project publishes before it
// is used. Nothing is installed system-wide and no administrator rights are needed.
// No Electron imports: this runs and is tested under plain Node.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { ToolInstallStatus } from '../../shared/types';
import { renameWithRetry } from './fsutil';
import { NetworkError, isAbortError, openGet } from './http';

export type ToolId = 'yt-dlp' | 'deno' | 'ffmpeg';

export interface ToolSource {
  id: ToolId;
  /** Name shown to the user, e.g. "FFmpeg". */
  label: string;
  /** The release file. */
  url: string;
  /** The checksum list published next to it. */
  sumsUrl: string;
  /** Name of the release file as written in the checksum list. */
  assetName: string;
  /** `exe`: the file is the program itself. `zip`: the program and the files next to it are taken from the archive. */
  kind: 'exe' | 'zip';
}

/** Problem while getting a tool; the message is shown to the user. */
export class ToolInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInstallError';
  }
}

const GITHUB = 'https://github.com';

/** Official release files for this PC's processor. `latest/download` always points at the newest release. */
export function defaultToolSources(arch: string = process.arch): ToolSource[] {
  const arm = arch === 'arm64';
  const ytAsset = arm ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe';
  const ffAsset = arm ? 'ffmpeg-master-latest-winarm64-gpl-shared.zip' : 'ffmpeg-master-latest-win64-gpl-shared.zip';
  const denoAsset = arm ? 'deno-aarch64-pc-windows-msvc.zip' : 'deno-x86_64-pc-windows-msvc.zip';
  const yt = `${GITHUB}/yt-dlp/yt-dlp/releases/latest/download`;
  const ff = `${GITHUB}/yt-dlp/FFmpeg-Builds/releases/download/latest`;
  const deno = `${GITHUB}/denoland/deno/releases/latest/download`;
  return [
    { id: 'yt-dlp', label: 'yt-dlp', url: `${yt}/${ytAsset}`, sumsUrl: `${yt}/SHA2-256SUMS`, assetName: ytAsset, kind: 'exe' },
    { id: 'deno', label: 'Deno', url: `${deno}/${denoAsset}`, sumsUrl: `${deno}/${denoAsset}.sha256sum`, assetName: denoAsset, kind: 'zip' },
    // The "shared" build is less than half the size of the static one and works the same for yt-dlp.
    { id: 'ffmpeg', label: 'FFmpeg', url: `${ff}/${ffAsset}`, sumsUrl: `${ff}/checksums.sha256`, assetName: ffAsset, kind: 'zip' },
  ];
}

/**
 * Finds the SHA-256 of `assetName` in a checksum file. Understands `<hash>  <name>` lines (yt-dlp,
 * FFmpeg-Builds) and a file holding a single hash for that asset (Deno's PowerShell-style output).
 */
export function findChecksum(text: string, assetName: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m && m[2] === assetName) return m[1].toLowerCase();
  }
  const all = [...new Set((text.match(/\b[0-9a-f]{64}\b/gi) ?? []).map((h) => h.toLowerCase()))];
  return all.length === 1 && text.includes(assetName) ? all[0] : null;
}

const exe = (id: ToolId) => `${id}.exe`;
const MANIFEST = 'tools.json';
const STAGING = '.staging';
const OLD_SUFFIX = '.old';
const MAX_SUMS_BYTES = 256 * 1024;
const DAY = 24 * 60 * 60 * 1000;
/** Files in the FFmpeg archive that yt-dlp never uses (the video player alone is 24 MB). */
const UNUSED_FILES = new Set(['ffplay.exe']);

interface Manifest {
  /** SHA-256 of the release file each tool was installed from. */
  files: Partial<Record<ToolId, { sha256: string; installedAt: number }>>;
  /** When Haul last checked for a newer yt-dlp. */
  lastUpdateCheck: number;
}

export interface ToolInstallerOptions {
  /** Haul's own tools folder, e.g. %APPDATA%\Haul Download Manager\tools. */
  dir: string;
  sources?: ToolSource[];
  userAgent?: string;
  timeoutMs?: number;
  /** Extra attempts per file after a network error. */
  retries?: number;
  retryDelayMs?: number;
  /** How often to look for a newer yt-dlp. */
  updateIntervalMs?: number;
  log?: { info(msg: string): void; warn(msg: string): void };
  now?: () => number;
}

/**
 * Gets and updates the tools. One operation runs at a time; callers asking while one is running
 * share its result. Emits `status` (ToolInstallStatus) whenever progress changes.
 */
export class ToolInstaller extends EventEmitter {
  readonly dir: string;
  private readonly sources: ToolSource[];
  private readonly userAgent?: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly updateIntervalMs: number;
  private readonly log: { info(msg: string): void; warn(msg: string): void };
  private readonly now: () => number;
  private running: Promise<void> | null = null;
  private current: ToolInstallStatus = { state: 'idle', tool: null, received: 0, total: null, error: null };
  private lastEmit = 0;

  constructor(opts: ToolInstallerOptions) {
    super();
    this.dir = opts.dir;
    this.sources = opts.sources ?? defaultToolSources();
    this.userAgent = opts.userAgent;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 3_000;
    this.updateIntervalMs = opts.updateIntervalMs ?? DAY;
    this.log = opts.log ?? { info() {}, warn() {} };
    this.now = opts.now ?? Date.now;
  }

  status(): ToolInstallStatus {
    return { ...this.current };
  }

  /** True when every tool is in the folder. A program is moved in last, so its presence means it is complete. */
  isComplete(): boolean {
    return this.sources.every((s) => this.has(s.id));
  }

  has(id: ToolId): boolean {
    try {
      return fs.statSync(path.join(this.dir, exe(id))).isFile();
    } catch {
      return false;
    }
  }

  /** Downloads whichever tools are missing. Resolves at once when all are there. */
  ensure(): Promise<void> {
    return this.exclusive(async () => {
      for (const s of this.sources) if (!this.has(s.id)) await this.install(s, null);
    });
  }

  /**
   * Gets the missing tools and replaces yt-dlp when a newer one has been released. Without `force`,
   * the release check happens at most once per update interval.
   */
  update(force = false): Promise<void> {
    return this.exclusive(async () => {
      for (const s of this.sources) if (!this.has(s.id)) await this.install(s, null);
      const manifest = this.readManifest();
      if (!force && this.now() - manifest.lastUpdateCheck < this.updateIntervalMs) return;
      const yt = this.sources.find((s) => s.id === 'yt-dlp');
      if (yt) {
        const latest = await this.expectedHash(yt);
        if (latest !== manifest.files['yt-dlp']?.sha256) {
          this.log.info('tools: a newer yt-dlp is available');
          await this.install(yt, latest);
        }
      }
      this.writeManifest({ ...this.readManifest(), lastUpdateCheck: this.now() });
    });
  }

  /** Removes what an interrupted install or a replaced yt-dlp left behind. Best effort. */
  async cleanUp(): Promise<void> {
    if (this.running) return;
    await fsp.rm(path.join(this.dir, STAGING), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
    const names = await fsp.readdir(this.dir).catch(() => [] as string[]);
    for (const n of names) if (n.endsWith(OLD_SUFFIX)) await fsp.rm(path.join(this.dir, n), { force: true }).catch(() => {});
  }

  // ---------------------------------------------------------------- internals

  private exclusive(fn: () => Promise<void>): Promise<void> {
    if (this.running) return this.running;
    const run = (async () => {
      try {
        await fn();
        await fsp.rm(path.join(this.dir, STAGING), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
        this.setStatus({ state: 'idle', tool: null, received: 0, total: null, error: null }, true);
      } catch (e) {
        const msg = e instanceof ToolInstallError ? e.message : `Could not get the tools YouTube needs: ${(e as Error).message}`;
        this.log.warn(`tools: ${msg}`);
        this.setStatus({ state: 'failed', tool: null, received: 0, total: null, error: msg }, true);
        throw new ToolInstallError(msg);
      } finally {
        this.running = null;
      }
    })();
    this.running = run;
    return run;
  }

  private setStatus(s: ToolInstallStatus, force = false): void {
    this.current = s;
    const t = this.now();
    if (!force && t - this.lastEmit < 200) return;
    this.lastEmit = t;
    this.emit('status', this.status());
  }

  /** Downloads, verifies and moves one tool into place. `knownHash` skips fetching the checksum list again. */
  private async install(s: ToolSource, knownHash: string | null): Promise<void> {
    this.log.info(`tools: getting ${s.label}`);
    this.setStatus({ state: 'installing', tool: s.label, received: 0, total: null, error: null }, true);
    const expected = knownHash ?? (await this.expectedHash(s));
    const staging = path.join(this.dir, STAGING);
    await fsp.mkdir(staging, { recursive: true });
    const file = path.join(staging, s.assetName);
    try {
      const actual = await this.withRetries(s, () => this.downloadTo(s, file));
      if (actual !== expected) {
        throw new ToolInstallError(
          `The downloaded ${s.label} did not match the checksum its project publishes, so Haul did not use it. Try again later.`,
        );
      }
      if (s.kind === 'exe') await this.replace(file, path.join(this.dir, exe(s.id)));
      else await this.installFromZip(s, file);
    } finally {
      await fsp.rm(file, { force: true }).catch(() => {});
    }
    const manifest = this.readManifest();
    manifest.files[s.id] = { sha256: expected, installedAt: this.now() };
    this.writeManifest(manifest);
    this.log.info(`tools: ${s.label} ready (${expected.slice(0, 12)})`);
  }

  private async withRetries<T>(s: ToolSource, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof NetworkError) || attempt >= this.retries) {
          if (e instanceof ToolInstallError) throw e;
          throw new ToolInstallError(`Could not download ${s.label}: ${(e as Error).message} Check your internet connection and try again.`);
        }
        this.log.warn(`tools: ${s.label} download failed (${(e as Error).message}); retrying`);
        await delay(this.retryDelayMs);
      }
    }
  }

  private async expectedHash(s: ToolSource): Promise<string> {
    const text = await this.withRetries(s, () => this.fetchText(s.sumsUrl));
    const hash = findChecksum(text, s.assetName);
    if (!hash) throw new ToolInstallError(`The checksum list for ${s.label} does not mention ${s.assetName}, so Haul cannot check the download.`);
    return hash;
  }

  private headers(): Record<string, string> {
    return this.userAgent ? { 'User-Agent': this.userAgent } : {};
  }

  private async fetchText(url: string): Promise<string> {
    const { response, destroy } = await openGet(url, { signal: new AbortController().signal, timeoutMs: this.timeoutMs, headers: this.headers() });
    try {
      if (response.statusCode !== 200) throw httpError(response.statusCode ?? 0);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        size += (chunk as Buffer).length;
        if (size > MAX_SUMS_BYTES) throw new ToolInstallError('The checksum list is unexpectedly large.');
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch (e) {
      throw asNetworkError(e);
    } finally {
      destroy();
    }
  }

  /** Streams `s.url` into `file` and returns its SHA-256. */
  private async downloadTo(s: ToolSource, file: string): Promise<string> {
    const { response, destroy } = await openGet(s.url, { signal: new AbortController().signal, timeoutMs: this.timeoutMs, headers: this.headers() });
    try {
      if (response.statusCode !== 200) throw httpError(response.statusCode ?? 0);
      const length = Number(response.headers['content-length']);
      const total = Number.isFinite(length) && length > 0 ? length : null;
      const hash = createHash('sha256');
      let received = 0;
      this.setStatus({ state: 'installing', tool: s.label, received, total, error: null }, true);
      const meter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          hash.update(chunk);
          received += chunk.length;
          this.setStatus({ state: 'installing', tool: s.label, received, total, error: null });
          cb(null, chunk);
        },
      });
      await pipeline(response, meter, fs.createWriteStream(file));
      if (total !== null && received !== total) throw new NetworkError(`The connection closed after ${received} of ${total} bytes.`);
      return hash.digest('hex');
    } catch (e) {
      throw asNetworkError(e);
    } finally {
      destroy();
    }
  }

  /** Moves a verified file into place. A running program cannot be overwritten on Windows, but it can be renamed. */
  private async replace(from: string, to: string): Promise<void> {
    if (fs.existsSync(to)) {
      const old = `${to}.${this.now()}${OLD_SUFFIX}`;
      await renameWithRetry(to, old);
      await fsp.rm(old, { force: true }).catch(() => {}); // still running: removed by cleanUp() later
    }
    await renameWithRetry(from, to);
  }

  /** Unpacks the archive and moves the program and the files next to it (FFmpeg's DLLs) into the tools folder. */
  private async installFromZip(s: ToolSource, zip: string): Promise<void> {
    const out = path.join(this.dir, STAGING, `${s.id}-unpacked`);
    await fsp.rm(out, { recursive: true, force: true });
    await fsp.mkdir(out, { recursive: true });
    try {
      await unzip(zip, out);
      const home = await findFile(out, exe(s.id));
      if (!home) throw new ToolInstallError(`The ${s.label} download did not contain ${exe(s.id)}.`);
      const names = (await fsp.readdir(home, { withFileTypes: true }))
        .filter((d) => d.isFile() && !UNUSED_FILES.has(d.name.toLowerCase()))
        .map((d) => d.name);
      // The program last: once it is in place, everything it needs is too.
      names.sort((a, b) => Number(a === exe(s.id)) - Number(b === exe(s.id)));
      for (const n of names) await this.replace(path.join(home, n), path.join(this.dir, n));
    } finally {
      await fsp.rm(out, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
    }
  }

  private readManifest(): Manifest {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(this.dir, MANIFEST), 'utf8')) as Partial<Manifest>;
      return { files: m.files && typeof m.files === 'object' ? m.files : {}, lastUpdateCheck: Number(m.lastUpdateCheck) || 0 };
    } catch {
      return { files: {}, lastUpdateCheck: 0 };
    }
  }

  private writeManifest(m: Manifest): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `${MANIFEST}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, path.join(this.dir, MANIFEST));
  }
}

function httpError(status: number): Error {
  const msg = `the server answered HTTP ${status}.`;
  return status === 429 || status >= 500 ? new NetworkError(msg) : new ToolInstallError(`Could not download the tools YouTube needs: ${msg}`);
}

function asNetworkError(e: unknown): Error {
  if (e instanceof NetworkError || e instanceof ToolInstallError || isAbortError(e)) return e as Error;
  const err = e as NodeJS.ErrnoException;
  // Errors while streaming a body (reset, premature close) are worth retrying; disk errors are not.
  if (err.syscall && !/^(read|connect|getaddrinfo)$/.test(err.syscall)) return new ToolInstallError(`Could not save the download (${err.code ?? err.message}).`);
  return new NetworkError(err.message);
}

/** Windows 10 and later include bsdtar, which can read zip files. The full path avoids other tar.exe copies on PATH. */
function unzip(zip: string, dest: string): Promise<void> {
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const cmd = process.platform === 'win32' && fs.existsSync(tar) ? tar : 'tar';
  return new Promise((resolve, reject) => {
    execFile(cmd, ['-x', '-f', zip, '-C', dest], { windowsHide: true, timeout: 10 * 60_000 }, (err, _out, stderr) => {
      if (err) reject(new ToolInstallError(`Could not unpack ${path.basename(zip)}: ${String(stderr).trim() || err.message}`));
      else resolve();
    });
  });
}

/** Folder (searched breadth-first) that holds `name`, or null. */
async function findFile(root: string, name: string): Promise<string | null> {
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === name.toLowerCase())) return dir;
    for (const e of entries) if (e.isDirectory()) queue.push(path.join(dir, e.name));
  }
  return null;
}
