import { MEDIA_PAGE_HOSTS } from '../../shared/types';

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
 * YouTube links are web pages with a player, not video files. Downloading one as a plain file would
 * save the page's HTML, so they must go through the quality picker (yt-dlp) instead.
 */
export function isMediaPage(url: URL): boolean {
  return MEDIA_PAGE_HOSTS.test(url.hostname);
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

/**
 * Finds `haul://add?url=<encoded http(s) URL>` arguments (from the browser extension) and returns
 * the validated download URLs. Anything malformed or non-http(s) is ignored.
 */
export function extractProtocolUrls(argv: string[]): string[] {
  const out: string[] = [];
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.toLowerCase().startsWith(`${PROTOCOL_SCHEME}://`)) continue;
    try {
      const u = new URL(arg);
      const target = u.searchParams.get('url');
      if (u.hostname === 'add' && target) out.push(validateDownloadUrl(target).href);
    } catch {
      /* ignore malformed requests */
    }
  }
  return out;
}
