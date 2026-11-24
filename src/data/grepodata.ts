/**
 * Client for GrepoData's public (unauthenticated) API, https://api.grepodata.com.
 * Polite by design: one shared request budget (GREPODATA_RPM, default 30/min, far below their
 * fail2ban threshold of 400/min), per-endpoint TTL caching, stale-if-error, and exponential backoff
 * with a global pause on HTTP 429/503.
 */
import { config } from '../config.js';
import { log } from '../log.js';
import { RateLimiter, TtlCache, backoffMs, sleep } from './ratelimit.js';

export interface GdPlayerInfo {
  grep_id: number; world: string; name: string; alliance_id: number; points: number; rank: number; towns: number;
  att: number; def: number; att_rank?: number; def_rank?: number; fight_rank?: number; rank_max?: number; towns_max?: number;
  hours_inactive?: number; is_ghost?: boolean; alliance_name?: string;
}
export interface GdPlayerHistory { date: string; points: number; rank: number; att: number; def: number; towns: number; alliance_id?: number; alliance_name?: string }
export interface GdAllianceInfo { grep_id: number; world: string; name: string; members: number; points: number; rank: number; towns: number; att: number; def: number }
export interface GdAllianceHistory { date: string; points: number; rank: number; att: number; def: number; towns: number; members: number }
export interface GdWorld { id: string; val: string; name: string }
export interface GdServer { server: string; timezone: string; worlds: GdWorld[] }

const MIN = 60_000;
const TTL = { info: 10 * MIN, history: 60 * MIN, worlds: 6 * 60 * MIN } as const;

export class GrepoDataError extends Error {
  constructor(msg: string, public status?: number) { super(msg); }
}

export class GrepoDataClient {
  private limiter: RateLimiter;
  private cache = new TtlCache<unknown>(3000);
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private base = config.grepodataBase, rpm = config.grepodataRpm, private fetchImpl: typeof fetch = fetch, private sleepImpl: (ms: number) => Promise<void> = sleep) {
    this.limiter = new RateLimiter(Math.max(1, rpm), 60_000, Date.now, sleepImpl);
  }

  private async getJson<T>(path: string, params: Record<string, string | number>, ttlMs: number): Promise<T> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const url = `${this.base}${path}?${qs}`;
    const cached = this.cache.get(url);
    if (cached !== undefined) return cached as T;
    const running = this.inflight.get(url);
    if (running) return running as Promise<T>;
    const p = this.fetchWithRetry<T>(url)
      .then((v) => { this.cache.set(url, v, ttlMs); return v; })
      .catch((e) => {
        const stale = this.cache.getStale(url);
        if (stale !== undefined) { log.warn(`GrepoData failed, serving stale ${path}: ${e}`); return stale as T; }
        throw e;
      })
      .finally(() => this.inflight.delete(url));
    this.inflight.set(url, p);
    return p;
  }

  private async fetchWithRetry<T>(url: string, maxAttempts = 4): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.limiter.acquire();
      try {
        const res = await this.fetchImpl(url, { headers: { 'User-Agent': config.userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
        if (res.status === 429 || res.status === 503) {
          const ra = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoffMs(attempt + 2);
          this.limiter.pause(wait); // global pause: back off for everyone
          lastErr = new GrepoDataError(`HTTP ${res.status}`, res.status);
          continue;
        }
        if (res.status === 404 || res.status === 400) throw new GrepoDataError(`not found (${res.status})`, res.status);
        if (!res.ok) { lastErr = new GrepoDataError(`HTTP ${res.status}`, res.status); await this.sleepImpl(backoffMs(attempt)); continue; }
        return (await res.json()) as T;
      } catch (e) {
        if (e instanceof GrepoDataError && (e.status === 404 || e.status === 400)) throw e;
        lastErr = e;
        await this.sleepImpl(backoffMs(attempt));
      }
    }
    throw lastErr instanceof Error ? lastErr : new GrepoDataError(String(lastErr));
  }

  async activeWorlds(markets: string[]): Promise<GdServer[]> {
    const all = await this.getJson<GdServer[]>('/world/active', {}, TTL.worlds);
    return all.filter((s) => markets.includes(s.server));
  }
  playerInfo(world: string, id: number) { return this.getJson<GdPlayerInfo>('/player/info', { world, id }, TTL.info); }
  /** Daily history, newest first (~last 60-90 days). */
  playerHistory(world: string, id: number) { return this.getJson<GdPlayerHistory[]>('/player/history', { world, id }, TTL.history); }
  allianceInfo(world: string, id: number) { return this.getJson<GdAllianceInfo>('/alliance/info', { world, id }, TTL.info); }
  allianceHistory(world: string, id: number) { return this.getJson<GdAllianceHistory[]>('/alliance/history', { world, id }, TTL.history); }
}
