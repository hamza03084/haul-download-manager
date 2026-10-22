import * as path from 'node:path';

const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const MAX_NAME_LENGTH = 180; // leaves room for directory + " (n)" + ".haulpart" within MAX_PATH-ish limits
export const PARTIAL_SUFFIX = '.haulpart';

/** Turns an arbitrary string into a file name that is valid on Windows. */
export function sanitizeFileName(input: string, fallback = 'download'): string {
  let name = input.normalize('NFC');
  // Strip any directory component a server might send ("../../evil.exe" or "C:\\x").
  name = name.split(/[\\/]/).pop() ?? '';
  name = name
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // Invisible direction/format marks can disguise an extension ("invoice[U+202E]fdp.exe" displays
    // as "invoiceexe.pdf"), so they are removed.
    .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!name) name = fallback;

  // Device names are reserved with any extension: "NUL.txt" and "NUL.tar.gz" both mean NUL.
  if (RESERVED_NAMES.test(name.split('.')[0].trim())) name = `_${name}`;

  if (name.length > MAX_NAME_LENGTH) {
    const e = path.extname(name).slice(0, 20);
    name = name.slice(0, MAX_NAME_LENGTH - e.length).replace(/[. ]+$/g, '') + e;
  }
  return name;
}

/**
 * Extracts the file name from a Content-Disposition header.
 * Supports RFC 6266 / RFC 5987 `filename*=UTF-8''...` (preferred) and plain `filename=`.
 */
export function parseContentDisposition(header: string | undefined | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    const charset = extended[1].trim().toLowerCase();
    const raw = extended[2].trim().replace(/^"(.*)"$/, '$1');
    try {
      if (charset === 'utf-8' || charset === '') return decodeURIComponent(raw);
      // ISO-8859-1: percent-decode bytes as latin1.
      return Buffer.from(raw.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('latin1');
    } catch {
      /* fall through to plain filename */
    }
  }
  const quoted = /filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(header);
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1');
  const plain = /filename\s*=\s*([^;]+)/i.exec(header);
  if (plain) return plain[1].trim();
  return null;
}

/** Derives a file name from the last path segment of a URL. */
export function fileNameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments.pop();
    if (!last) return null;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    return null;
  }
}

const MIME_EXTENSIONS: Record<string, string> = {
  'text/html': '.html',
  'text/plain': '.txt',
  'text/css': '.css',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-msdownload': '.exe',
  'application/x-7z-compressed': '.7z',
  'application/gzip': '.gz',
  'application/xml': '.xml',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

/** Adds an extension inferred from Content-Type when the name has none. */
export function withExtensionForMime(name: string, contentType: string | undefined | null): string {
  if (path.extname(name) || !contentType) return name;
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const ext = MIME_EXTENSIONS[mime];
  return ext ? name + ext : name;
}

/**
 * Picks a non-conflicting file name in `directory`: "name.ext", "name (1).ext", ...
 * `isTaken` receives a full path and must report whether it is in use (on disk or reserved).
 */
export function uniqueFileName(directory: string, name: string, isTaken: (fullPath: string) => boolean): string {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 0; n < 10000; n++) {
    const candidate = n === 0 ? name : `${stem} (${n})${ext}`;
    if (!isTaken(path.join(directory, candidate))) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}
