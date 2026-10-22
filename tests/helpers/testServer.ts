import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

/** Behaviour of one route on the controlled test server. All fields may be changed between requests. */
export interface RouteSpec {
  body?: Buffer;
  /** Honour Range requests (default true). */
  ranges?: boolean;
  etag?: string | null;
  lastModified?: string | null;
  /** Bytes per write (default 16 KiB). */
  chunkSize?: number;
  /** Delay between writes in ms, to make transfers slow enough to pause/cancel mid-body. */
  delayMs?: number;
  /** Destroy the socket after this many body bytes have been sent in a response. */
  dropAfter?: number | null;
  /** Only drop the first response (default true). */
  dropOnce?: boolean;
  /** Respond with this status and a short body instead of the file. */
  status?: number;
  /** Respond with `status` only for the first N requests, then serve normally. */
  failTimes?: number;
  headers?: Record<string, string>;
  /** Use chunked transfer encoding (no Content-Length). */
  chunked?: boolean;
  /** Redirect (302) to this location. */
  redirectTo?: string;
  /** Accept the request but never answer. */
  hang?: boolean;
  /** Broken server: answer Range requests with 206 but send the whole file from byte 0. */
  lieAboutRange?: boolean;
  /** Stop sending for `stallMs` once this many body bytes have been sent (connection stays open). */
  stallAfter?: number;
  stallMs?: number;
}

export interface LoggedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
}

export class TestServer {
  private server = http.createServer((req, res) => this.handle(req, res));
  private routes = new Map<string, RouteSpec & { served: number }>();
  private sockets = new Set<import('node:net').Socket>();
  readonly requests: LoggedRequest[] = [];
  port = 0;

  async start(): Promise<void> {
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  url(p: string): string {
    return `http://127.0.0.1:${this.port}${p}`;
  }

  route(p: string, spec: RouteSpec): RouteSpec {
    const r = { served: 0, ...spec };
    this.routes.set(p, r);
    return r;
  }

  requestsFor(p: string): LoggedRequest[] {
    return this.requests.filter((r) => r.path === p);
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathOnly = (req.url ?? '/').split('?')[0];
    this.requests.push({ path: pathOnly, headers: req.headers });
    const spec = this.routes.get(pathOnly);
    if (!spec) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    const nth = spec.served++;
    if (spec.hang) return;
    if (spec.redirectTo) {
      res.writeHead(302, { Location: spec.redirectTo }).end();
      return;
    }
    if (spec.status && (spec.failTimes === undefined || nth < spec.failTimes)) {
      res.writeHead(spec.status, { 'Content-Type': 'text/plain', ...spec.headers }).end(`status ${spec.status}`);
      return;
    }

    const body = spec.body ?? Buffer.alloc(0);
    const ranges = spec.ranges ?? true;
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', ...spec.headers };
    if (spec.etag) headers.ETag = spec.etag;
    if (spec.lastModified) headers['Last-Modified'] = spec.lastModified;
    if (ranges) headers['Accept-Ranges'] = 'bytes';

    if (spec.lieAboutRange && req.headers.range) {
      headers['Content-Range'] = `bytes 0-${body.length - 1}/${body.length}`;
      headers['Content-Length'] = String(body.length);
      res.writeHead(206, headers).end(body);
      return;
    }
    let start = 0;
    let status = 200;
    const range = req.headers.range;
    const ifRange = req.headers['if-range'];
    const ifRangeOk = !ifRange || ifRange === spec.etag || ifRange === spec.lastModified;
    if (ranges && range && ifRangeOk) {
      const m = /^bytes=(\d+)-$/.exec(range);
      if (m) {
        start = Number(m[1]);
        if (start >= body.length) {
          res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
          return;
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${body.length - 1}/${body.length}`;
      }
    }
    const slice = body.subarray(start);
    if (!spec.chunked) headers['Content-Length'] = String(slice.length);
    res.writeHead(status, headers);

    const chunkSize = spec.chunkSize ?? 16 * 1024;
    const drop = spec.dropAfter !== undefined && spec.dropAfter !== null && (!(spec.dropOnce ?? true) || nth === 0);
    let sent = 0;
    for (let off = 0; off < slice.length; off += chunkSize) {
      if (res.destroyed) return;
      let piece = slice.subarray(off, off + chunkSize);
      if (drop && sent + piece.length > spec.dropAfter!) {
        piece = piece.subarray(0, spec.dropAfter! - sent);
        if (piece.length) res.write(piece);
        await new Promise((r) => setTimeout(r, 20));
        res.socket?.destroy();
        return;
      }
      const ok = res.write(piece);
      const before = sent;
      sent += piece.length;
      if (!ok) await new Promise((r) => res.once('drain', r));
      if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
      if (spec.stallAfter !== undefined && before < spec.stallAfter && sent >= spec.stallAfter) {
        await new Promise((r) => setTimeout(r, spec.stallMs ?? 0));
      }
    }
    res.end();
  }
}

export function randomBody(size: number): Buffer {
  return randomBytes(size);
}
