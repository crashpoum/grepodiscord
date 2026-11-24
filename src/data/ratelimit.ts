/** Small async helpers: sliding-window limiter, TTL cache, backoff. */

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Allows at most `max` acquisitions per `windowMs`; callers wait in FIFO order. Supports a global pause. */
export class RateLimiter {
  private stamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  private pausedUntil = 0;
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now, private wait: (ms: number) => Promise<void> = sleep) {}

  pause(ms: number) { this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms); }

  acquire(): Promise<void> {
    const run = async () => {
      for (;;) {
        const t = this.now();
        if (t < this.pausedUntil) { await this.wait(this.pausedUntil - t); continue; }
        this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
        if (this.stamps.length < this.max) { this.stamps.push(t); return; }
        await this.wait(this.windowMs - (t - this.stamps[0]) + 5);
      }
    };
    const p = this.chain.then(run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

export class TtlCache<V> {
  private m = new Map<string, { v: V; exp: number }>();
  constructor(private maxEntries = 2000, private now: () => number = Date.now) {}
  get(k: string): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp < this.now()) return undefined;
    return e.v;
  }
  /** Returns even expired values (stale-if-error). */
  getStale(k: string): V | undefined { return this.m.get(k)?.v; }
  set(k: string, v: V, ttlMs: number) {
    if (this.m.size >= this.maxEntries) {
      const first = this.m.keys().next().value;
      if (first !== undefined) this.m.delete(first);
    }
    this.m.delete(k);
    this.m.set(k, { v, exp: this.now() + ttlMs });
  }
}

/** Exponential backoff with full jitter: attempt 0 -> ~base, capped at max. */
export function backoffMs(attempt: number, base = 1000, max = 60_000, rand = Math.random): number {
  const cap = Math.min(max, base * 2 ** attempt);
  return Math.floor(cap / 2 + rand() * (cap / 2));
}
