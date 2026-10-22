import { setTimeout as delay } from 'node:timers/promises';

/**
 * Shared speed limit for every transfer: a token bucket refilled at the configured rate. Each
 * transfer asks for its chunk before writing it and waits when the bucket is empty, which pushes
 * back on the socket. The rate can be changed at any time, including to 0 (no limit).
 */
export class RateLimiter {
  private tokens = 0;
  private last: number;
  /** Chunks wait in arrival order, so one busy transfer cannot starve the others. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private bytesPerSecond = 0,
    private now: () => number = Date.now,
  ) {
    this.last = now();
  }

  get rate(): number {
    return this.bytesPerSecond;
  }

  setRate(bytesPerSecond: number): void {
    this.refill();
    this.bytesPerSecond = Math.max(0, bytesPerSecond);
    // A lowered limit must not be followed by a burst from tokens saved up under the old one.
    this.tokens = Math.min(this.tokens, this.burst());
  }

  /** Resolves once `bytes` may be transferred. Rejects with an AbortError if `signal` fires first. */
  take(bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.bytesPerSecond <= 0) return Promise.resolve();
    const mine = this.queue.then(() => this.acquire(bytes, signal));
    // The queue itself never rejects: the next waiter starts even if this one was aborted.
    this.queue = mine.catch(() => {});
    return mine;
  }

  private async acquire(bytes: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (this.bytesPerSecond <= 0) return; // limit removed while waiting
      this.refill();
      if (this.tokens >= bytes) {
        this.tokens -= bytes;
        return;
      }
      const waitMs = Math.ceil(((bytes - this.tokens) / this.bytesPerSecond) * 1000);
      // Wait in short steps so a change of the limit takes effect quickly.
      await delay(Math.min(Math.max(waitMs, 1), 250), undefined, { signal });
    }
  }

  private refill(): void {
    const t = this.now();
    const dt = Math.max(0, t - this.last) / 1000;
    this.last = t;
    if (this.bytesPerSecond > 0) this.tokens = Math.min(this.burst(), this.tokens + dt * this.bytesPerSecond);
  }

  /** Tokens saved up while idle: half a second's worth, so a transfer that stalls cannot burst for long. */
  private burst(): number {
    return Math.max(this.bytesPerSecond / 2, 64 * 1024);
  }
}
