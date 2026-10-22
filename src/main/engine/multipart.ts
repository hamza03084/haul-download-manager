// Downloading one file with several connections. The file is cut into parts (see segments.ts); each
// part is fetched by its own Range request and written at its place in the partial file. When a
// connection finishes early, the biggest part still running is split so the free connection helps
// with it. Servers that refuse the extra connections (HTTP 429/503/403) are given fewer, and a
// server that answers a Range request with the whole file makes the caller fall back to one
// connection. No Electron imports: this runs and is tested under plain Node.
import type { FileHandle } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Segment } from '../../shared/types';
import {
  NetworkError,
  RequestError,
  abortError,
  header,
  httpError,
  isAbortError,
  isStrongEtag,
  openGet,
  parseContentRange,
  toNetworkError,
  type OpenResult,
} from './http';
import type { RateLimiter } from './throttle';

/** A part while it is being downloaded: `written` bytes are handed to the OS, `done` are flushed. */
export interface LiveSegment extends Segment {
  written: number;
  /** Bytes of a write in progress (claimed, so a split never lands inside them). */
  inflight: number;
}

/** The server sent the whole file (HTTP 200) to a Range request: it cannot serve parts. */
export class RangesIgnoredError extends Error {
  constructor() {
    super('The server does not support downloading in parts.');
    this.name = 'RangesIgnoredError';
  }
}

/** A part's response does not belong to the file on disk (changed size, version or date). */
export class FileChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileChangedError';
  }
}

export interface MultipartOptions {
  url: string;
  /** Headers for every request (User-Agent, Referer); Range and If-Range are added per part. */
  headers: Record<string, string>;
  etag: string | null;
  lastModified: string | null;
  total: number;
  /** The parts; new parts are appended when a running one is split. Shared with the caller for checkpoints. */
  segments: LiveSegment[];
  /** Read whenever a connection could be opened, so a changed setting applies to running downloads. */
  maxConnections: () => number;
  /** A running part is only split when at least twice this many bytes of it are left. */
  minSplit: number;
  /** A response already open for one part (the first request, which also told us the file's size). */
  first: { opened: OpenResult; segment: LiveSegment } | null;
  fh: FileHandle;
  signal: AbortSignal;
  timeoutMs: number;
  limiter: RateLimiter;
  /** How often one part may reconnect after a dropped connection before the whole download fails. */
  maxReconnects?: number;
  onProgress: (bytes: number) => void;
  onConnections: (open: number) => void;
  /** The server refused parallel connections; the download continues with this many. */
  onBackOff?: (connections: number) => void;
  log?: (msg: string) => void;
}

const BACK_OFF_STATUSES = new Set([403, 429, 503]);

/** Range header for the rest of a part (open-ended for the last part, as single-connection resumes are). */
export function rangeHeader(seg: Segment & { written?: number }, total: number): string {
  const from = seg.start + (seg.written ?? seg.done);
  return `bytes=${from}-${seg.end >= total ? '' : seg.end - 1}`;
}

/** Resolves once every part is complete. Throws after stopping every connection otherwise. */
export function runMultipart(o: MultipartOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const local = new AbortController();
    const signal = local.signal;
    const onParentAbort = () => local.abort();
    if (o.signal.aborted) local.abort();
    else o.signal.addEventListener('abort', onParentAbort, { once: true });

    const running = new Set<LiveSegment>();
    /** Lowered when the server refuses parallel connections; never below one. */
    let backOffCap = Infinity;
    let failure: Error | null = null;
    let settled = false;
    const cap = () => Math.max(1, Math.min(o.maxConnections(), backOffCap));
    const remaining = (s: LiveSegment) => s.end - (s.start + s.written);
    const pending = () => o.segments.filter((s) => !running.has(s) && remaining(s) > 0).sort((a, b) => a.start - b.start);

    const finish = () => {
      if (settled) return;
      settled = true;
      o.signal.removeEventListener('abort', onParentAbort);
      if (failure) reject(failure);
      else if (o.signal.aborted) reject(abortError());
      else if (o.segments.every((s) => remaining(s) <= 0)) resolve();
      else reject(new NetworkError('The connection was interrupted before the download finished.'));
    };

    const launch = (seg: LiveSegment, opened?: OpenResult) => {
      running.add(seg);
      o.onConnections(running.size);
      void worker(seg, opened).then(
        () => {
          running.delete(seg);
          o.onConnections(running.size);
          fill();
          if (running.size === 0) finish();
        },
        (err: Error) => {
          running.delete(seg);
          o.onConnections(running.size);
          const status = (err as { status?: number }).status;
          if (!signal.aborted && status !== undefined && BACK_OFF_STATUSES.has(status) && running.size > 0) {
            // The server allows fewer connections than asked for: keep going with the ones it accepted;
            // this part is picked up again when one of them finishes.
            backOffCap = running.size;
            o.log?.(`server answered HTTP ${status} to an extra connection; continuing with ${backOffCap}`);
            o.onBackOff?.(backOffCap);
            return;
          }
          // The first real error wins; AbortErrors only follow from it (or from the caller stopping).
          if (!failure && !isAbortError(err)) failure = err;
          local.abort();
          if (running.size === 0) finish();
        },
      );
    };

    /** Keeps as many connections open as allowed: waiting parts first, then halves of running parts. */
    const fill = () => {
      if (signal.aborted || failure) return;
      while (running.size < cap()) {
        const next = pending()[0] ?? splitLargest();
        if (!next) return;
        launch(next);
      }
    };

    const splitLargest = (): LiveSegment | null => {
      let best: LiveSegment | null = null;
      let bestLeft = 0;
      for (const s of running) {
        const left = s.end - (s.start + s.written + s.inflight);
        if (left > bestLeft) {
          best = s;
          bestLeft = left;
        }
      }
      if (!best || bestLeft < 2 * o.minSplit) return null;
      const mid = best.start + best.written + best.inflight + Math.floor(bestLeft / 2);
      const seg: LiveSegment = { start: mid, end: best.end, done: 0, written: 0, inflight: 0 };
      best.end = mid;
      o.segments.push(seg);
      return seg;
    };

    /** Fetches one part to its end, reconnecting after dropped connections. */
    const worker = async (seg: LiveSegment, opened?: OpenResult): Promise<void> => {
      let reconnects = 0;
      for (;;) {
        if (signal.aborted) throw abortError();
        const pos = seg.start + seg.written;
        if (pos >= seg.end) return;
        if (!opened) {
          const headers: Record<string, string> = { ...o.headers, Range: rangeHeader(seg, o.total) };
          const validator = isStrongEtag(o.etag) ? o.etag : o.lastModified;
          if (validator) headers['If-Range'] = validator;
          try {
            opened = await openGet(o.url, { headers, signal, timeoutMs: o.timeoutMs });
          } catch (e) {
            throw toNetworkError(e as NodeJS.ErrnoException);
          }
          const res = opened.response;
          const status = res.statusCode ?? 0;
          if (status === 200) {
            opened.destroy();
            throw new RangesIgnoredError();
          }
          if (status !== 206) {
            opened.destroy();
            throw httpError(status, res);
          }
          const cr = parseContentRange(header(res, 'content-range'));
          const problems: string[] = [];
          if (!cr) problems.push('missing or invalid Content-Range');
          else {
            if (cr.start !== pos) problems.push(`server started at byte ${cr.start} instead of ${pos}`);
            if (cr.total !== o.total) problems.push('file size changed on the server');
          }
          const etag = header(res, 'etag');
          const lastModified = header(res, 'last-modified');
          if (o.etag && etag && etag !== o.etag) problems.push('file version (ETag) changed');
          if (o.lastModified && lastModified && lastModified !== o.lastModified) problems.push('modification date changed');
          const encoding = header(res, 'content-encoding');
          if (encoding && encoding !== 'identity') problems.push('compressed response');
          if (problems.length) {
            opened.destroy();
            throw new FileChangedError(problems.join('; '));
          }
        }
        let reached: boolean;
        try {
          reached = await consume(opened, seg);
        } finally {
          opened = undefined;
        }
        if (reached) return;
        if (signal.aborted) throw abortError();
        // The server closed the connection before the part was complete: ask for the rest.
        if (reconnects++ >= (o.maxReconnects ?? 3)) throw new NetworkError('The connection was interrupted before the download finished.');
        o.log?.(`connection for bytes ${seg.start}-${seg.end} dropped at ${seg.start + seg.written}; reconnecting (${reconnects})`);
        await delay(Math.min(500 * reconnects, 2000), undefined, { signal });
      }
    };

    /** Writes the response into the part. True once the part's end is reached (the connection is then closed). */
    const consume = async (opened: OpenResult, seg: LiveSegment): Promise<boolean> => {
      const res = opened.response;
      const done = () => seg.start + seg.written >= seg.end;
      try {
        for await (const chunk of res as AsyncIterable<Buffer>) {
          // The speed limit: waiting here stops reading from the socket, so the server slows down too.
          await o.limiter.take(chunk.length, signal);
          const len = Math.min(seg.end - (seg.start + seg.written), chunk.length);
          if (len > 0) {
            seg.inflight = len;
            try {
              await writeAll(o.fh, chunk, len, seg.start + seg.written);
            } finally {
              seg.inflight = 0;
            }
            seg.written += len;
            o.onProgress(len);
          }
          if (done()) {
            opened.destroy();
            return true;
          }
        }
      } catch (e) {
        if (done()) return true; // we closed the connection ourselves
        if (signal.aborted) throw abortError();
        throw mapTransferError(e as NodeJS.ErrnoException, res.errored !== null);
      } finally {
        opened.destroy();
      }
      return done();
    };

    const first = o.first;
    if (first) launch(first.segment, first.opened);
    fill();
    if (running.size === 0) finish();
  });
}

async function writeAll(fh: FileHandle, chunk: Buffer, len: number, position: number): Promise<void> {
  let off = 0;
  while (off < len) {
    const { bytesWritten } = await fh.write(chunk, off, len - off, position + off);
    if (bytesWritten <= 0) throw new RequestError('Writing to the file stopped unexpectedly.');
    off += bytesWritten;
  }
}

function mapTransferError(err: NodeJS.ErrnoException, responseErrored: boolean): Error {
  if (isAbortError(err)) return err;
  if (err instanceof RequestError || err instanceof NetworkError) return err;
  if (err.code === 'ENOSPC') return new RequestError('The disk is full. Free up space and retry; the partial download was kept.');
  if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS') return new RequestError('Cannot write to the download folder (permission denied). Choose a different folder and retry.');
  if (responseErrored || err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.message === 'aborted') {
    return new NetworkError('The connection was interrupted before the download finished.');
  }
  return toNetworkError(err);
}
