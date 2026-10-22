import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { IncomingMessage } from 'node:http';
import { createInterface } from 'node:readline';
import type { AddDownloadRequest, DownloadRecord, DownloadState, DownloadView, MediaInfo, MediaSpec, MediaToolsStatus, Segment, Settings } from '../../shared/types';
import { MAX_CONCURRENT_LIMIT, MAX_CONNECTIONS, MAX_SPEED_LIMIT, SETTINGS_DEFAULTS, drmSiteOf, mediaSiteOf } from '../../shared/types';
import { categoryOf } from '../../shared/categories';
import {
  MEDIA_PARTS_SUFFIX,
  MediaError,
  buildDownloadArgs,
  cleanError,
  killTree,
  locateMediaTools,
  mediaExtension,
  parseOutputLine,
  probeMedia,
  recordProcess,
  reportedFinalPath,
  startYtDlp,
  stopLeftoverProcess,
  ytDlpVersion,
  type LocatedTools,
  type MediaTools,
} from './media';
import { ToolInstallError, type ToolInstaller } from './tools';
import { formatBytes } from '../../shared/format';
import {
  HttpStatusError,
  NetworkError,
  RequestError,
  abortError,
  header,
  httpError,
  isAbortError,
  isStrongEtag,
  openGet,
  parseContentRange,
  parseLength,
  parseUnsatisfiedRange,
  toNetworkError,
  type OpenResult,
} from './http';
import { FileChangedError, RangesIgnoredError, runMultipart, type LiveSegment } from './multipart';
import { MIN_SEGMENT_BYTES, contiguousPrefix, planSegments, sorted, sumDone, validSegments } from './segments';
import {
  PARTIAL_SUFFIX,
  fileNameFromUrl,
  parseContentDisposition,
  sanitizeFileName,
  uniqueFileName,
  withExtensionForMime,
} from './filename';
import { fileSize, fileSizeSync, freeSpace, removeIfExists, renameWithRetry, samePath } from './fsutil';
import { SpeedMeter } from './speed';
import { RateLimiter } from './throttle';
import type { DownloadStore } from './store';
import { ValidationError, redactText, redactUrl, refuseDrm, validateDownloadUrl } from './urls';

export { HttpStatusError } from './http';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export interface ManagerOptions {
  store: DownloadStore;
  defaultSettings: Settings;
  /** Socket idle timeout. */
  timeoutMs?: number;
  /** Automatic retries for transient network/server errors before marking a download failed. */
  maxAutoRetries?: number;
  retryDelaysMs?: number[];
  progressIntervalMs?: number;
  persistIntervalMs?: number;
  /** Longest Retry-After the manager will wait automatically. */
  maxRetryAfterMs?: number;
  getFreeSpace?: (dir: string) => Promise<number | null>;
  logger?: Logger;
  /** Called after a file is moved to its final name, before it is reported completed (best effort). */
  onFileFinalized?: (file: string, record: DownloadRecord) => Promise<void>;
  /** User-Agent header sent with every request. */
  userAgent?: string;
  /** Tests only: command (plus leading arguments) used instead of a real yt-dlp. */
  mediaCommand?: string[] | null;
  /** Gets yt-dlp, FFmpeg and Deno automatically (when turned on in Settings). */
  toolInstaller?: ToolInstaller | null;
  /** Smallest part worth its own connection (tests use small files). */
  minSegmentBytes?: number;
}

type StopReason = 'pause' | 'cancel' | 'shutdown';

interface ActiveTask {
  id: string;
  controller: AbortController;
  stopReason: StopReason | null;
  done: Promise<void>;
  meter: SpeedMeter;
  /** Live byte count (may run slightly ahead of what is flushed to disk). */
  bytes: number;
  lastEmittedBytes: number;
  /** Explanation to keep after completion, e.g. that the download had to restart. */
  restartNotice: string | null;
  /** Set when the server answered with a web page, which is rarely what the user wanted. */
  pageNotice: string | null;
  /** Write stream of the current attempt and the file offset it started at, for durable checkpoints. */
  ws: fs.WriteStream | null;
  wsBase: number;
  syncing: boolean;
  /** Media downloads: what yt-dlp is doing, and the best known total size. */
  phase: string | null;
  liveTotal: number | null;
  /** Downloads in parts: the open file, the parts (shared with the transfer) and open connections. */
  fh: fsp.FileHandle | null;
  segments: LiveSegment[] | null;
  connections: number;
  /** Set once this server has shown it cannot serve parts: stay with one connection. */
  singleOnly: boolean;
  /** Explanation when the server allowed fewer connections than asked for. */
  limitNotice: string | null;
}

const TERMINAL: DownloadState[] = ['completed', 'cancelled'];

export class DownloadManager extends EventEmitter {
  private records = new Map<string, DownloadRecord>();
  private active = new Map<string, ActiveTask>();
  private settings: Settings;
  private store: DownloadStore;
  private log: Logger;
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;
  private shuttingDown = false;
  private readonly timeoutMs: number;
  private readonly maxAutoRetries: number;
  private readonly retryDelaysMs: number[];
  private readonly progressIntervalMs: number;
  private readonly persistEvery: number;
  private readonly maxRetryAfterMs: number;
  private readonly getFreeSpace: (dir: string) => Promise<number | null>;
  private readonly onFileFinalized?: (file: string, record: DownloadRecord) => Promise<void>;
  private readonly userAgent?: string;
  private readonly mediaCommand: string[] | null;
  private readonly installer: ToolInstaller | null;
  private readonly minSegmentBytes: number;
  /** One limiter for every transfer, so the speed limit in Settings is the total. */
  private readonly limiter = new RateLimiter();

  constructor(opts: ManagerOptions) {
    super();
    this.store = opts.store;
    this.userAgent = opts.userAgent;
    this.mediaCommand = opts.mediaCommand ?? null;
    this.installer = opts.toolInstaller ?? null;
    this.log = opts.logger ?? silentLogger;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxAutoRetries = opts.maxAutoRetries ?? 3;
    this.retryDelaysMs = opts.retryDelaysMs ?? [2_000, 5_000, 15_000];
    this.progressIntervalMs = opts.progressIntervalMs ?? 250;
    this.persistEvery = Math.max(1, Math.round((opts.persistIntervalMs ?? 2_000) / this.progressIntervalMs));
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
    this.getFreeSpace = opts.getFreeSpace ?? freeSpace;
    this.minSegmentBytes = Math.max(64 * 1024, opts.minSegmentBytes ?? MIN_SEGMENT_BYTES);
    this.onFileFinalized = opts.onFileFinalized;
    this.settings = normalizeSettings({ ...opts.defaultSettings, ...this.store.loadSettings() }, opts.defaultSettings);
    this.limiter.setRate(this.settings.speedLimit);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Loads persisted downloads, repairs state left by a previous run and starts the queue. */
  init(): void {
    for (const rec of this.store.loadAll()) {
      const fixed = this.recover(rec);
      this.records.set(fixed.id, fixed);
      if (fixed !== rec) this.store.upsert(fixed);
    }
    this.timer = setInterval(() => this.tick(), this.progressIntervalMs);
    this.timer.unref?.();
    this.schedule();
  }

  private recover(rec: DownloadRecord): DownloadRecord {
    let r = rec;
    const patch = (p: Partial<DownloadRecord>) => {
      r = { ...r, ...p, updatedAt: Date.now() };
    };
    if (r.state === 'downloading') {
      // Only an abrupt exit (crash, power loss, Windows ending the session) leaves this state behind;
      // a normal close re-queues downloads. For this state `downloadedBytes` is the last checkpoint:
      // the size known to be flushed to disk. Anything after it may be missing, or read back as zeros
      // after a power cut, so the partial file is cut back to the checkpoint before continuing.
      // (Media downloads keep their partial streams in yt-dlp's own files, which it resumes itself.
      // Downloads in parts record a checkpoint per part and overwrite anything after it, so nothing is cut.)
      if (r.fileNameSettled && r.kind === 'http' && !r.segments) {
        const part = this.partialPath(r);
        const size = fileSizeSync(part);
        if (size !== null && size > r.downloadedBytes) {
          try {
            fs.truncateSync(part, r.downloadedBytes);
          } catch (e) {
            this.log.warn(`could not trim partial file of ${r.id} (${(e as NodeJS.ErrnoException).code}); starting over`);
            fs.rmSync(part, { force: true });
            patch({ downloadedBytes: 0 });
          }
        }
      }
      patch({
        state: 'queued',
        notice: 'Haul was closed while this was downloading (for example a crash, power cut or Windows shutting down). It continues from the last saved point.',
      });
    }
    if (r.state === 'queued' && !this.settings.resumeOnStartup) {
      patch({ state: 'paused', notice: 'Paused at startup (automatic resume is turned off in Settings).' });
    }
    if (!TERMINAL.includes(r.state) && r.state !== 'downloading' && r.fileNameSettled && r.kind === 'http') {
      const size = fileSizeSync(this.partialPath(r));
      if (size === null && r.downloadedBytes > 0) {
        patch({ downloadedBytes: 0, segments: null, notice: 'The partial file was missing or renamed, so the download will start over.' });
      } else if (size !== null && r.segments) {
        const farthest = Math.max(...r.segments.map((s) => s.start + s.done));
        if (r.totalBytes === null || !validSegments(r.segments, r.totalBytes) || size < farthest) {
          patch({ downloadedBytes: 0, segments: null, notice: 'The partial file no longer matches the saved progress, so the download will start over.' });
        } else if (sumDone(r.segments) !== r.downloadedBytes) {
          patch({ downloadedBytes: sumDone(r.segments) });
        }
      } else if (size !== null && size !== r.downloadedBytes) {
        patch({ downloadedBytes: size });
      }
    }
    return r;
  }

  /**
   * Stops all transfers, keeping partial files, and re-queues them so they continue on next start.
   * Resolves once every file handle is closed and state is persisted.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.timer) clearInterval(this.timer);
    const tasks = [...this.active.values()];
    for (const t of tasks) this.stopTask(t, 'shutdown');
    await Promise.allSettled(tasks.map((t) => t.done));
    this.store.close();
  }

  /**
   * For Windows ending the session (shutdown, restart, sign-out): the process can be terminated as
   * soon as this returns, so it is fully synchronous. Flushes every partial file to disk and records
   * the flushed size, so the next start loses nothing that was already downloaded.
   */
  checkpointNow(): void {
    if (this.shuttingDown) return;
    for (const t of this.active.values()) {
      const r = this.records.get(t.id);
      if (!r || r.state !== 'downloading') continue;
      if (t.fh && t.segments) {
        const written = t.segments.map((s) => s.written);
        try {
          fs.fsyncSync(t.fh.fd);
        } catch {
          continue;
        }
        t.segments.forEach((s, i) => (s.done = Math.max(s.done, written[i])));
        const segments = storedSegments(t.segments);
        const next = { ...r, segments, downloadedBytes: sumDone(segments), updatedAt: Date.now() };
        this.records.set(r.id, next);
        this.store.upsert(next);
        continue;
      }
      const fd = t.ws ? fdOf(t.ws) : null;
      if (fd === null) continue;
      const durable = t.wsBase + t.ws!.bytesWritten;
      try {
        fs.fsyncSync(fd);
      } catch {
        continue;
      }
      const next = { ...r, downloadedBytes: durable, updatedAt: Date.now() };
      this.records.set(r.id, next);
      this.store.upsert(next);
    }
  }

  // ------------------------------------------------------------------ queries

  getSettings(): Settings {
    return { ...this.settings };
  }

  updateSettings(input: unknown): Settings {
    const next = validateSettings(input);
    const autoTurnedOn = next.autoMediaTools && !this.settings.autoMediaTools;
    this.settings = next;
    this.store.saveSettings(next);
    // Takes effect at once for running transfers (yt-dlp downloads pick it up when they next start).
    this.limiter.setRate(next.speedLimit);
    this.schedule();
    if (autoTurnedOn) void this.prepareMediaTools();
    return this.getSettings();
  }

  // ------------------------------------------------------- video pages (yt-dlp)

  private locateTools(): LocatedTools {
    return locateMediaTools({ ytDlpPath: this.settings.ytDlpPath, command: this.mediaCommand, managedDir: this.installer?.dir });
  }

  /** Whether Haul gets the tools by itself (turned on in Settings, and not replaced by a test command). */
  private autoTools(): boolean {
    return !!this.installer && !this.mediaCommand && this.settings.autoMediaTools;
  }

  /**
   * The tools for a video download. When some are missing and Haul gets them automatically, waits
   * for them to download (`onWaiting` is called first). Stopping waiting does not stop the download
   * of the tools: the next video needs them too.
   */
  private async readyTools(signal: AbortSignal, onWaiting?: () => void): Promise<MediaTools> {
    let found = this.locateTools();
    if (!found.tools && this.autoTools() && !this.settings.ytDlpPath) {
      onWaiting?.();
      try {
        await untilAborted(this.installer!.ensure(), signal);
      } catch (e) {
        if (e instanceof ToolInstallError) throw new MediaError(e.message);
        throw e;
      }
      found = this.locateTools();
    }
    if (!found.tools) throw new MediaError(found.status.problem ?? 'yt-dlp was not found.');
    return found.tools;
  }

  /**
   * At startup (and when automatic tools are turned on): removes leftovers, gets missing tools and
   * replaces yt-dlp when a newer one is out (checked once a day). Tools the user installed and that
   * work on their own are left alone. Never throws; problems are logged and shown in Settings.
   */
  async prepareMediaTools(): Promise<void> {
    if (!this.autoTools()) return;
    const installer = this.installer!;
    try {
      await installer.cleanUp();
      const { tools, status } = this.locateTools();
      if (tools && !status.managed) return;
      await installer.update();
    } catch (e) {
      if (!(e instanceof ToolInstallError)) this.log.warn(`tools: ${redactText(String((e as Error).stack ?? e))}`);
    }
  }

  /** "Get the tools now" in Settings: gets missing tools and checks for a newer yt-dlp immediately. */
  async updateMediaTools(): Promise<void> {
    if (!this.installer || this.mediaCommand) throw new ValidationError('Haul cannot get the tools by itself in this setup.');
    try {
      await this.installer.update(true);
    } catch (e) {
      if (e instanceof ToolInstallError) throw new ValidationError(e.message);
      throw e;
    }
  }

  /** Which external tools were found, with yt-dlp's version (runs it, so takes a moment). */
  async mediaToolsStatus(): Promise<MediaToolsStatus> {
    const { tools, status } = this.locateTools();
    if (this.autoTools()) {
      status.install = this.installer!.status();
      if (!tools && !this.settings.ytDlpPath) {
        status.problem =
          status.install.state === 'failed'
            ? status.install.error
            : status.install.state === 'installing'
              ? null
              : 'Not downloaded yet. Haul gets them when you add a YouTube link, or click "Get the tools now".';
      }
    }
    if (tools) {
      status.ytDlpVersion = await ytDlpVersion(tools);
      if (!status.ytDlpVersion) status.problem = `yt-dlp was found at ${status.ytDlp} but could not be started. Reinstall it or choose another copy in Settings.`;
    }
    return status;
  }

  /** Asks yt-dlp which qualities a video page offers (first getting the tools if needed). */
  async probeMedia(input: unknown, signal: AbortSignal): Promise<MediaInfo> {
    const url = validateDownloadUrl(input);
    refuseDrm(url);
    try {
      const tools = await this.readyTools(signal);
      this.log.info(`probe ${redactUrl(url)}`);
      return await probeMedia(tools, url.href, signal);
    } catch (e) {
      if (e instanceof MediaError) throw new ValidationError(e.message);
      throw e;
    }
  }

  list(): DownloadView[] {
    return [...this.records.values()].map((r) => this.view(r));
  }

  /** Downloads transferring right now (cheap: does not check files of the whole history). */
  activeViews(): DownloadView[] {
    const out: DownloadView[] = [];
    for (const id of this.active.keys()) {
      const r = this.records.get(id);
      if (r?.state === 'downloading') out.push(this.view(r));
    }
    return out;
  }

  get(id: string): DownloadView | null {
    const r = this.records.get(id);
    return r ? this.view(r) : null;
  }

  /** True when nothing is downloading or waiting to download (used by "shut down when done"). */
  isIdle(): boolean {
    for (const r of this.records.values()) if (r.state === 'queued' || r.state === 'downloading') return false;
    return true;
  }

  /** Full path of a completed download's file. */
  completedFilePath(id: string): string | null {
    const r = this.records.get(id);
    if (!r || r.state !== 'completed') return null;
    return path.join(r.directory, r.fileName);
  }

  /** Folder of a download plus the file to select in it (if it exists). */
  locate(id: string): { directory: string; file: string | null } | null {
    const r = this.records.get(id);
    if (!r) return null;
    const final = path.join(r.directory, r.fileName);
    if (r.state === 'completed' && fs.existsSync(final)) return { directory: r.directory, file: final };
    const part = this.partialPath(r);
    if (r.fileNameSettled && fs.existsSync(part)) return { directory: r.directory, file: part };
    return { directory: r.directory, file: null };
  }

  private view(r: DownloadRecord): DownloadView {
    // The live counter only applies while transferring; paused/cancelled/failed use the persisted on-disk size.
    const t = r.state === 'downloading' ? this.active.get(r.id) : undefined;
    const downloaded = t ? t.bytes : r.downloadedBytes;
    const total = t?.liveTotal ?? r.totalBytes;
    const speed = t ? t.meter.rate() : 0;
    const eta = speed > 0 && total !== null && total >= downloaded ? (total - downloaded) / speed : null;
    return {
      ...r,
      totalBytes: total,
      downloadedBytes: downloaded,
      speed,
      etaSeconds: eta,
      fileExists: r.state === 'completed' ? fs.existsSync(path.join(r.directory, r.fileName)) : false,
      phase: t?.phase ?? null,
      connections: t?.connections ?? 0,
    };
  }

  // ------------------------------------------------------------------ actions

  add(req: AddDownloadRequest): DownloadView {
    if (this.shuttingDown) throw new ValidationError('The download manager is shutting down.');
    const url = validateDownloadUrl(req?.url);
    refuseDrm(url);
    const media = req.media ? validateMediaRequest(req.media) : null;
    const site = mediaSiteOf(url);
    if (!media && site) {
      // Downloading the page itself would only save its HTML.
      throw new ValidationError(`This is a ${site} page, not a file. Paste it in the add bar and choose a quality.`);
    }
    const referrer = validateReferrer(req.referrer);
    let directory = typeof req.directory === 'string' && req.directory.trim() ? req.directory.trim() : this.settings.downloadDirectory;
    if (!path.isAbsolute(directory)) throw new ValidationError('Choose a full folder path for the download (for example C:\\Users\\You\\Downloads).');
    // Categories apply to the default folder only: a folder picked for this download is used as is.
    let autoCategory = this.settings.categoriesEnabled && samePath(directory, this.settings.downloadDirectory);
    const id = randomUUID();
    let fileName: string;
    let settled = false;
    if (media) {
      const chosen = typeof req.fileName === 'string' && req.fileName.trim() ? req.fileName.trim() : media.title;
      const stem = sanitizeFileName(chosen, 'video').replace(/\.(mp4|m4a|mp3|mkv|webm|mov)$/i, '');
      const name = stem + mediaExtension(media);
      if (autoCategory) ({ directory, autoCategory } = this.sortedDirectory(directory, name));
      fileName = uniqueFileName(directory, name, (p) => this.isPathTaken(p, id));
      settled = true;
    } else if (typeof req.fileName === 'string' && req.fileName.trim()) {
      const name = sanitizeFileName(req.fileName.trim());
      if (autoCategory) ({ directory, autoCategory } = this.sortedDirectory(directory, name));
      fileName = uniqueFileName(directory, name, (p) => this.isPathTaken(p, id));
      settled = true;
    } else {
      // The real name comes from the server; the category subfolder is chosen then (see attempt()).
      fileName = sanitizeFileName(fileNameFromUrl(url.href) ?? '', 'download');
    }
    const now = Date.now();
    const estimate = media ? (media.estimateVideo ?? 0) + (media.estimateAudio ?? 0) : 0;
    const rec: DownloadRecord = {
      id,
      kind: media ? 'media' : 'http',
      url: url.href,
      finalUrl: null,
      fileName,
      directory: path.resolve(directory),
      fileNameSettled: settled,
      state: req.startPaused ? 'paused' : 'queued',
      totalBytes: estimate > 0 ? estimate : null,
      downloadedBytes: 0,
      // yt-dlp continues partial streams after a pause or crash.
      resumable: media ? true : null,
      etag: null,
      lastModified: null,
      error: null,
      notice: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      media,
      autoCategory,
      segments: null,
      referrer,
    };
    this.records.set(id, rec);
    this.store.upsert(rec);
    this.log.info(`added ${id} ${redactUrl(url)}${media ? ` (${media.label})` : ''}`);
    this.emitChange(rec);
    this.schedule();
    return this.view(rec);
  }

  /** The category subfolder for `fileName` under `directory`, or `directory` itself for files of no category. */
  private sortedDirectory(directory: string, fileName: string): { directory: string; autoCategory: false } {
    const category = categoryOf(fileName);
    return { directory: category ? path.join(directory, category.folder) : directory, autoCategory: false };
  }

  /**
   * Gives a paused, failed or cancelled download a new link, for example a fresh copy of a link that
   * expired, and starts it. Data already downloaded is kept: the usual resume checks (same size and
   * version) decide whether it can be continued, otherwise the download restarts from the beginning.
   */
  changeUrl(id: string, input: unknown): DownloadView {
    const r = this.require(id);
    const url = validateDownloadUrl(input);
    refuseDrm(url);
    if (r.kind === 'media') throw new ValidationError('The link of a video download cannot be changed. Remove it and add the new link.');
    const site = mediaSiteOf(url);
    if (site) throw new ValidationError(`This is a ${site} page, not a file. Paste it in the add bar and choose a quality.`);
    if (r.state !== 'paused' && r.state !== 'failed' && r.state !== 'cancelled') {
      throw new ValidationError('Pause the download before changing its link.');
    }
    const patch: Partial<DownloadRecord> = {
      url: url.href,
      finalUrl: null,
      state: 'queued',
      error: null,
      completedAt: null,
      notice: r.downloadedBytes > 0 ? 'Link changed. The data downloaded so far is kept if the new link serves the same file.' : 'Link changed.',
    };
    if (r.state === 'cancelled' && r.fileNameSettled) {
      // Like retry(): the name was released on cancel, so claim it again.
      patch.fileName = uniqueFileName(r.directory, r.fileName, (p) => this.isPathTaken(p, id));
      patch.downloadedBytes = 0;
      patch.segments = null;
    }
    this.log.info(`link changed ${id} -> ${redactUrl(url)}`);
    const next = this.patch(id, patch);
    this.schedule();
    return this.view(next);
  }

  async pause(id: string): Promise<void> {
    const r = this.require(id);
    const t = this.active.get(id);
    if (t) {
      this.stopTask(t, 'pause');
      await t.done;
    } else if (r.state === 'queued') {
      this.patch(id, { state: 'paused' });
    }
  }

  resume(id: string): void {
    const r = this.require(id);
    if (r.state === 'paused') {
      this.patch(id, { state: 'queued', error: null });
      this.schedule();
    } else if (r.state === 'failed' || r.state === 'cancelled') {
      this.retry(id);
    }
  }

  retry(id: string): void {
    const r = this.require(id);
    if (r.state !== 'failed' && r.state !== 'cancelled') throw new ValidationError('Only failed or cancelled downloads can be retried.');
    const patch: Partial<DownloadRecord> = { state: 'queued', error: null, notice: null, completedAt: null };
    if (r.state === 'cancelled' && r.fileNameSettled) {
      // The name was released on cancel; another download or file may have claimed it since.
      patch.fileName = uniqueFileName(r.directory, r.fileName, (p) => this.isPathTaken(p, id));
      patch.downloadedBytes = 0;
      patch.segments = null;
    }
    this.patch(id, patch);
    this.schedule();
  }

  async cancel(id: string): Promise<void> {
    const r = this.require(id);
    const t = this.active.get(id);
    if (t) {
      this.stopTask(t, 'cancel');
      await t.done;
      return;
    }
    if (r.state === 'completed' || r.state === 'cancelled') return;
    await this.discardPartial(r);
    this.patch(id, { state: 'cancelled', downloadedBytes: 0, segments: null, notice: null });
  }

  /** Deletes what an unfinished download has stored so far. */
  private async discardPartial(r: DownloadRecord): Promise<void> {
    if (r.kind === 'media') await fsp.rm(this.mediaPartsDir(r), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    else if (r.fileNameSettled) await removeIfExists(this.partialPath(r));
  }

  /** Removes a download from the list. Partial files are always deleted; completed files only when asked. */
  async remove(id: string, deleteFile: boolean): Promise<void> {
    const r = this.require(id);
    if (r.state !== 'completed' && r.state !== 'cancelled') await this.cancel(id);
    const current = this.records.get(id);
    if (!current) return;
    if (deleteFile && current.state === 'completed') {
      try {
        await fsp.rm(path.join(current.directory, current.fileName), { force: true });
      } catch (e) {
        throw new ValidationError(`Could not delete the file: ${(e as Error).message}`);
      }
    }
    this.records.delete(id);
    this.store.delete(id);
    this.emit('removed', id);
  }

  async pauseAll(): Promise<void> {
    const ids = [...this.records.values()].filter((r) => r.state === 'queued' || r.state === 'downloading').map((r) => r.id);
    await Promise.all(ids.map((id) => this.pause(id)));
  }

  resumeAll(): void {
    for (const r of this.records.values()) if (r.state === 'paused') this.patch(r.id, { state: 'queued', error: null });
    this.schedule();
  }

  /** Removes completed and cancelled entries from history (files on disk are kept). */
  clearFinished(): void {
    for (const r of [...this.records.values()]) {
      if (r.state === 'completed' || r.state === 'cancelled') {
        this.records.delete(r.id);
        this.store.delete(r.id);
        this.emit('removed', r.id);
      }
    }
  }

  // ---------------------------------------------------------------- scheduling

  private schedule(): void {
    if (this.shuttingDown) return;
    const queued = [...this.records.values()]
      .filter((r) => r.state === 'queued' && !this.active.has(r.id))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const r of queued) {
      if (this.active.size >= this.settings.maxConcurrent) break;
      this.start(r.id);
    }
  }

  private start(id: string): void {
    const task: ActiveTask = {
      id,
      controller: new AbortController(),
      stopReason: null,
      done: Promise.resolve(),
      meter: new SpeedMeter(),
      bytes: this.records.get(id)!.downloadedBytes,
      lastEmittedBytes: -1,
      restartNotice: null,
      pageNotice: null,
      ws: null,
      wsBase: 0,
      syncing: false,
      phase: null,
      liveTotal: null,
      fh: null,
      segments: null,
      connections: 0,
      singleOnly: false,
      limitNotice: null,
    };
    // Registered synchronously so a concurrent schedule() cannot start the same download twice.
    this.active.set(id, task);
    this.patch(id, { state: 'downloading', error: null });
    task.done = this.runTask(task)
      .catch((err) => {
        this.log.error(`unexpected failure ${id}: ${redactText(String(err?.stack ?? err))}`);
        this.finishFailed(task, err);
      })
      .finally(() => {
        this.active.delete(id);
        this.schedule();
      });
  }

  private stopTask(task: ActiveTask, reason: StopReason): void {
    if (!task.stopReason) task.stopReason = reason;
    task.controller.abort();
  }

  private async runTask(task: ActiveTask): Promise<void> {
    if (this.records.get(task.id)?.kind === 'media') {
      // yt-dlp retries network errors itself (--retries), so a failure here is final until the user retries.
      try {
        await this.runMedia(task);
      } catch (err) {
        if (task.stopReason || isAbortError(err)) await this.finishStopped(task);
        else this.finishFailed(task, err as Error);
      }
      return;
    }
    let retries = 0;
    for (;;) {
      try {
        await this.attempt(task, false);
        return;
      } catch (err) {
        if (task.stopReason || isAbortError(err)) {
          await this.finishStopped(task);
          return;
        }
        const e = err as Error;
        const retryable = e instanceof NetworkError || (e instanceof HttpStatusError && e.retryable);
        const wait =
          e instanceof HttpStatusError && e.retryAfterMs !== null
            ? e.retryAfterMs
            : this.retryDelaysMs[Math.min(retries, this.retryDelaysMs.length - 1)];
        if (!retryable || retries >= this.maxAutoRetries || wait > this.maxRetryAfterMs) {
          this.finishFailed(task, e);
          return;
        }
        retries++;
        this.log.warn(`retrying ${task.id} in ${wait} ms: ${redactText(e.message)}`);
        this.patch(task.id, {
          notice: `${e.message} Retrying in ${Math.ceil(wait / 1000)} s (retry ${retries} of ${this.maxAutoRetries})…`,
        });
        try {
          await delay(wait, undefined, { signal: task.controller.signal });
        } catch {
          await this.finishStopped(task);
          return;
        }
      }
    }
  }

  private async finishStopped(task: ActiveTask): Promise<void> {
    const r = this.records.get(task.id);
    if (!r) return;
    // Media progress is yt-dlp's count; its partial streams stay in the parts folder for resuming.
    // Downloads in parts recorded each part's flushed size when the transfer ended.
    const onDisk = r.kind === 'media' ? task.bytes : r.segments ? sumDone(r.segments) : r.fileNameSettled ? (await fileSize(this.partialPath(r))) ?? 0 : 0;
    const total = r.kind === 'media' ? task.liveTotal ?? r.totalBytes : r.totalBytes;
    switch (task.stopReason) {
      case 'cancel':
        await this.discardPartial(r);
        this.patch(task.id, { state: 'cancelled', downloadedBytes: 0, segments: null, notice: null });
        this.log.info(`cancelled ${task.id}`);
        break;
      case 'shutdown':
        this.patch(task.id, { state: 'queued', downloadedBytes: onDisk, totalBytes: total, notice: 'Interrupted when the app closed.' });
        break;
      case 'pause':
      default:
        this.patch(task.id, {
          state: 'paused',
          downloadedBytes: onDisk,
          totalBytes: total,
          notice:
            r.resumable === false
              ? 'This server does not support resuming, so resuming will restart the download from the beginning.'
              : null,
        });
        this.log.info(`paused ${task.id} at ${onDisk} bytes`);
    }
  }

  private finishFailed(task: ActiveTask, err: Error): void {
    const r = this.records.get(task.id);
    if (!r) return;
    const onDisk = r.kind === 'media' ? task.bytes : r.segments ? sumDone(r.segments) : r.fileNameSettled ? fileSizeSync(this.partialPath(r)) ?? 0 : 0;
    const known =
      err instanceof ValidationError || err instanceof RequestError || err instanceof NetworkError || err instanceof HttpStatusError || err instanceof MediaError;
    const message = known ? err.message : `Unexpected error: ${err.message}`;
    this.log.warn(`failed ${task.id}: ${redactText(message)}`);
    this.patch(task.id, { state: 'failed', error: message, notice: [task.restartNotice, task.limitNotice].filter(Boolean).join(' ') || null, downloadedBytes: onDisk });
  }

  // --------------------------------------------------------- video pages (yt-dlp)

  private mediaPartsDir(r: DownloadRecord): string {
    return path.join(r.directory, r.fileName + MEDIA_PARTS_SUFFIX);
  }

  /** Runs yt-dlp until the finished file is in place. Throws on failure, abort or stop. */
  private async runMedia(task: ActiveTask): Promise<void> {
    const signal = task.controller.signal;
    if (signal.aborted) throw abortError();
    const rec = this.require(task.id);
    const spec = rec.media;
    if (!spec) throw new MediaError('The details of this video download are missing. Remove it and add the link again.');
    const tools = await this.readyTools(signal, () => {
      task.phase = 'Getting the video tools ready (first time only)…';
    });
    const parts = this.mediaPartsDir(rec);
    try {
      await fsp.mkdir(parts, { recursive: true });
    } catch (e) {
      throw new RequestError(`Cannot create the folder "${rec.directory}" (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).`);
    }
    // Joining video and sound writes a new file next to the two streams, so about twice the size is
    // needed until the streams are deleted.
    const estimate = (spec.estimateVideo ?? 0) + (spec.estimateAudio ?? 0);
    if (estimate > 0) {
      const needed = Math.round(estimate * (spec.mode === 'video' ? 2 : 1.1)) - task.bytes;
      const free = await this.getFreeSpace(rec.directory);
      if (free !== null && free < needed) {
        throw new MediaError(
          `Not enough disk space: about ${formatBytes(needed)} is needed (video and sound are joined into a new file, so twice the video's size is used for a moment) but only ${formatBytes(free)} is free on this drive. Free up space or choose another folder, then retry.`,
        );
      }
    }
    // A yt-dlp left running by a crashed Haul must not write the same partial files as the new one.
    stopLeftoverProcess(parts, tools);
    await removeIfExists(path.join(parts, 'final-path.txt'));

    const ext = path.extname(rec.fileName);
    const stem = rec.fileName.slice(0, rec.fileName.length - ext.length);
    const args = buildDownloadArgs(spec, { url: rec.url, home: rec.directory, temp: parts, stem, tools, rateLimit: this.settings.speedLimit });
    this.log.info(`yt-dlp ${task.id} ${redactUrl(rec.url)} ${spec.label}`);

    // Progress across streams: a video download from YouTube is a video stream, then a sound stream,
    // then a merge; most other sites serve one stream with the sound built in.
    const twoStreams = spec.mode === 'video' && !!spec.audioFormatId;
    let stream = 0;
    let finished = 0;
    let current = 0;
    let currentTotal: number | null = null;
    const label = () =>
      twoStreams ? `Downloading ${stream <= 1 ? 'video' : 'sound'} (${Math.min(Math.max(stream, 1), 2)} of 2)` : spec.mode === 'audio' ? 'Downloading audio' : 'Downloading video';
    const update = () => {
      task.bytes = finished + current;
      const stillToCome = twoStreams && stream <= 1 ? spec.estimateAudio ?? 0 : 0;
      task.liveTotal = Math.max(finished + (currentTotal ?? 0) + stillToCome, task.bytes) || task.liveTotal;
    };
    task.phase = 'Asking the site for the video…';

    const child = startYtDlp(tools, args);
    recordProcess(parts, child.pid);
    const onAbort = () => killTree(child);
    signal.addEventListener('abort', onAbort);
    const errLines: string[] = [];
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', (e) => reject(new MediaError(`Could not start yt-dlp: ${e.message}`)));
      child.once('close', (code) => resolve(code));
    });
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const ev = parseOutputLine(line);
      if (!ev) return;
      if (ev.type === 'destination' && ev.stream) {
        stream++;
        current = 0;
        currentTotal = null;
        task.phase = label();
      } else if (ev.type === 'already') {
        stream++; // a stream completed by an earlier run; its "finished" progress line follows
      } else if (ev.type === 'progress') {
        if (ev.status === 'finished') {
          finished += Math.max(ev.downloaded, ev.total ?? 0);
          current = 0;
          currentTotal = null;
        } else {
          current = ev.downloaded;
          currentTotal = ev.total;
          if (!task.phase?.startsWith('Downloading')) task.phase = label();
        }
        update();
      } else if (ev.type === 'phase') {
        task.phase = ev.phase;
      } else if (ev.type === 'resume') {
        this.log.info(`yt-dlp ${task.id} continues a partial stream from byte ${ev.at}`);
      }
    });
    createInterface({ input: child.stderr! }).on('line', (line) => {
      errLines.push(line);
      if (errLines.length > 60) errLines.shift();
    });
    let code: number | null;
    try {
      code = await exited;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted || task.stopReason) throw abortError();
    if (code !== 0) throw new MediaError(cleanError(errLines.join('\n')) || `yt-dlp stopped unexpectedly (exit code ${code}).`);
    await this.finalizeMedia(task, parts);
  }

  /** Confirms yt-dlp's finished file exists in the download folder, then marks the download completed. */
  private async finalizeMedia(task: ActiveTask, parts: string): Promise<void> {
    const rec = this.require(task.id);
    const expected = path.join(rec.directory, rec.fileName);
    const reported = reportedFinalPath(parts);
    // Only trust a reported path inside the download folder.
    const candidates = [reported && samePath(path.dirname(reported), rec.directory) ? reported : null, expected];
    const final = candidates.find((p): p is string => !!p && fs.existsSync(p));
    if (!final) throw new MediaError('yt-dlp finished, but the downloaded file was not found in the download folder.');
    const size = (await fileSize(final)) ?? 0;
    if (size === 0) throw new MediaError('yt-dlp produced an empty file.');
    if (this.onFileFinalized) await this.onFileFinalized(final, rec).catch(() => {});
    await fsp.rm(parts, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    task.bytes = size;
    task.phase = null;
    this.patch(task.id, {
      state: 'completed',
      fileName: path.basename(final),
      downloadedBytes: size,
      totalBytes: size,
      completedAt: Date.now(),
      error: null,
      notice: null,
    });
    this.log.info(`completed ${task.id} (${size} bytes via yt-dlp)`);
  }

  // ------------------------------------------------------------- the transfer

  /** One HTTP attempt. Resolves when the file is finalized; throws on any failure. */
  private async attempt(task: ActiveTask, forceFresh: boolean): Promise<void> {
    const signal = task.controller.signal;
    if (signal.aborted) throw abortError();
    let rec = this.require(task.id);

    try {
      await fsp.mkdir(rec.directory, { recursive: true });
    } catch (e) {
      throw new RequestError(`Cannot create the folder "${rec.directory}" (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).`);
    }

    let existing = rec.fileNameSettled ? (await fileSize(this.partialPath(rec))) ?? 0 : 0;
    // Parts recorded by an earlier run in several connections. They must still describe the file on disk.
    let segments: Segment[] | null = forceFresh ? null : rec.segments;
    if (segments) {
      const farthest = Math.max(...segments.map((x) => x.start + x.done));
      const usable = existing > 0 && rec.totalBytes !== null && validSegments(segments, rec.totalBytes) && existing >= farthest && !segments.every((x) => x.done >= x.end - x.start);
      if (!usable) {
        segments = null;
        if (existing > 0) {
          await removeIfExists(this.partialPath(rec));
          existing = 0;
        }
        rec = this.patch(task.id, { segments: null, downloadedBytes: 0 });
      }
    }
    if (existing > 0 && rec.totalBytes !== null && existing > rec.totalBytes) {
      await removeIfExists(this.partialPath(rec));
      existing = 0;
      segments = null;
    }
    if (!forceFresh && existing === 0 && rec.downloadedBytes > 0 && rec.fileNameSettled) {
      task.restartNotice = 'The partial file was deleted or moved, so the download started over.';
    }
    // Where to continue: the first unfinished part, or (one connection) the end of the partial file.
    const resumeSeg = segments ? sorted(segments).find((x) => x.done < x.end - x.start) ?? null : null;
    const resumeFrom = resumeSeg ? resumeSeg.start + resumeSeg.done : existing;
    const onDisk = segments ? sumDone(segments) : existing;
    // Resuming needs evidence the remote file is unchanged: a validator, or at minimum the known total size.
    const canResume =
      !forceFresh && onDisk > 0 && rec.resumable !== false && (isStrongEtag(rec.etag) || !!rec.lastModified || rec.totalBytes !== null);
    const baseHeaders: Record<string, string> = this.userAgent ? { 'User-Agent': this.userAgent } : {};
    if (rec.referrer) baseHeaders.Referer = rec.referrer;
    const headers: Record<string, string> = { ...baseHeaders };
    if (canResume) {
      headers.Range = resumeSeg && rec.totalBytes !== null && resumeSeg.end < rec.totalBytes ? `bytes=${resumeFrom}-${resumeSeg.end - 1}` : `bytes=${resumeFrom}-`;
      if (isStrongEtag(rec.etag)) headers['If-Range'] = rec.etag;
      else if (rec.lastModified) headers['If-Range'] = rec.lastModified;
    } else if (onDisk > 0 && !forceFresh) {
      task.restartNotice = 'This server does not support resuming, so the download restarted from the beginning.';
    }

    this.log.info(`request ${task.id} ${redactUrl(rec.url)}${canResume ? ` from byte ${resumeFrom}` : ''}`);
    let opened: OpenResult;
    try {
      opened = await openGet(rec.url, { headers, signal, timeoutMs: this.timeoutMs });
    } catch (e) {
      throw toNetworkError(e as NodeJS.ErrnoException);
    }
    const { response: res, finalUrl, destroy } = opened;
    const status = res.statusCode ?? 0;
    const restart = async (why: string) => {
      destroy();
      task.restartNotice = why;
      await removeIfExists(this.partialPath(rec));
      this.patch(task.id, { downloadedBytes: 0, segments: null, notice: why });
      task.bytes = 0;
      return this.attempt(task, true);
    };
    const encoding = header(res, 'content-encoding');
    const encoded = !!encoding && encoding !== 'identity';

    let append = false;
    let expectedTotal: number | null;

    if (canResume && status === 206) {
      const cr = parseContentRange(header(res, 'content-range'));
      const etag = header(res, 'etag') ?? null;
      const lastModified = header(res, 'last-modified') ?? null;
      const problems: string[] = [];
      if (!cr) problems.push('missing or invalid Content-Range');
      else {
        if (cr.start !== resumeFrom) problems.push(`server resumed at byte ${cr.start} instead of ${resumeFrom}`);
        if (cr.total === null) problems.push('unknown total size');
        else if (rec.totalBytes !== null && cr.total !== rec.totalBytes) problems.push('file size changed on the server');
      }
      if (rec.etag && etag && etag !== rec.etag) problems.push('file version (ETag) changed');
      if (rec.lastModified && lastModified && lastModified !== rec.lastModified) problems.push('modification date changed');
      if (encoded) problems.push('compressed response');
      if (problems.length) return restart(`Could not safely resume (${problems.join('; ')}), so the download restarted from the beginning.`);
      append = true;
      expectedTotal = cr!.total;
      task.pageNotice = webPageNotice(res, rec);
      rec = this.patch(task.id, { finalUrl, resumable: true, downloadedBytes: onDisk, notice: notices(task), error: null });
    } else if (canResume && status === 416) {
      const total = parseUnsatisfiedRange(header(res, 'content-range'));
      destroy();
      if (!segments && total !== null && total === existing && rec.totalBytes === total) {
        await this.finalize(task, existing);
        return;
      }
      return restart('The server rejected the resume request, so the download restarted from the beginning.');
    } else if (status === 200 || (!canResume && status === 206 && parseContentRange(header(res, 'content-range'))?.start === 0)) {
      if (canResume) {
        task.restartNotice =
          'The server sent the whole file instead of the remaining part (resume unsupported or the file changed), so the download restarted from the beginning.';
      }
      segments = null;
      const cr = status === 206 ? parseContentRange(header(res, 'content-range')) : null;
      const length = cr ? cr.total : parseLength(header(res, 'content-length'));
      expectedTotal = length;
      // Many servers support ranges without advertising them, so a missing Accept-Ranges header means
      // "unknown" (a validated Range request is tried on resume). Only "none", or a 200 reply to the
      // Range request we just sent, means resuming is impossible.
      const acceptRanges = header(res, 'accept-ranges') ?? '';
      let resumable: boolean | null =
        /\bbytes\b/i.test(acceptRanges) || status === 206 ? true : /\bnone\b/i.test(acceptRanges) || canResume ? false : null;
      if (encoded || expectedTotal === null || task.singleOnly) resumable = false;
      task.pageNotice = webPageNotice(res, rec);
      const patch: Partial<DownloadRecord> = {
        finalUrl,
        totalBytes: expectedTotal,
        etag: header(res, 'etag') ?? null,
        lastModified: header(res, 'last-modified') ?? null,
        resumable,
        downloadedBytes: 0,
        segments: null,
        notice: notices(task),
        error: null,
      };
      if (!rec.fileNameSettled) {
        const suggested =
          parseContentDisposition(header(res, 'content-disposition')) ?? fileNameFromUrl(finalUrl) ?? fileNameFromUrl(rec.url) ?? '';
        const base = withExtensionForMime(sanitizeFileName(suggested, 'download'), header(res, 'content-type'));
        let directory = rec.directory;
        if (rec.autoCategory) {
          ({ directory } = this.sortedDirectory(rec.directory, base));
          patch.autoCategory = false;
          if (!samePath(directory, rec.directory)) {
            try {
              await fsp.mkdir(directory, { recursive: true });
              patch.directory = directory;
            } catch (e) {
              destroy();
              throw new RequestError(`Cannot create the folder "${directory}" (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).`);
            }
          }
        }
        patch.fileName = uniqueFileName(directory, base, (p) => this.isPathTaken(p, task.id));
        patch.fileNameSettled = true;
      }
      rec = this.patch(task.id, patch);
    } else {
      destroy();
      throw httpError(status, res);
    }

    // Disk space check when the size is known.
    if (expectedTotal !== null) {
      const needed = expectedTotal - (append ? onDisk : 0);
      const free = await this.getFreeSpace(rec.directory);
      if (free !== null && free < needed) {
        destroy();
        throw new RequestError(
          `Not enough disk space: ${formatBytes(needed)} needed but only ${formatBytes(free)} is free on this drive. Free up space or choose another folder, then retry.`,
        );
      }
    }

    // Several connections when the file is big enough and the server can serve parts. A server that
    // does not advertise byte ranges may still support them, so that is tried too (and undone if not).
    const acceptRanges = header(res, 'accept-ranges') ?? '';
    const rangesPossible = status === 206 || /\bbytes\b/i.test(acceptRanges) || (!/\bnone\b/i.test(acceptRanges) && rec.resumable !== false);
    const useParts =
      expectedTotal !== null &&
      !encoded &&
      rangesPossible &&
      (segments !== null || (this.settings.connections > 1 && !task.singleOnly && expectedTotal - (append ? existing : 0) >= 2 * this.minSegmentBytes));
    if (useParts) {
      try {
        await this.transferParts(task, rec, opened, baseHeaders, expectedTotal!, append ? existing : 0, segments, resumeFrom);
      } catch (e) {
        if (e instanceof FileChangedError) return restart(`Could not safely continue (${e.message}), so the download restarted from the beginning.`);
        if (e instanceof RangesIgnoredError) {
          // Only the bytes complete at the front of the file are of use to one connection.
          task.singleOnly = true;
          const prefix = contiguousPrefix(this.require(task.id).segments ?? []);
          await fsp.truncate(this.partialPath(rec), prefix).catch(() => {});
          this.patch(task.id, { segments: null, downloadedBytes: prefix, resumable: false });
          task.bytes = prefix;
          this.log.info(`${task.id}: the server ignores Range requests; continuing with one connection`);
          return this.attempt(task, false);
        }
        throw e;
      }
      await this.finalize(task, expectedTotal!);
      return;
    }

    const partPath = this.partialPath(rec);
    task.bytes = append ? existing : 0;
    task.meter.reset(task.bytes);
    // `flush` makes closing the stream fsync the file, so every clean stop leaves durable data.
    const ws = fs.createWriteStream(partPath, { flags: append ? 'a' : 'w', flush: true });
    task.ws = ws;
    task.wsBase = task.bytes;
    task.connections = 1;
    const limiter = this.limiter;
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        // The speed limit: waiting here stops reading from the socket, so the server slows down too.
        limiter.take(chunk.length, signal).then(
          () => {
            task.bytes += chunk.length;
            task.meter.sample(task.bytes);
            if (expectedTotal !== null && task.bytes > expectedTotal) {
              cb(new RequestError('The server sent more data than it announced; the download was stopped to avoid a corrupt file.'));
              return;
            }
            cb(null, chunk);
          },
          (err: Error) => cb(err),
        );
      },
    });

    try {
      await pipeline(res, counter, ws, { signal });
    } catch (e) {
      destroy();
      if (!ws.closed) await new Promise<void>((r) => ws.once('close', () => r()));
      if (signal.aborted || task.stopReason) throw abortError();
      const err = e as NodeJS.ErrnoException;
      if (err instanceof RequestError) {
        await removeIfExists(partPath);
        throw err;
      }
      if (err.code === 'ENOSPC') throw new RequestError('The disk is full. Free up space and retry; the partial download was kept.');
      if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') {
        throw new RequestError(`Cannot write to "${rec.directory}" (permission denied). Choose a different folder and retry.`);
      }
      if (res.errored || err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.message === 'aborted') {
        throw new NetworkError('The connection was interrupted before the download finished.');
      }
      throw toNetworkError(err);
    } finally {
      task.connections = 0;
    }

    if (!res.complete) throw new NetworkError('The connection was interrupted before the download finished.');
    const size = (await fileSize(partPath)) ?? 0;
    if (expectedTotal !== null && size !== expectedTotal) {
      if (size > expectedTotal) await removeIfExists(partPath);
      throw new NetworkError(`Download incomplete: received ${formatBytes(size)} of ${formatBytes(expectedTotal)}.`);
    }
    await this.finalize(task, size);
  }

  /**
   * Downloads the file in parts with several connections (see multipart.ts). `opened` is the response
   * already received for the part starting at `resumeFrom`. Whatever happens, every part's flushed
   * progress is recorded before this returns, so a retry or the next start continues from it.
   */
  private async transferParts(
    task: ActiveTask,
    rec: DownloadRecord,
    opened: OpenResult,
    headers: Record<string, string>,
    total: number,
    prefix: number,
    stored: Segment[] | null,
    resumeFrom: number,
  ): Promise<void> {
    const partPath = this.partialPath(rec);
    const fresh = stored === null && prefix === 0;
    const live: LiveSegment[] = (stored ?? planSegments(prefix, total, this.settings.connections, this.minSegmentBytes)).map((x) => ({
      ...x,
      written: x.done,
      inflight: 0,
    }));
    const first = live.find((x) => x.start + x.written === resumeFrom && x.written < x.end - x.start);
    if (!first) {
      opened.destroy();
      throw new FileChangedError('the saved parts do not match the server response');
    }
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(partPath, fs.constants.O_RDWR | fs.constants.O_CREAT);
      if (fresh) await fh.truncate(0);
    } catch (e) {
      opened.destroy();
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        throw new RequestError(`Cannot write to "${rec.directory}" (permission denied). Choose a different folder and retry.`);
      }
      throw new RequestError(`Cannot write the file (${code ?? (e as Error).message}).`);
    }
    task.fh = fh;
    task.segments = live;
    task.bytes = live.reduce((n, x) => n + x.written, 0);
    task.meter.reset(task.bytes);
    this.patch(task.id, { segments: storedSegments(live) }); // the plan survives a crash
    this.log.info(`${task.id}: ${live.filter((x) => x.written < x.end - x.start).length} part(s) with up to ${this.settings.connections} connections`);
    let outcome: Error | null = null;
    try {
      await runMultipart({
        url: rec.url,
        headers,
        etag: rec.etag,
        lastModified: rec.lastModified,
        total,
        segments: live,
        maxConnections: () => this.settings.connections,
        minSplit: Math.max(256 * 1024, this.minSegmentBytes / 2),
        first: { opened, segment: first },
        fh,
        signal: task.controller.signal,
        timeoutMs: this.timeoutMs,
        limiter: this.limiter,
        onProgress: (n) => {
          task.bytes += n;
          task.meter.sample(task.bytes);
        },
        onConnections: (n) => (task.connections = n),
        onBackOff: (n) => (task.limitNotice = `The server allows fewer connections than asked for, so this download continued with ${n}.`),
        log: (msg) => this.log.info(`${task.id}: ${msg}`),
      });
    } catch (e) {
      outcome = e as Error;
    }
    // Keep what is safely on disk, whatever happened: flush, then record each part's progress.
    try {
      await fh.sync();
      for (const x of live) x.done = Math.max(x.done, x.written);
    } catch {
      /* the last checkpoint stands */
    }
    await fh.close().catch(() => {});
    task.fh = null;
    task.segments = null;
    task.connections = 0;
    const segments = storedSegments(live);
    if (this.records.has(task.id)) this.patch(task.id, { segments, downloadedBytes: sumDone(segments) });
    if (outcome) throw outcome;
    const size = (await fileSize(partPath)) ?? 0;
    if (size !== total) throw new NetworkError(`Download incomplete: received ${formatBytes(size)} of ${formatBytes(total)}.`);
  }

  /** Moves the finished partial file to its final name. Only then is the download marked completed. */
  private async finalize(task: ActiveTask, size: number): Promise<void> {
    const rec = this.require(task.id);
    const partPath = this.partialPath(rec);
    let name = rec.fileName;
    if (fs.existsSync(path.join(rec.directory, name))) {
      // Something created a file with our name while we were downloading.
      name = uniqueFileName(rec.directory, name, (p) => fs.existsSync(p) || this.isReservedByOther(p, task.id));
    }
    const finalPath = path.join(rec.directory, name);
    try {
      await renameWithRetry(partPath, finalPath);
    } catch (e) {
      throw new RequestError(`Could not finalize the file "${name}" (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).`);
    }
    if (this.onFileFinalized) await this.onFileFinalized(finalPath, rec).catch(() => {});
    task.bytes = size;
    this.patch(task.id, {
      state: 'completed',
      fileName: name,
      downloadedBytes: size,
      totalBytes: size,
      segments: null,
      completedAt: Date.now(),
      error: null,
      notice: notices(task),
    });
    this.log.info(`completed ${task.id} (${size} bytes)`);
  }

  // ------------------------------------------------------------------ helpers

  private partialPath(r: DownloadRecord): string {
    return path.join(r.directory, r.fileName + PARTIAL_SUFFIX);
  }

  /** True if the path exists on disk (as final or partial file) or is claimed by another unfinished download. */
  private isPathTaken(p: string, selfId: string): boolean {
    return fs.existsSync(p) || fs.existsSync(p + PARTIAL_SUFFIX) || fs.existsSync(p + MEDIA_PARTS_SUFFIX) || this.isReservedByOther(p, selfId);
  }

  private isReservedByOther(p: string, selfId: string): boolean {
    for (const r of this.records.values()) {
      if (r.id === selfId || !r.fileNameSettled || TERMINAL.includes(r.state)) continue;
      if (samePath(path.join(r.directory, r.fileName), p)) return true;
    }
    return false;
  }

  private require(id: string): DownloadRecord {
    const r = typeof id === 'string' ? this.records.get(id) : undefined;
    if (!r) throw new ValidationError('That download no longer exists.');
    return r;
  }

  private patch(id: string, p: Partial<DownloadRecord>): DownloadRecord {
    const cur = this.records.get(id);
    if (!cur) throw new ValidationError('That download no longer exists.');
    const next = { ...cur, ...p, updatedAt: Date.now() };
    this.records.set(id, next);
    this.store.upsert(next);
    this.emitChange(next);
    return next;
  }

  private emitChange(r: DownloadRecord): void {
    this.emit('changed', this.view(r));
  }

  private tick(): void {
    this.ticks++;
    const checkpoint = this.ticks % this.persistEvery === 0;
    for (const t of this.active.values()) {
      const r = this.records.get(t.id);
      if (!r || r.state !== 'downloading') continue;
      t.meter.sample(t.bytes);
      if (checkpoint) this.checkpoint(t);
      // Also re-emit periodically without new data, so a stalled transfer's speed visibly drops to 0.
      if (t.bytes !== t.lastEmittedBytes || checkpoint) {
        t.lastEmittedBytes = t.bytes;
        this.emitChange(r);
      }
    }
  }

  /**
   * Flushes the partial file to disk, then stores how many bytes are now durable. While a download
   * runs, the stored `downloadedBytes` is this checkpoint (the live count is only kept in memory),
   * which is what crash recovery trims the partial file back to.
   */
  private checkpoint(t: ActiveTask): void {
    const ws = t.ws;
    const fd = ws ? fdOf(ws) : null;
    const r = this.records.get(t.id);
    if (t.fh && t.segments && r) {
      if (t.syncing) return;
      const fh = t.fh;
      const segs = t.segments;
      // Bytes handed to the OS so far, captured before the flush so they never overstate.
      const written = segs.map((x) => x.written);
      if (written.every((w, i) => w === segs[i].done)) return;
      t.syncing = true;
      fh.sync().then(
        () => {
          t.syncing = false;
          const cur = this.records.get(t.id);
          if (t.fh !== fh || !cur || cur.state !== 'downloading' || this.shuttingDown) return;
          written.forEach((w, i) => (segs[i].done = Math.max(segs[i].done, w)));
          const segments = storedSegments(segs);
          const next = { ...cur, segments, downloadedBytes: sumDone(segments), updatedAt: Date.now() };
          this.records.set(cur.id, next);
          this.store.upsert(next);
        },
        () => (t.syncing = false),
      );
      return;
    }
    if (r?.kind === 'media') {
      // yt-dlp owns the partial files; just keep the shown progress for the next start.
      if (r.downloadedBytes !== t.bytes || (t.liveTotal !== null && t.liveTotal !== r.totalBytes)) {
        const next = { ...r, downloadedBytes: t.bytes, totalBytes: t.liveTotal ?? r.totalBytes, updatedAt: Date.now() };
        this.records.set(r.id, next);
        this.store.upsert(next);
      }
      return;
    }
    if (!ws || fd === null || t.syncing || !r) return;
    // Bytes the stream has handed to the OS so far; captured before the flush so it never overstates.
    const durable = t.wsBase + ws.bytesWritten;
    if (durable === r.downloadedBytes) return;
    t.syncing = true;
    fs.fsync(fd, (err) => {
      t.syncing = false;
      const cur = this.records.get(t.id);
      if (err || t.ws !== ws || !cur || cur.state !== 'downloading' || this.shuttingDown) return;
      const next = { ...cur, downloadedBytes: durable, updatedAt: Date.now() };
      this.records.set(cur.id, next);
      this.store.upsert(next);
    });
  }
}

/** File descriptor of an open write stream, or null before it opens / after it closes. */
function fdOf(ws: fs.WriteStream): number | null {
  const fd = (ws as unknown as { fd: unknown }).fd;
  return typeof fd === 'number' && !ws.destroyed ? fd : null;
}

function notices(task: ActiveTask): string | null {
  return [task.restartNotice, task.pageNotice, task.limitNotice].filter(Boolean).join(' ') || null;
}

const WEB_PAGE_EXTENSIONS = /^\.(html?|xhtml|shtml|php\d?|aspx?|jsp|cgi|cfm)$/i;

/**
 * A web page is rarely what someone pasting a link into a download manager wants: it usually means
 * a link to a page that shows the file (a video site, a "your download will start" page), a login
 * page, or an expired link. The page is still saved, with an explanation.
 */
function webPageNotice(res: IncomingMessage, rec: DownloadRecord): string | null {
  const mime = (header(res, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (mime !== 'text/html' && mime !== 'application/xhtml+xml') return null;
  if (parseContentDisposition(header(res, 'content-disposition'))) return null; // server named it deliberately
  const ext = path.extname(rec.fileNameSettled ? rec.fileName : (fileNameFromUrl(rec.url) ?? ''));
  if (ext && !WEB_PAGE_EXTENSIONS.test(ext)) {
    return `The server sent a web page instead of the expected ${ext} file, so this is probably not the file you wanted. The link may need you to sign in, may have expired, or may lead to a download page rather than the file itself.`;
  }
  return 'This link leads to a web page, so the page itself (HTML) was saved, not a video or file shown on it. Use a direct link to the file.';
}

/** Parts as stored in the database: sorted, without the live counters. */
function storedSegments(live: LiveSegment[]): Segment[] {
  return sorted(live).map((x) => ({ start: x.start, end: x.end, done: x.done }));
}

/** The page a link came from, for the Referer header; anything but an http(s) URL is dropped. */
function validateReferrer(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) return null;
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function normalizeSettings(s: Partial<Settings>, defaults: Settings): Settings {
  try {
    return validateSettings(s);
  } catch {
    const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
    return {
      downloadDirectory:
        typeof s.downloadDirectory === 'string' && path.isAbsolute(s.downloadDirectory) ? s.downloadDirectory : defaults.downloadDirectory,
      maxConcurrent: Number.isInteger(s.maxConcurrent) ? Math.min(Math.max(1, s.maxConcurrent!), MAX_CONCURRENT_LIMIT) : defaults.maxConcurrent,
      resumeOnStartup: bool(s.resumeOnStartup, defaults.resumeOnStartup),
      ytDlpPath: typeof s.ytDlpPath === 'string' && (s.ytDlpPath === '' || path.isAbsolute(s.ytDlpPath)) ? s.ytDlpPath : '',
      autoMediaTools: bool(s.autoMediaTools, defaults.autoMediaTools),
      speedLimit: Number.isInteger(s.speedLimit) && s.speedLimit! >= 0 ? Math.min(s.speedLimit!, MAX_SPEED_LIMIT) : defaults.speedLimit,
      categoriesEnabled: bool(s.categoriesEnabled, defaults.categoriesEnabled),
      startWithWindows: bool(s.startWithWindows, defaults.startWithWindows),
      closeToTray: bool(s.closeToTray, defaults.closeToTray),
      connections: Number.isInteger(s.connections) ? Math.min(Math.max(1, s.connections!), MAX_CONNECTIONS) : defaults.connections,
    };
  }
}

export function validateSettings(input: unknown): Settings {
  const s = (input ?? {}) as Record<string, unknown>;
  // Settings saved by an older Haul lack the values added since: those keep their defaults.
  const optionalBool = (v: unknown, name: string, fallback: boolean): boolean => {
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'boolean') throw new ValidationError(`Invalid "${name}" value.`);
    return v;
  };
  if (typeof s.downloadDirectory !== 'string' || !s.downloadDirectory.trim() || !path.isAbsolute(s.downloadDirectory.trim())) {
    throw new ValidationError('Choose a full path for the default download folder.');
  }
  const max = Number(s.maxConcurrent);
  if (!Number.isInteger(max) || max < 1 || max > MAX_CONCURRENT_LIMIT) {
    throw new ValidationError(`Simultaneous downloads must be a whole number from 1 to ${MAX_CONCURRENT_LIMIT}.`);
  }
  if (typeof s.resumeOnStartup !== 'boolean') throw new ValidationError('Invalid "resume on startup" value.');
  // Settings saved by Haul 1.0 have no yt-dlp location: automatic detection.
  const yt = s.ytDlpPath === undefined || s.ytDlpPath === null ? '' : s.ytDlpPath;
  if (typeof yt !== 'string' || yt.length > 1024 || (yt.trim() !== '' && !path.isAbsolute(yt.trim()))) {
    throw new ValidationError('Choose the full path of yt-dlp.exe, or leave it empty to find it automatically.');
  }
  const limit = s.speedLimit === undefined || s.speedLimit === null ? 0 : Number(s.speedLimit);
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_SPEED_LIMIT) {
    throw new ValidationError('The speed limit must be a whole number of KB/s (0 or empty for no limit).');
  }
  // Settings saved before 1.4 have no connection count.
  const connections = s.connections === undefined || s.connections === null ? SETTINGS_DEFAULTS.connections : Number(s.connections);
  if (!Number.isInteger(connections) || connections < 1 || connections > MAX_CONNECTIONS) {
    throw new ValidationError(`Connections per download must be a whole number from 1 to ${MAX_CONNECTIONS}.`);
  }
  return {
    downloadDirectory: path.resolve(s.downloadDirectory.trim()),
    maxConcurrent: max,
    resumeOnStartup: s.resumeOnStartup,
    ytDlpPath: yt.trim() ? path.resolve(yt.trim()) : '',
    autoMediaTools: optionalBool(s.autoMediaTools, 'get the tools automatically', SETTINGS_DEFAULTS.autoMediaTools),
    speedLimit: limit,
    categoriesEnabled: optionalBool(s.categoriesEnabled, 'categories', SETTINGS_DEFAULTS.categoriesEnabled),
    startWithWindows: optionalBool(s.startWithWindows, 'start with Windows', SETTINGS_DEFAULTS.startWithWindows),
    closeToTray: optionalBool(s.closeToTray, 'keep running in the background', SETTINGS_DEFAULTS.closeToTray),
    connections,
  };
}

/** Waits for `p`, but rejects with an AbortError as soon as `signal` is aborted (`p` keeps running). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const FORMAT_ID = /^[A-Za-z0-9_-]{1,32}$/;
const LANG_CODE = /^[A-Za-z0-9_-]{1,24}$/;

/**
 * Checks a quality choice coming from the UI. Every value that ends up on yt-dlp's command line is
 * either a fixed word or matches a strict pattern, so nothing can smuggle in extra options.
 */
export function validateMediaRequest(input: unknown): MediaSpec {
  const m = (input ?? {}) as Record<string, unknown>;
  const fail = (what: string) => {
    throw new ValidationError(`Invalid video download choice (${what}).`);
  };
  const mode = m.mode;
  if (mode !== 'video' && mode !== 'video-only' && mode !== 'audio') fail('type');
  // Height 0 means "best available": sites that do not report the size of their video.
  const height = m.height === null || m.height === undefined ? null : Number(m.height);
  if (mode !== 'audio' && (height === null || !Number.isInteger(height) || height < 0 || (height > 0 && height < 100) || height > 8640)) fail('quality');
  const audioFormat = m.audioFormat === 'mp3' || m.audioFormat === 'm4a' ? m.audioFormat : null;
  if (mode === 'audio' && !audioFormat) fail('audio format');
  const optId = (v: unknown, what: string) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v !== 'string' || !FORMAT_ID.test(v)) fail(what);
    return v as string;
  };
  const subtitles = optId(m.subtitles, 'subtitles');
  if (subtitles && !LANG_CODE.test(subtitles)) fail('subtitles');
  const estimate = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e13 ? Math.round(v) : null);
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const title = text(m.title, 300);
  if (!title) fail('title');
  return {
    mode: mode as MediaSpec['mode'],
    height: mode === 'audio' ? null : height,
    audioFormat: mode === 'audio' ? audioFormat : null,
    thumbnail: m.thumbnail === true,
    subtitles,
    videoFormatId: mode === 'audio' ? null : optId(m.videoFormatId, 'video format'),
    audioFormatId: mode === 'video-only' ? null : optId(m.audioFormatId, 'audio format'),
    videoId: text(m.videoId, 64),
    title,
    label: text(m.label, 120) || (mode === 'audio' ? `Audio (${audioFormat?.toUpperCase()})` : height ? `${height}p` : 'Best available'),
    estimateVideo: mode === 'audio' ? null : estimate(m.estimateVideo),
    estimateAudio: mode === 'video-only' ? null : estimate(m.estimateAudio),
  };
}
