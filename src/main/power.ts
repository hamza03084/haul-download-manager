import { EventEmitter } from 'node:events';
import type { PowerState } from '../shared/types';

export interface ShutdownOptions {
  /** How long the countdown runs once every download is finished, before the PC is shut down. */
  countdownMs?: number;
  /** Runs the actual shutdown. Resolves when Windows accepted the request; rejects with the reason otherwise. */
  execute: () => Promise<void>;
  /** True when shutting down is impossible in this build (not Windows). */
  unavailable?: boolean;
}

/**
 * "Shut down the PC when downloads finish". Armed by the user; once the queue is idle a cancellable
 * countdown starts, and when it runs out the shutdown command is executed. Disarming at any point
 * stops the countdown. No Electron imports, so this is tested under plain Node.
 *
 * Events: `changed` (PowerState) after every change; `error` (string) when the shutdown command failed.
 */
export class ShutdownWhenDone extends EventEmitter {
  private armed = false;
  private timer: NodeJS.Timeout | null = null;
  private shutdownAt: number | null = null;
  private readonly countdownMs: number;
  private readonly execute: () => Promise<void>;
  private readonly unavailable: boolean;

  constructor(opts: ShutdownOptions) {
    super();
    this.countdownMs = opts.countdownMs ?? 60_000;
    this.execute = opts.execute;
    this.unavailable = opts.unavailable ?? false;
  }

  state(): PowerState {
    return { armed: this.armed, shutdownAt: this.shutdownAt, unavailable: this.unavailable };
  }

  /** Arms or disarms. `idle` says whether the queue is already empty, which starts the countdown at once. */
  setArmed(armed: boolean, idle: boolean): PowerState {
    if (this.unavailable) armed = false;
    this.armed = armed;
    if (!armed) this.stopCountdown();
    else if (idle) this.startCountdown();
    this.emit('changed', this.state());
    return this.state();
  }

  /** Call whenever the queue changes: starts the countdown when it became idle, stops it when work resumed. */
  queueChanged(idle: boolean): void {
    if (!this.armed) return;
    if (idle && this.shutdownAt === null) {
      this.startCountdown();
      this.emit('changed', this.state());
    } else if (!idle && this.shutdownAt !== null) {
      // Something was added or resumed during the countdown: wait for it too.
      this.stopCountdown();
      this.emit('changed', this.state());
    }
  }

  private startCountdown(): void {
    this.stopCountdown();
    this.shutdownAt = Date.now() + this.countdownMs;
    this.timer = setTimeout(() => void this.fire(), this.countdownMs);
  }

  private stopCountdown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.shutdownAt = null;
  }

  private async fire(): Promise<void> {
    this.timer = null;
    if (!this.armed) return;
    try {
      await this.execute();
    } catch (e) {
      this.armed = false;
      this.shutdownAt = null;
      this.emit('changed', this.state());
      this.emit('error', (e as Error).message);
      return;
    }
    // Windows is now ending the session. Disarm so nothing fires twice if the process lives on.
    this.shutdownAt = null;
    this.armed = false;
    this.emit('changed', this.state());
  }

  dispose(): void {
    this.stopCountdown();
  }
}
