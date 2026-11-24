/**
 * Use-cases for the GrepoData-backed features, shared by the bot and the CLI.
 * Every call goes through GrepoDataClient (one shared 30 req/min budget + per-endpoint TTL caches).
 * Names typed by users are resolved against the official world snapshot first (no API calls).
 */
import type { APIEmbed } from 'discord.js';
import { GrepoDataError, type ConquestFilter, type GdRadarTown } from './data/grepodata.js';
import {
  browseIntelEmbed, changesEmbed, conquestHistoryEmbed, hourEmbed, radarRows, rankingEmbed, scoreboardEmbed, townInfoEmbed, townIntelEmbed,
  townRadarEmbed, townSearchEmbed, warsEmbed, type RankSort, type TopKind,
} from './gdViews.js';
import { ALERT, intelAccess, renewToken } from './gdAuth.js';
import { t, type Lang } from './i18n.js';
import { log } from './log.js';
import { resolveAlliance, resolvePlayer, resolveTown, type Ctx } from './services.js';
import { localDateHour, worldTz } from './time.js';

const PAGE = 15;
/** A user-facing failure: an i18n key + vars (the caller decides ephemeral/colour). */
export class UserError extends Error {
  constructor(public key: Parameters<typeof t>[1], public vars: Record<string, string | number> = {}) { super(key); }
}
const gdFail = (e: unknown): never => {
  if (e instanceof UserError) throw e;
  log.warn(`GrepoData call failed: ${e instanceof Error ? e.message : e}`);
  throw new UserError('gd.unavailable');
};
const pageFrom = (page?: number | null) => Math.max(0, ((page ?? 1) - 1) * PAGE);

export async function topScoreboard(ctx: Ctx, world: string, kind: TopKind, yesterday: boolean, lang: Lang): Promise<APIEmbed> {
  const sb = await (kind === 'player' ? ctx.gd.playerScoreboard(world, yesterday) : ctx.gd.allianceScoreboard(world, yesterday)).catch(gdFail);
  return scoreboardEmbed(lang, world, kind, sb, yesterday);
}

/** Which (date, hour) to ask for: explicit hour = its latest past occurrence; default = last full hour. World-local. */
export function pickHour(tz: string, hour: number | undefined, now = Date.now()): { date: string; hour: number } {
  const cur = localDateHour(tz, now);
  if (hour === undefined) return localDateHour(tz, now - 3_600_000);
  return hour < cur.hour ? { date: cur.date, hour } : { date: localDateHour(tz, now - 86_400_000).date, hour };
}

export async function topHour(ctx: Ctx, world: string, hour: number | undefined, lang: Lang, now = Date.now()): Promise<APIEmbed> {
  const p = pickHour(worldTz(world), hour, now);
  try {
    const d = await ctx.gd.hourDiffs(world, p.date, p.hour);
    return hourEmbed(lang, world, p.date, p.hour, d);
  } catch (e) {
    if (e instanceof GrepoDataError && (e.status === 404 || e.status === 400)) throw new UserError('top.hour.notYet');
    return gdFail(e);
  }
}

export async function topRanking(ctx: Ctx, world: string, kind: TopKind, sort: RankSort, page: number | undefined, lang: Lang): Promise<APIEmbed> {
  const s: RankSort = kind === 'player' && sort === 'Members' ? 'Points' : sort;
  const from = pageFrom(page);
  const r = await ctx.gd.ranking(world, kind, s, from, PAGE).catch(gdFail);
  return rankingEmbed(lang, world, kind, s, r, from);
}

async function snapAlliance(ctx: Ctx, world: string, q: string) {
  const a = resolveAlliance(await ctx.worlds.ensure(world), q);
  if (!a) throw new UserError('err.notFound', { q, world });
  return a;
}
async function snapPlayer(ctx: Ctx, world: string, q: string) {
  const p = resolvePlayer(await ctx.worlds.ensure(world), q);
  if (!p) throw new UserError('err.notFound', { q, world });
  return p;
}
async function snapTown(ctx: Ctx, world: string, q: string) {
  const x = resolveTown(await ctx.worlds.ensure(world), q);
  if (!x) throw new UserError('err.notFound', { q, world });
  return x;
}

export async function wars(ctx: Ctx, world: string, allianceQ: string, lang: Lang): Promise<APIEmbed> {
  const a = await snapAlliance(ctx, world, allianceQ);
  const r = await ctx.gd.allianceWars(world, a.id).catch(gdFail);
  return warsEmbed(lang, world, a, r.data ?? []);
}

export async function changes(ctx: Ctx, world: string, scope: 'alliance' | 'player' | 'world', q: string | null, page: number | undefined, lang: Lang): Promise<APIEmbed> {
  const from = pageFrom(page);
  if (scope === 'world') return changesEmbed(lang, world, 'world', world, await ctx.gd.worldChanges(world, from, PAGE).catch(gdFail), from);
  if (scope === 'alliance') {
    const a = await snapAlliance(ctx, world, q ?? '');
    return changesEmbed(lang, world, 'alliance', a.name, await ctx.gd.allianceChanges(world, a.id, from, PAGE).catch(gdFail), from);
  }
  const p = await snapPlayer(ctx, world, q ?? '');
  return changesEmbed(lang, world, 'player', p.name, await ctx.gd.playerChanges(world, p.id, from, PAGE).catch(gdFail), from);
}

export async function conquestHistory(ctx: Ctx, world: string, scope: 'player' | 'alliance' | 'town', q: string, filter: ConquestFilter, page: number | undefined, lang: Lang): Promise<APIEmbed> {
  const subj = scope === 'player' ? await snapPlayer(ctx, world, q) : scope === 'alliance' ? await snapAlliance(ctx, world, q) : await snapTown(ctx, world, q);
  const from = pageFrom(page);
  const r = await ctx.gd.conquests(world, scope, subj.id, filter, from, PAGE).catch(gdFail);
  return conquestHistoryEmbed(lang, world, scope, subj.name, { count: r.count ?? 0, conq: r.conq ?? [] }, from);
}

export async function townSearch(ctx: Ctx, world: string, query: string, lang: Lang): Promise<APIEmbed> {
  const r = await ctx.gd.townSearch(world, query, PAGE).catch(gdFail);
  return townSearchEmbed(lang, world, query, (r.results ?? []).filter((h) => !h.world || h.world === world));
}

export async function townInfo(ctx: Ctx, world: string, q: string, lang: Lang): Promise<APIEmbed> {
  const snap = await ctx.worlds.ensure(world);
  const x = await snapTown(ctx, world, q);
  try {
    return townInfoEmbed(lang, world, await ctx.gd.townInfo(world, x.id));
  } catch (e) {
    log.warn(`gd town ${world}/${x.id}: ${e}`);
    const p = x.playerId != null ? snap.players.get(x.playerId) : undefined;
    const a = p?.allianceId != null ? snap.alliances.get(p.allianceId) : undefined;
    return townInfoEmbed(lang, world, { grep_id: x.id, name: x.name, points: x.points, player_id: p?.id ?? 0, player_name: p?.name ?? '', alliance_id: a?.id ?? 0, alliance_name: a?.name ?? '', ix: x.islandX, iy: x.islandY, ocean: NaN, island_i: 0 });
  }
}

/** Absolute map units per island-grid unit, as used by GrepoData's radar margin (abs_x ≈ 128·x). */
export const ABS_PER_ISLAND = 128;

export interface TownRadarArgs { town?: string | null; x?: number | null; y?: number | null; radius?: number | null; ghostsOnly?: boolean | null }
export async function townRadar(ctx: Ctx, world: string, a: TownRadarArgs, lang: Lang): Promise<APIEmbed> {
  const snap = await ctx.worlds.ensure(world);
  const radius = Math.min(Math.max(a.radius ?? 15, 1), 150);
  let center: { id: number; name: string; x: number; y: number };
  let anchorExtra = 0;
  if (a.town) {
    const x = await snapTown(ctx, world, a.town);
    center = { id: x.id, name: x.name, x: x.islandX, y: x.islandY };
  } else if (a.x != null && a.y != null) {
    // GrepoData's radar is centred on a town: use the town nearest to the coordinates as the anchor.
    let best: { id: number; d: number } | null = null;
    for (const x of snap.towns.values()) { const d = Math.hypot(x.islandX - a.x, x.islandY - a.y); if (!best || d < best.d) best = { id: x.id, d }; }
    if (!best) throw new UserError('town.radar.needCenter');
    center = { id: best.id, name: "📍", x: a.x, y: a.y };
    anchorExtra = best.d;
  } else throw new UserError('town.radar.needCenter');
  let towns: GdRadarTown[];
  try {
    towns = (await ctx.gd.townRadar(world, center.id, Math.ceil((radius + anchorExtra + 1) * ABS_PER_ISLAND))).towns ?? [];
  } catch (e) {
    log.warn(`gd radar ${world}/${center.id}: ${e}; using local snapshot`);
    towns = [...snap.towns.values()].map((x) => {
      const p = x.playerId != null ? snap.players.get(x.playerId) : undefined;
      const al = p?.allianceId != null ? snap.alliances.get(p.allianceId) : undefined;
      return { id: x.id, name: x.name, points: x.points, player_id: p?.id ?? null, player_name: p?.name ?? '', alliance_id: al?.id ?? 0, alliance_name: al?.name ?? '', x: x.islandX, y: x.islandY, tp: p ? 'town' : 'ghost_town', distance: 0 };
    });
  }
  const rows = radarRows(towns, center.x, center.y, radius, { excludeId: a.town ? center.id : undefined, ghostsOnly: !!a.ghostsOnly });
  return townRadarEmbed(lang, world, center, radius, rows);
}

// ---------------------------------------------------------------- intel (guild-scoped)
export interface IntelResult { embed: APIEmbed; ephemeral: boolean }

/**
 * Run an intel call with the token of THIS guild only. On 401 the token is renewed once if a refresh token
 * exists; otherwise intel is paused for the guild (no retries: GrepoData bans IPs that produce many 401s).
 */
async function withGuildToken<T>(ctx: Ctx, guildId: string, channelId: string, fn: (token: string) => Promise<T>): Promise<{ value: T | null; ephemeral: boolean }> {
  const row = ctx.store.getGdToken(guildId);
  const acc = intelAccess(row, channelId, Date.now());
  if (!acc.ok) throw new UserError(acc.reason === 'no-token' ? 'intel.noToken' : 'intel.expired');
  if (row && row.alertStage === ALERT.refreshFailed && row.lastError === 'HTTP 401') throw new UserError('intel.rejected');
  try {
    return { value: await fn(acc.token), ephemeral: acc.ephemeral };
  } catch (e) {
    if (!(e instanceof GrepoDataError)) return gdFail(e);
    if (e.status === 404) return { value: null, ephemeral: acc.ephemeral };
    if (e.status === 401 || e.status === 403) {
      if (row?.refreshToken && (await renewToken(ctx.store, ctx.gd, row, 'refresh')) === 'refreshed') {
        const fresh = ctx.store.getGdToken(guildId)!;
        try { return { value: await fn(fresh.accessToken), ephemeral: acc.ephemeral }; } catch (e2) {
          if (e2 instanceof GrepoDataError && e2.status === 404) return { value: null, ephemeral: acc.ephemeral };
        }
      }
      ctx.store.setGdAlert(guildId, ALERT.refreshFailed, 'HTTP 401');
      throw new UserError('intel.rejected');
    }
    return gdFail(e);
  }
}

export async function intelTown(ctx: Ctx, guildId: string, channelId: string, world: string, q: string, lang: Lang): Promise<IntelResult> {
  const x = await snapTown(ctx, world, q);
  const r = await withGuildToken(ctx, guildId, channelId, (tok) => ctx.gd.intelTown(tok, guildId, world, x.id));
  if (!r.value) return { embed: { description: t(lang, 'intel.notFound', { name: x.name }), color: 0x6c3483 }, ephemeral: r.ephemeral };
  return { embed: townIntelEmbed(lang, world, x.id, { ...r.value, name: r.value.name || x.name }), ephemeral: r.ephemeral };
}

export async function intelBrowse(ctx: Ctx, guildId: string, channelId: string, world: string, scope: 'player' | 'alliance', q: string, lang: Lang): Promise<IntelResult> {
  const subj = scope === 'player' ? await snapPlayer(ctx, world, q) : await snapAlliance(ctx, world, q);
  const r = await withGuildToken(ctx, guildId, channelId, (tok) => (scope === 'player' ? ctx.gd.intelPlayer(tok, guildId, world, subj.id) : ctx.gd.intelAlliance(tok, guildId, world, subj.id)));
  if (!r.value) return { embed: { description: t(lang, 'intel.notFound', { name: subj.name }), color: 0x6c3483 }, ephemeral: r.ephemeral };
  return { embed: browseIntelEmbed(lang, world, scope, subj, r.value), ephemeral: r.ephemeral };
}

