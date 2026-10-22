import { drmSiteOf, mediaSiteOf } from '../../shared/types';

export const MAX_URL_LENGTH = 8192;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Parses and validates a user-supplied download URL. Only http and https are accepted. */
export function validateDownloadUrl(input: unknown): URL {
  if (typeof input !== 'string') throw new ValidationError('URL must be text.');
  const trimmed = input.trim();
  if (!trimmed) throw new ValidationError('Enter a URL to download.');
  if (trimmed.length > MAX_URL_LENGTH) throw new ValidationError('URL is too long.');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ValidationError(`"${truncate(trimmed, 80)}" is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError(`Unsupported protocol "${url.protocol.replace(/:$/, '')}". Only http and https URLs can be downloaded.`);
  }
  if (!url.hostname) throw new ValidationError('URL has no host name.');
  return url;
}

/**
 * Links to video sites are web pages with a player, not video files. Downloading one as a plain file
 * would save the page's HTML, so they must go through the quality picker (yt-dlp) instead.
 */
export function isMediaPage(url: URL): boolean {
  return mediaSiteOf(url) !== null;
}

/** Streaming services with copy protection: refused up front, with the reason. */
export function refuseDrm(url: URL): void {
  const site = drmSiteOf(url);
  if (site) throw new ValidationError(`${site} protects its videos with DRM. Getting around copy protection is not allowed, so Haul cannot download from it.`);
}

/**
 * Returns a version of the URL that is safe to write to logs: credentials removed,
 * query string values and fragment hidden (signed URLs often carry tokens there).
 */
export function redactUrl(input: string | URL | null | undefined): string {
  if (!input) return '';
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : new URL(input.href);
  } catch {
    return '[invalid url]';
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  if (url.search) {
    const keys = [...new Set([...url.searchParams.keys()])];
    url.search = '';
    return `${url.href}?${keys.map((k) => `${encodeURIComponent(k)}=***`).join('&')}`;
  }
  return url.href;
}

/** Removes any URLs' query strings / credentials found in free text (e.g. error messages). */
export function redactText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (m) => redactUrl(m));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export const PROTOCOL_SCHEME = 'haul';

/** What the browser extension asks for: a link, and for captured downloads the browser's name for it and its page. */
export interface BrowserAddRequest {
  url: string;
  fileName: string | null;
  referrer: string | null;
  /** True when the browser's own download was intercepted: add it at once instead of asking first. */
  auto: boolean;
}

/**
 * Finds `haul://add?url=<encoded http(s) URL>[&name=…&referrer=…&auto=1]` arguments (from the browser
 * extension) and returns the validated requests. Anything malformed or non-http(s) is ignored.
 */
export function extractProtocolRequests(argv: string[]): BrowserAddRequest[] {
  const out: BrowserAddRequest[] = [];
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.toLowerCase().startsWith(`${PROTOCOL_SCHEME}://`)) continue;
    try {
      const u = new URL(arg);
      const target = u.searchParams.get('url');
      if (u.hostname !== 'add' || !target) continue;
      const name = (u.searchParams.get('name') ?? '').trim().slice(0, 255);
      let referrer: string | null = null;
      try {
        const r = new URL(u.searchParams.get('referrer') ?? '');
        if (r.protocol === 'http:' || r.protocol === 'https:') referrer = r.href;
      } catch {
        /* no referrer */
      }
      out.push({ url: validateDownloadUrl(target).href, fileName: name || null, referrer, auto: u.searchParams.get('auto') === '1' });
    } catch {
      /* ignore malformed requests */
    }
  }
  return out;
}

/** The download URLs of `haul://add` arguments (the context-menu form of the request). */
export function extractProtocolUrls(argv: string[]): string[] {
  return extractProtocolRequests(argv).map((r) => r.url);
}

/** The `haul://add` form of a request, as the native messaging host hands it to a running Haul. */
export function buildProtocolUrl(req: BrowserAddRequest): string {
  const u = new URL(`${PROTOCOL_SCHEME}://add`);
  u.searchParams.set('url', req.url);
  if (req.fileName) u.searchParams.set('name', req.fileName);
  if (req.referrer) u.searchParams.set('referrer', req.referrer);
  if (req.auto) u.searchParams.set('auto', '1');
  return u.href;
}
