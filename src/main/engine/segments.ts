// Splitting a file into parts for several connections. Pure functions: shared by the engine and tests.
import type { Segment } from '../../shared/types';

/** Parts smaller than this are not worth a connection of their own. */
export const MIN_SEGMENT_BYTES = 1024 * 1024;

/**
 * Plans the parts of a file: `[0, prefix)` is already on disk (downloaded front to back by one
 * connection earlier), the rest is cut into up to `connections` equal parts of at least `minSize`.
 */
export function planSegments(prefix: number, total: number, connections: number, minSize = MIN_SEGMENT_BYTES): Segment[] {
  const out: Segment[] = [];
  if (prefix > 0) out.push({ start: 0, end: Math.min(prefix, total), done: Math.min(prefix, total) });
  const remaining = total - prefix;
  if (remaining <= 0) return out;
  const parts = Math.max(1, Math.min(connections, Math.floor(remaining / minSize)));
  const size = Math.ceil(remaining / parts);
  for (let start = prefix; start < total; start += size) out.push({ start, end: Math.min(start + size, total), done: 0 });
  return out;
}

/** Bytes safely on disk across all parts. */
export function sumDone(segments: Segment[]): number {
  let n = 0;
  for (const s of segments) n += s.done;
  return n;
}

/** Length of the complete run of bytes from the start of the file (what one connection could continue from). */
export function contiguousPrefix(segments: Segment[]): number {
  let at = 0;
  for (const s of sorted(segments)) {
    if (s.start !== at) break;
    at = s.start + s.done;
    if (s.done < s.end - s.start) break;
  }
  return at;
}

export function sorted(segments: Segment[]): Segment[] {
  return [...segments].sort((a, b) => a.start - b.start);
}

export function allDone(segments: Segment[]): boolean {
  return segments.every((s) => s.done >= s.end - s.start);
}

/**
 * Checks parts loaded from the database against the file they describe: in order, without gaps or
 * overlaps, covering exactly `[0, total)`. Anything else means the record and file no longer match.
 */
export function validSegments(segments: Segment[], total: number): boolean {
  let at = 0;
  for (const s of sorted(segments)) {
    if (s.start !== at || s.end <= s.start || s.done > s.end - s.start) return false;
    at = s.end;
  }
  return at === total;
}
