/** Sliding-window transfer rate meter. */
export class SpeedMeter {
  private samples: { t: number; bytes: number }[] = [];

  constructor(private windowMs = 3000, private now: () => number = Date.now) {}

  reset(bytes: number): void {
    this.samples = [{ t: this.now(), bytes }];
  }

  /** Records the cumulative byte count at the current time. */
  sample(bytes: number): void {
    const t = this.now();
    const last = this.samples[this.samples.length - 1];
    if (last && t - last.t < 100) {
      last.bytes = bytes; // coalesce very frequent samples
    } else {
      this.samples.push({ t, bytes });
    }
    const cutoff = t - this.windowMs;
    while (this.samples.length > 2 && this.samples[1].t <= cutoff) this.samples.shift();
  }

  /** Bytes per second over the window; 0 if there is not enough data yet. */
  rate(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    // Include idle time since the last sample so a stalled transfer decays to 0.
    const dt = (Math.max(last.t, this.now()) - first.t) / 1000;
    if (dt < 0.3) return 0;
    return Math.max(0, (last.bytes - first.bytes) / dt);
  }
}
