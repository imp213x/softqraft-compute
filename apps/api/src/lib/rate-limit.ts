/**
 * A fixed-window rate limiter held in process memory. Compute runs as one
 * process in the C1 pilot; a second process would need a shared limiter.
 */

export interface RateLimiter {
  /** True when one more call fits in the window, and counts it. */
  take(scope: string, subject: string, max: number, windowMs: number, now: Date): boolean;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { startMs: number; count: number }>();

  take(scope: string, subject: string, max: number, windowMs: number, now: Date): boolean {
    const nowMs = now.getTime();
    if (this.windows.size > 10_000) {
      for (const [key, w] of this.windows) if (nowMs - w.startMs >= windowMs) this.windows.delete(key);
    }
    const key = `${scope}\n${subject}`;
    const current = this.windows.get(key);
    if (!current || nowMs - current.startMs >= windowMs) {
      this.windows.set(key, { startMs: nowMs, count: 1 });
      return true;
    }
    if (current.count >= max) return false;
    current.count += 1;
    return true;
  }
}
