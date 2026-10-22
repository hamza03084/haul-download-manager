// Deterministic stream contents shared by the fake yt-dlp and the tests that check its output.

/** Bytes of stream `id` from `offset`: the same bytes no matter how a download is split or resumed. */
export function streamBytes(id: string, offset: number, length: number): Buffer {
  let seed = 0;
  for (const c of id) seed = (seed * 31 + c.charCodeAt(0)) & 0xff;
  const b = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) b[i] = ((offset + i) * 7 + seed + ((offset + i) >> 8)) & 0xff;
  return b;
}

/** What the fake produces for a download: streams joined in order (its "merge"). */
export function expectedMedia(streams: { id: string; size: number }[]): Buffer {
  return Buffer.concat(streams.map((s) => streamBytes(s.id, 0, s.size)));
}
