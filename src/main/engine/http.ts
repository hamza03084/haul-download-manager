import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';

export const USER_AGENT = 'HaulDownloadManager/1.0 (+Windows)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Network-level failure that may succeed if retried (reset, timeout, refused, premature close). */
export class NetworkError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Non-retryable request problem (bad redirect, unsupported protocol...). */
export class RequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestError';
  }
}

export interface OpenOptions {
  headers?: Record<string, string>;
  signal: AbortSignal;
  /** Socket idle timeout in ms, applied while connecting and while streaming the body. */
  timeoutMs: number;
  maxRedirects?: number;
}

export interface OpenResult {
  response: IncomingMessage;
  finalUrl: string;
  /** Destroys the underlying request/response. Safe to call more than once. */
  destroy(err?: Error): void;
}

/** Sends a GET request, following redirects, and resolves once response headers arrive. */
export async function openGet(url: string, opts: OpenOptions): Promise<OpenResult> {
  const maxRedirects = opts.maxRedirects ?? 10;
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    const result = await requestOnce(current, opts);
    const { response } = result;
    const status = response.statusCode ?? 0;
    if (!REDIRECT_STATUSES.has(status)) return { ...result, finalUrl: current.href };

    result.destroy();
    const location = response.headers.location;
    if (!location) throw new RequestError(`Server returned a redirect (HTTP ${status}) without a destination.`);
    if (hop >= maxRedirects) throw new RequestError(`Too many redirects (more than ${maxRedirects}).`);
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new RequestError('Server redirected to an invalid URL.');
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new RequestError(`Server redirected to an unsupported protocol (${next.protocol.replace(/:$/, '')}).`);
    }
    current = next;
  }
}

function requestOnce(url: URL, opts: OpenOptions): Promise<Omit<OpenResult, 'finalUrl'>> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(abortError());
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        // Byte ranges are only meaningful on the identity encoding, and Node does not decompress.
        'Accept-Encoding': 'identity',
        ...opts.headers,
      },
      signal: opts.signal,
    });
    let settled = false;
    const destroy = (err?: Error) => {
      if (!req.destroyed) req.destroy(err);
    };
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(new NetworkError(`Connection timed out after ${Math.round(opts.timeoutMs / 1000)} s with no data.`, 'ETIMEDOUT'));
    });
    req.on('response', (response) => {
      settled = true;
      resolve({ response, destroy });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return; // errors after headers surface on the response stream
      settled = true;
      reject(toNetworkError(err));
    });
    req.end();
  });
}

export function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR');
}

const FRIENDLY_CODES: Record<string, string> = {
  ENOTFOUND: 'Server not found. Check the address and your internet connection.',
  EAI_AGAIN: 'Could not resolve the server name. Check your internet connection.',
  ECONNREFUSED: 'The server refused the connection.',
  ECONNRESET: 'The connection was reset by the server.',
  ETIMEDOUT: 'The connection timed out.',
  EHOSTUNREACH: 'The server is unreachable.',
  ENETUNREACH: 'The network is unreachable. Check your internet connection.',
  EPIPE: 'The connection was closed unexpectedly.',
  ERR_TLS_CERT_ALTNAME_INVALID: "The server's security certificate does not match its address.",
  CERT_HAS_EXPIRED: "The server's security certificate has expired.",
  DEPTH_ZERO_SELF_SIGNED_CERT: 'The server uses a self-signed certificate, which is not trusted.',
  SELF_SIGNED_CERT_IN_CHAIN: "The server's certificate chain is not trusted.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "The server's security certificate could not be verified.",
};
const NON_RETRYABLE_CODES = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

export function toNetworkError(err: NodeJS.ErrnoException): Error {
  if (isAbortError(err) || err instanceof NetworkError || err instanceof RequestError) return err;
  const code = err.code ?? '';
  const friendly = FRIENDLY_CODES[code];
  if (NON_RETRYABLE_CODES.has(code)) return new RequestError(friendly ?? err.message);
  return new NetworkError(friendly ?? `Network error: ${err.message}`, code || undefined);
}

/** Parses `Content-Range: bytes start-end/total` (total may be `*`). */
export function parseContentRange(header: string | undefined): { start: number; end: number; total: number | null } | null {
  if (!header) return null;
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(header);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = m[3] === '*' ? null : Number(m[3]);
  if (end < start || (total !== null && end >= total)) return null;
  return { start, end, total };
}

/** Parses `Content-Range: bytes * /total` as sent with 416 responses. */
export function parseUnsatisfiedRange(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^\s*bytes\s+\*\/(\d+)\s*$/i.exec(header);
  return m ? Number(m[1]) : null;
}

/** Retry-After header in milliseconds (delta-seconds or HTTP date), or null. */
export function parseRetryAfter(header: string | undefined, now = Date.now()): number | null {
  if (!header) return null;
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1000;
  const t = Date.parse(header);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

export function isStrongEtag(etag: string | null | undefined): etag is string {
  return !!etag && !etag.startsWith('W/');
}

/** HTTP error status from the server. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function httpError(status: number, res: IncomingMessage): HttpStatusError {
  const retryAfter = parseRetryAfter(header(res, 'retry-after'));
  const messages: Record<number, string> = {
    400: 'The server rejected the request (HTTP 400).',
    401: 'The server requires you to sign in (HTTP 401). Download the file from your browser instead.',
    403: 'Access denied (HTTP 403). The link may have expired or require signing in.',
    404: 'File not found on the server (HTTP 404).',
    410: 'The file is no longer available (HTTP 410).',
    429: 'The server is limiting requests (HTTP 429).',
  };
  let msg = messages[status] ?? (status >= 500 ? `Server error (HTTP ${status}).` : `Unexpected server response (HTTP ${status}).`);
  if (retryAfter !== null && retryAfter > 60_000) msg += ` The server asked to wait ${Math.ceil(retryAfter / 60_000)} min before retrying.`;
  return new HttpStatusError(status, msg, RETRYABLE_STATUSES.has(status), retryAfter);
}

export function header(res: IncomingMessage, name: string): string | undefined {
  const v = res.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function parseLength(v: string | undefined): number | null {
  if (!v || !/^\d+$/.test(v.trim())) return null;
  return Number(v.trim());
}
