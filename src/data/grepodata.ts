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

export interface GdScoreEntry { i: string | number; s: number; n: string }
export interface GdScoreboard { world: string; date: string; time: string; nextUpdate?: string; att: GdScoreEntry[]; def: GdScoreEntry[]; con: GdScoreEntry[]; los: GdScoreEntry[] }
export interface GdHourDiff { id: number; name: string; alliance_id: number; alliance_name?: string; value: number; series?: { name: string; value: number }[] }
export interface GdRankRow { type: string; id: number; name: string; points: number; rank: number; towns?: number; members?: number; att?: number; def?: number; alliance_id?: number; alliance_name?: string }
export interface GdWar { alliance_id: number; alliance_name: string; towns_gained_from: number; towns_lost_to: number }
export interface GdChange {
  date: { date: string } | string; player_grep_id: number; player_name: string; player_points?: number;
  old_alliance_grep_id: number; old_alliance_name: string; new_alliance_grep_id: number; new_alliance_name: string; world?: string;
}
export interface GdConquest {
  town_id: number; time: string; n_p_id: number; o_p_id: number; n_a_id: number; o_a_id: number; points: number; type?: string;
  town_name: string; n_p_name: string; o_p_name: string; n_a_name: string; o_a_name: string;
}
export interface GdTownHit { id: number; name: string; points: number; player_id: number; player_name: string; alliance_id: number; alliance_name: string; island_x: number; island_y: number; world: string }
export interface GdRadarTown { id: number; name: string; points: number; player_id: number | null; player_name: string; alliance_id: number; alliance_name: string; x: number; y: number; tp: string; distance: number }
export interface GdTownInfo { grep_id: number; name: string; points: number; player_id: number; player_name: string; alliance_id: number; alliance_name: string; ix: number; iy: number; ocean: number; island_i: number }
export interface GdAuthTokens { access_token: string; refresh_token: string; expires_in?: number }
export interface GdIntelUnit { name: string; count: string | number; killed?: string | number }
/** One formatted intel report of a town (dates are world-local "DD-MM-YY HH:MM:SS"). */
export interface GdIntelRecord { id: number; date: string; type?: string; units?: GdIntelUnit[]; silver?: string; wall?: string | number; hero?: string; god?: string; deleted?: boolean; cost?: number }
export interface GdActiveTeams { success?: boolean; active?: number; operations?: { active?: boolean; index: string; team?: string; world: string; commands?: number; players?: number }[] }
export interface GdSharedCommand {
  es_id: string; arrival_at: number; started_at?: number; type?: string; subtype?: string;
  src_twn_id?: number; src_twn_n?: string; src_ply_id?: number; src_ply_n?: string; src_all_id?: number; src_all_n?: string;
  trg_twn_id?: number; trg_twn_n?: string; trg_ply_id?: number; trg_ply_n?: string; trg_all_id?: number; trg_all_n?: string;
  units?: Record<string, number | string> | string; upload_n?: string; own_command?: boolean; return?: boolean; delete_status?: string; cancel_human?: string; comments?: unknown[]; is_planned?: boolean;
  cmd_id?: string; arrival_human?: string; attacking_strategy?: string; upload_id?: number; team?: string; cancelable?: boolean;
}
export interface GdTeamCommands { success?: boolean; success_code?: number; count?: number; updated_at?: number; is_admin?: boolean; items?: GdSharedCommand[] }
export interface GdIndexOverview {
  success?: boolean; index_name?: string; world?: string; total_reports?: number; spy_reports?: number; enemy_attacks?: number; friendly_attacks?: number; latest_report?: string;
  latest_intel?: { town_id?: number; town_name?: string; player_id?: number; player_name?: string; alliance_id?: number; date?: string; type?: string; [k: string]: unknown }[];
  recent_conquests?: { town_id?: number; town_name?: string; [k: string]: unknown }[];
}
export interface GdTownIntel { world?: string; town_id?: number | string; name: string; ix: number; iy: number; player_id: number; player_name: string; alliance_id?: number; has_intel?: boolean; intel: GdIntelRecord[]; notes?: { message?: string; poster_name?: string; date?: string }[]; teams?: unknown[] }
/** /indexer/v2/player|alliance: categories keyed by player id (PHP assoc arrays → objects). */
export interface GdBrowseIntel { info?: { player_name?: string; player_id?: number; alliance_id?: number; alliance_name?: string }; cities?: unknown; off?: unknown; def?: unknown; myth?: unknown; fire?: unknown; bir?: unknown; trir?: unknown; teams?: unknown[]; view_is_limited?: boolean }
export type ConquestFilter = 'all' | 'friendly' | 'enemy' | 'internal';

const MIN = 60_000;
const TTL = { info: 10 * MIN, history: 60 * MIN, worlds: 6 * 60 * MIN, scoreboard: 10 * MIN, hour: 30 * MIN, ranking: 30 * MIN, wars: 60 * MIN, changes: 15 * MIN, conquests: 15 * MIN, towns: 30 * MIN, intel: 5 * MIN } as const;

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

  /**
   * GET JSON with caching. `opts.headers` are sent but NOT part of the cache key, so anything secret
   * (the access_token header) must come with a `cacheScope` (e.g. the guild id) to keep caches separate.
   */
  private async getJson<T>(path: string, params: Record<string, string | number>, ttlMs: number, opts: { headers?: Record<string, string>; cacheScope?: string } = {}): Promise<T> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const url = `${this.base}${path}?${qs}`;
    const key = opts.cacheScope ? `${opts.cacheScope}|${url}` : url;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached as T;
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const p = this.fetchWithRetry<T>(url, opts.headers)
      .then((v) => { this.cache.set(key, v, ttlMs); return v; })
      .catch((e) => {
        const stale = this.cache.getStale(key);
        if (stale !== undefined && !(e instanceof GrepoDataError && e.status !== undefined && e.status < 500 && e.status !== 429)) {
          log.warn(`GrepoData failed, serving stale ${path}: ${e}`);
          return stale as T;
        }
        throw e;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async fetchWithRetry<T>(url: string, headers: Record<string, string> = {}, maxAttempts = 4, init: RequestInit = {}): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.limiter.acquire();
      try {
        const res = await this.fetchImpl(url, { ...init, headers: { 'User-Agent': config.userAgent, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20_000) });
        if (res.status === 429 || res.status === 503) {
          const ra = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoffMs(attempt + 2);
          this.limiter.pause(wait); // global pause: back off for everyone
          lastErr = new GrepoDataError(`HTTP ${res.status}`, res.status);
          continue;
        }
        // Client errors are final: never retry (GrepoData's fail2ban counts repeated 401s).
        if (res.status >= 400 && res.status < 500) {
          let msg = '';
          try { msg = String(((await res.json()) as { message?: string }).message ?? ''); } catch { /* not json */ }
          throw new GrepoDataError(`HTTP ${res.status}${msg ? `: ${msg.slice(0, 120)}` : ''}`, res.status);
        }
        if (!res.ok) { lastErr = new GrepoDataError(`HTTP ${res.status}`, res.status); await this.sleepImpl(backoffMs(attempt)); continue; }
        return (await res.json()) as T;
      } catch (e) {
        if (e instanceof GrepoDataError && e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
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

  // ---- rankings & scoreboards (public)
  playerScoreboard(world: string, yesterday = false) { return this.getJson<GdScoreboard>('/scoreboard/player', yesterday ? { world, yesterday: 'true' } : { world }, TTL.scoreboard); }
  allianceScoreboard(world: string, yesterday = false) { return this.getJson<GdScoreboard>('/scoreboard/alliance', yesterday ? { world, yesterday: 'true' } : { world }, TTL.scoreboard); }
  /** Per-player ABP/DBP gains in one hour. date = YYYY-MM-DD, hour = 0..23 (UTC, as GrepoData). */
  hourDiffs(world: string, date: string, hour: number) { return this.getJson<{ att: GdHourDiff[]; def: GdHourDiff[] }>('/scoreboard/hourdiffs', { world, date, hour }, TTL.hour); }
  ranking(world: string, kind: 'player' | 'alliance', sortField = 'Points', from = 0, size = 20) {
    return this.getJson<{ count: number; results: GdRankRow[] }>(`/ranking/${kind}`, { world, sort_field: sortField, sort_order: sortField === 'Rank' ? 'asc' : 'desc', from, size: Math.min(size, 50) }, TTL.ranking);
  }

  // ---- wars, changes, conquests (public)
  allianceWars(world: string, id: number) { return this.getJson<{ success?: boolean; data: GdWar[] }>('/alliance/wars', { world, id }, TTL.wars); }
  allianceChanges(world: string, id: number, from = 0, size = 20) { return this.getJson<{ count: number; items: GdChange[] }>('/alliance/changes', { world, id, from, size: Math.min(size, 49) }, TTL.changes); }
  playerChanges(world: string, id: number, from = 0, size = 20) { return this.getJson<{ count: number; items: GdChange[] }>('/player/changes', { world, id, from, size: Math.min(size, 49) }, TTL.changes); }
  worldChanges(world: string, from = 0, size = 20) { return this.getJson<{ count: number; items: GdChange[] }>('/world/changes', { world, from, size: Math.min(size, 49) }, TTL.changes); }
  conquests(world: string, type: 'player' | 'alliance' | 'town', id: number, filter: ConquestFilter = 'all', from = 0, size = 15) {
    const on = (k: ConquestFilter) => (filter === 'all' || filter === k ? 'true' : 'false');
    return this.getJson<{ count: number; conq: GdConquest[] }>('/conquest', {
      type, world, id, tfriendly: on('friendly'), tenemy: on('enemy'), tinternal: on('internal'), city: '_', date: '_', new_owner: '_', old_owner: '_', from, size: Math.min(size, 50),
    }, TTL.conquests);
  }

  // ---- towns (public)
  townSearch(world: string, query: string, size = 15) { return this.getJson<{ count: number; results: GdTownHit[] }>('/town/search', { query: query.slice(0, 30), world, size }, TTL.towns); }
  /** Towns within `margin` absolute map units (~128 per island-grid unit) of a town. */
  townRadar(world: string, townId: number, margin: number) { return this.getJson<{ towns: GdRadarTown[] }>('/town/radar', { world, town_id: townId, margin: Math.max(1, Math.min(Math.round(margin), 6000)) }, TTL.towns); }
  townInfo(world: string, id: number) { return this.getJson<GdTownInfo>('/town', { world, id }, TTL.info); }

  // ---- auth (GrepoData account; NOT game credentials). Never cached, never retried on 4xx.
  private async postForm<T>(path: string, form: Record<string, string>): Promise<T> {
    return this.fetchWithRetry<T>(`${this.base}${path}`, { 'Content-Type': 'application/x-www-form-urlencoded' }, 2, { method: 'POST', body: new URLSearchParams(form).toString() });
  }
  /** Exchange a refresh token (90 days, rotating) for a new access + refresh token pair. */
  refreshTokens(refreshToken: string) { return this.postForm<GdAuthTokens>('/auth/refresh', { refresh_token: refreshToken }); }
  login(mail: string, password: string) { return this.postForm<GdAuthTokens>('/auth/login', { mail, password }); }

  // ---- City Indexer intel (requires the guild's access token). `scope` isolates caches per guild.
  intelTown(token: string, scope: string, world: string, townId: number) {
    return this.getJson<GdTownIntel>('/indexer/v2/town', { world, town_id: townId }, TTL.intel, { headers: { access_token: token }, cacheScope: scope });
  }
  intelPlayer(token: string, scope: string, world: string, playerId: number) {
    return this.getJson<GdBrowseIntel>('/indexer/v2/player', { world, player_id: playerId }, TTL.intel, { headers: { access_token: token }, cacheScope: scope });
  }
  intelAlliance(token: string, scope: string, world: string, allianceId: number) {
    return this.getJson<GdBrowseIntel>('/indexer/v2/alliance', { world, alliance_id: allianceId }, TTL.intel, { headers: { access_token: token }, cacheScope: scope });
  }
  // ---- Command share / index overview for the live window (token-scoped, short TTLs; callers keep their own budget).
  /** Teams (operations) the token's account belongs to. `index` is the team key used by commandsGet/indexOverview. */
  commandTeams(token: string, scope: string) {
    return this.getJson<GdActiveTeams>('/commands/activeteams', {}, 60_000, { headers: { access_token: token }, cacheScope: scope });
  }
  /** Shared commands of one team; with `since` (unix s) only commands changed since then (success_code 8010 = nothing new). */
  commandsGet(token: string, scope: string, team: string, since = 0) {
    return this.getJson<GdTeamCommands>('/commands/get', { team, last_get_cmd: since }, 5_000, { headers: { access_token: token }, cacheScope: scope });
  }
  /** Overview of one index (latest intel, recent conquests, totals). */
  indexOverview(token: string, scope: string, key: string) {
    return this.getJson<GdIndexOverview>('/indexer/v2/getindex', { key }, 2 * MIN, { headers: { access_token: token }, cacheScope: scope });
  }
}
