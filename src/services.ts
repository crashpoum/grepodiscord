/** Use-cases shared by the Discord bot and the CLI. */
import type { APIEmbed } from 'discord.js';
import type { Store } from './db.js';
import type { WorldManager } from './refresh.js';
import type { GrepoDataClient, GdPlayerInfo, GdAllianceInfo } from './data/grepodata.js';
import type { Alliance, Player, Town } from './data/parse.js';
import { searchByName, townOcean, type WorldSnapshot } from './data/snapshot.js';
import { allianceEmbed, ghostEmbed, inactiveEmbed, playerEmbed } from './embeds.js';
import { renderHistoryChart } from './charts.js';
import { findGhostTowns, findInactive, type InactiveHit } from './radar.js';
import { findCodeTown, isExpired } from './verify.js';
import { t, type Lang } from './i18n.js';
import type { PendingVerification } from './db.js';
import { log } from './log.js';

export interface Ctx { store: Store; worlds: WorldManager; gd: GrepoDataClient }
export interface CardResult { embed: APIEmbed; chart: Buffer | null }

/** Autocomplete values are "id:<n>"; free text is matched by name. */
export function resolveById<T extends { id: number; name: string }>(map: Map<number, T>, q: string): T | null {
  const m = /^id:(\d+)$/.exec(q.trim()) ?? /^(\d+)$/.exec(q.trim());
  if (m) { const hit = map.get(Number(m[1])); if (hit) return hit; }
  const lower = q.trim().toLowerCase();
  for (const v of map.values()) if (v.name.toLowerCase() === lower) return v;
  return searchByName(map.values(), q, 1)[0] ?? null;
}
export const resolvePlayer = (s: WorldSnapshot, q: string): Player | null => resolveById(s.players, q);
export const resolveAlliance = (s: WorldSnapshot, q: string): Alliance | null => resolveById(s.alliances, q);
export const resolveTown = (s: WorldSnapshot, q: string): Town | null => resolveById(s.towns, q);

export async function playerCard(ctx: Ctx, world: string, q: string, lang: Lang): Promise<CardResult | null> {
  const snap = await ctx.worlds.ensure(world);
  const p = resolvePlayer(snap, q);
  if (!p) return null;
  let gd: GdPlayerInfo | null = null;
  let chart: Buffer | null = null;
  try { gd = await ctx.gd.playerInfo(world, p.id); } catch (e) { log.warn(`gd playerInfo ${world}/${p.id}: ${e}`); }
  try {
    const hist = await ctx.gd.playerHistory(world, p.id);
    if (Array.isArray(hist) && hist.length > 1) {
      // Append the live (current-hour) value so the chart ends "now", not at yesterday's daily close.
      const live = { date: new Date().toISOString().slice(0, 10), points: gd?.points ?? p.points, towns: gd?.towns ?? p.towns, att: gd?.att ?? snap.playerAbp.get(p.id) ?? 0, def: gd?.def ?? snap.playerDbp.get(p.id) ?? 0 };
      chart = await renderHistoryChart(p.name, [live, ...hist], { labels: chartLabels(lang) });
    }
  } catch (e) { log.warn(`gd playerHistory ${world}/${p.id}: ${e}`); }
  const embed = playerEmbed(lang, world, p, snap, gd, snap.playerAbp.get(p.id) ?? 0, snap.playerDbp.get(p.id) ?? 0);
  if (!chart) embed.description = t(lang, 'player.noHistory');
  return { embed, chart };
}

export async function allianceCard(ctx: Ctx, world: string, q: string, lang: Lang): Promise<CardResult | null> {
  const snap = await ctx.worlds.ensure(world);
  const a = resolveAlliance(snap, q);
  if (!a) return null;
  let gd: GdAllianceInfo | null = null;
  let chart: Buffer | null = null;
  try { gd = await ctx.gd.allianceInfo(world, a.id); } catch (e) { log.warn(`gd allianceInfo ${world}/${a.id}: ${e}`); }
  try {
    const hist = await ctx.gd.allianceHistory(world, a.id);
    if (Array.isArray(hist) && hist.length > 1) {
      const live = { date: new Date().toISOString().slice(0, 10), points: gd?.points ?? a.points, towns: gd?.towns ?? a.towns, members: gd?.members ?? a.members, att: gd?.att ?? snap.allianceAbp.get(a.id) ?? 0, def: gd?.def ?? snap.allianceDbp.get(a.id) ?? 0 };
      chart = await renderHistoryChart(a.name, [live, ...hist], { secondary: 'members', labels: chartLabels(lang) });
    }
  } catch (e) { log.warn(`gd allianceHistory ${world}/${a.id}: ${e}`); }
  const embed = allianceEmbed(lang, world, a, gd, snap.allianceAbp.get(a.id) ?? 0, snap.allianceDbp.get(a.id) ?? 0);
  if (!chart) embed.description = t(lang, 'player.noHistory');
  return { embed, chart };
}

function chartLabels(lang: Lang) {
  return { points: t(lang, 'common.points'), towns: t(lang, 'common.towns'), abp: t(lang, 'common.abp'), dbp: t(lang, 'common.dbp'), members: t(lang, 'common.members') };
}

export interface RadarArgs { oceans?: number[]; nearTown?: string; radius?: number; hours?: number; limit?: number; minPoints?: number }

export async function radarInactive(ctx: Ctx, world: string, a: RadarArgs, lang: Lang): Promise<APIEmbed> {
  const snap = await ctx.worlds.ensure(world);
  const near = a.nearTown ? resolveTown(snap, a.nearTown) : null;
  if (a.nearTown && !near) return { description: t(lang, 'radar.badTown', { q: a.nearTown, world }) };
  const hours = a.hours ?? 48;
  const now = Math.floor(Date.now() / 1000);
  const res = findInactive(snap, ctx.store.getActivity(world), {
    hours, now, oceans: a.oceans, near: near ? { x: near.islandX, y: near.islandY } : undefined,
    radius: near ? a.radius ?? 20 : undefined, limit: a.limit ?? 15, minPoints: a.minPoints,
  });
  let hits: InactiveHit[] = res.hits;
  // Not tracked long enough ourselves -> enrich a few nearest/biggest candidates from GrepoData (cached, rate-limited).
  if (hits.length < (a.limit ?? 15) && res.candidatesUntracked.length) {
    for (const c of res.candidatesUntracked.slice(0, 10)) {
      try {
        const info = await ctx.gd.playerInfo(world, c.player.id);
        if ((info.hours_inactive ?? 0) >= hours) hits.push({ player: c.player, hoursInactive: info.hours_inactive ?? 0, town: c.town, dist: c.dist, source: 'grepodata' });
      } catch { /* ignore single failures */ }
    }
    hits = hits.sort((x, y) => (near ? (x.dist ?? 0) - (y.dist ?? 0) : y.hoursInactive - x.hoursInactive)).slice(0, a.limit ?? 15);
  }
  const note = t(lang, 'radar.inactive.tracking', { hours: res.trackedHours, need: hours }) + (hits.some((h) => h.source === 'grepodata') ? ' (* = GrepoData)' : '');
  const e = inactiveEmbed(lang, snap, hits, note);
  if (near) e.title += ` · ${near.name} (oc ${townOcean(near)})`;
  return e;
}

export async function radarGhosts(ctx: Ctx, world: string, a: RadarArgs, lang: Lang): Promise<APIEmbed> {
  const snap = await ctx.worlds.ensure(world);
  const near = a.nearTown ? resolveTown(snap, a.nearTown) : null;
  if (a.nearTown && !near) return { description: t(lang, 'radar.badTown', { q: a.nearTown, world }) };
  const hits = findGhostTowns(snap, { oceans: a.oceans, near: near ? { x: near.islandX, y: near.islandY } : undefined, radius: near ? a.radius ?? 20 : undefined, limit: a.limit ?? 15, minPoints: a.minPoints });
  const e = ghostEmbed(lang, snap, hits);
  if (near) e.title += ` · ${near.name} (oc ${townOcean(near)})`;
  return e;
}

export type VerifyOutcome = { status: 'ok'; player: Player; town: Town } | { status: 'pending' } | { status: 'expired' } | { status: 'gone' } | { status: 'taken'; player: Player };

/** Check one pending verification against the current public snapshot. Persists the link on success. */
export async function checkVerification(ctx: Ctx, p: PendingVerification, nowSec = Math.floor(Date.now() / 1000)): Promise<VerifyOutcome> {
  if (isExpired(p.createdAt, nowSec)) { ctx.store.removePending(p.guildId, p.userId); return { status: 'expired' }; }
  const snap = await ctx.worlds.ensure(p.world);
  const player = snap.players.get(p.playerId);
  if (!player) return { status: 'gone' };
  const other = ctx.store.linkForPlayer(p.guildId, p.world, p.playerId);
  if (other && other.userId !== p.userId) return { status: 'taken', player };
  const town = findCodeTown(snap, p.playerId, p.code);
  if (!town) return { status: 'pending' };
  ctx.store.setLink({ guildId: p.guildId, userId: p.userId, world: p.world, playerId: p.playerId, verifiedAt: nowSec });
  ctx.store.removePending(p.guildId, p.userId);
  return { status: 'ok', player, town };
}
