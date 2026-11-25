/**
 * Self-editing chat posts (admin panel → Trackers): the live board (shared command counts and the next arrivals),
 * the conquest & revolt tracker (one message), the ghost-town watcher (new ghost towns near us), scheduled
 * announcements and the player activity clock counters. Everything reads data the bot already has: the live board
 * reads the shared GrepoData cache in "passive" mode (at most one poll per minute while only boards watch).
 */
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import { runtime, type BotBridge, type DiscordPayload } from '../bridge.js';
import { distance } from '../geo.js';
import { t, type Lang } from '../i18n.js';
import type { Ctx } from '../services.js';
import type { WorldSnapshot } from '../data/snapshot.js';
import type { LiveCommand, LiveView } from '../web/types.js';
import type { AdminSettings } from '../admin/settings.js';
import type { IncomingCmd } from '../web/syncFeeds.js';

const hashOf = (p: unknown) => createHash('sha1').update(JSON.stringify(p)).digest('base64url');
const lastHash = new Map<string, string>();

/** Post or edit the one message of a tracker; the message id lives in guild_settings `tracker.<name>`. */
export async function upsertTracked(ctx: Ctx, bridge: BotBridge, guildId: string, name: string, channelId: string, payload: DiscordPayload): Promise<void> {
  const key = `tracker.${name}`;
  const h = hashOf(payload);
  const prev = ctx.store.getSetting(guildId, key);
  const [pch, pmsg] = (prev ?? '').split(':');
  if (pch === channelId && pmsg) {
    if (lastHash.get(`${guildId}:${name}`) === h) return; // unchanged: no Discord call
    if (await bridge.edit(channelId, pmsg, payload).catch(() => false)) { lastHash.set(`${guildId}:${name}`, h); return; }
  }
  const id = await bridge.post(channelId, payload);
  ctx.store.setSetting(guildId, key, `${channelId}:${id}`);
  lastHash.set(`${guildId}:${name}`, h);
}

const HOSTILE = /attack|takeover|conquer|revolt|spy|siege/i;
const typeIcon = (c: LiveCommand) => (/revolt/i.test(c.type + c.strat) ? '🔥' : /takeover|conquer|siege/i.test(c.type) ? '🏳️' : /spy/i.test(c.type) ? '🕵️' : /support/i.test(c.type) ? '🛡️' : '⚔️');

/** Live board embed (pure, for tests): counts + the next incoming hostile arrivals. */
export function liveBoardPayload(v: LiveView, lang: Lang, nowSec: number, link: string | null): DiscordPayload {
  const inc = v.commands.filter((c) => c.side === 'in' && !c.deleted && !c.ret);
  const out = v.commands.filter((c) => c.side === 'out' && !c.deleted && !c.ret);
  const hostile = inc.filter((c) => HOSTILE.test(c.type) && c.arrival > nowSec).sort((a, b) => a.arrival - b.arrival);
  const lines = hostile.slice(0, 10).map((c) => `${typeIcon(c)} **${c.trg.town}** (${c.trg.player}) ← ${c.src.player || '?'}${c.src.alliance ? ` [${c.src.alliance}]` : ''} · <t:${c.arrival}:T> <t:${c.arrival}:R>`);
  const status = v.error ? `⚠️ ${v.error}` : v.updatedAt ? t(lang, 'board.updated', { t: `<t:${Math.floor(v.updatedAt / 1000)}:R>` }) : t(lang, 'board.warming');
  return {
    embeds: [{
      title: t(lang, 'board.title', { world: v.world ?? '-' }), color: hostile.length ? 0xed4245 : 0x57f287,
      description: [t(lang, 'board.counts', { inc: inc.length, out: out.length, hostile: hostile.length }), lines.length ? lines.join('\n') : t(lang, 'board.none'), `-# ${status}${v.teams.length ? ` · ${v.teams.map((x) => x.name).join(', ')}` : ''}`].join('\n\n'),
      ...(link ? { url: link } : {}),
    }],
    allowedMentions: { parse: [] },
  };
}

/** Our side for trackers: admin "own" + war-room allies + verified members' alliances; enemies = war-room enemies. */
export function trackerSides(ctx: Ctx, guildId: string, snap: WorldSnapshot, s: AdminSettings): { friendly: Set<number>; enemies: Set<number> } {
  const ws = ctx.store.getWarSides(guildId, snap.world);
  const linked = ctx.store.linksForGuild(guildId).filter((l) => l.world === snap.world).map((l) => snap.players.get(l.playerId)?.allianceId ?? 0);
  return { friendly: new Set([...s.ownAlliances, ...ws.ours, ...linked].filter((x) => x > 0)), enemies: new Set(ws.enemies) };
}

/** Conquest & revolt tracker (pure): conquests of the last 24 h that involve us or our enemies, and running revolts. */
export function conquestPayload(snap: WorldSnapshot, sides: { friendly: Set<number>; enemies: Set<number> }, revolts: { town: string; player: string; by: string; at: number }[], lang: Lang, nowSec: number): DiscordPayload {
  const watch = new Set([...sides.friendly, ...sides.enemies]);
  const recent = snap.conquers.filter((c) => c.time >= nowSec - 86400 && (!watch.size || (c.newAllianceId !== null && watch.has(c.newAllianceId)) || (c.oldAllianceId !== null && watch.has(c.oldAllianceId))))
    .sort((a, b) => b.time - a.time).slice(0, 15);
  const pn = (id: number | null) => (id ? snap.players.get(id)?.name ?? `#${id}` : t(lang, 'board.ghost'));
  const an = (id: number | null) => (id ? ` [${snap.alliances.get(id)?.name ?? id}]` : '');
  const mark = (c: (typeof recent)[0]) => (c.oldAllianceId !== null && sides.friendly.has(c.oldAllianceId) ? '🔴' : c.newAllianceId !== null && sides.friendly.has(c.newAllianceId) ? '🟢' : '⚪');
  const cl = recent.map((c) => `${mark(c)} <t:${c.time}:t> **${snap.towns.get(c.townId)?.name ?? `#${c.townId}`}**: ${pn(c.oldPlayerId)}${an(c.oldAllianceId)} → ${pn(c.newPlayerId)}${an(c.newAllianceId)}`);
  const rl = revolts.slice(0, 10).map((r) => `🔥 **${r.town}** (${r.player}) ← ${r.by} · <t:${r.at}:R>`);
  return {
    embeds: [{
      title: t(lang, 'tracker.title', { world: snap.world }), color: 0xe7b84c,
      fields: [
        { name: t(lang, 'tracker.conquests'), value: (cl.join('\n') || t(lang, 'tracker.noConquests')).slice(0, 1024) },
        { name: t(lang, 'tracker.revolts'), value: (rl.join('\n') || t(lang, 'tracker.noRevolts')).slice(0, 1024) },
      ],
      footer: { text: t(lang, 'tracker.footer') }, timestamp: new Date(nowSec * 1000).toISOString(),
    }],
    allowedMentions: { parse: [] },
  };
}

/** Running/arising revolts from the shared command cache and from members' synced incoming lists. */
function revoltsFor(ctx: Ctx, guildId: string, world: string, v: LiveView | null, nowSec: number) {
  const out: { town: string; player: string; by: string; at: number }[] = [];
  for (const c of v?.commands ?? []) if (/revolt/i.test(`${c.type} ${c.strat}`) && c.arrival > nowSec - 12 * 3600) out.push({ town: c.trg.town, player: c.trg.player, by: c.src.player || '?', at: c.arrival });
  for (const f of ctx.store.listFeeds(guildId, world, 'incoming')) {
    let items: IncomingCmd[] = [];
    try { items = JSON.parse(f.itemsJson) as IncomingCmd[]; } catch { items = []; }
    for (const c of items) if (c.type === 'revolt' && c.arrival > nowSec) out.push({ town: c.town_n, player: f.playerName, by: c.from_player ?? '?', at: c.arrival });
  }
  const seen = new Set<string>();
  return out.filter((r) => { const k = `${r.town}|${r.at}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.at - b.at);
}

/** Towns that turned into ghost towns since the previous snapshot, within `radius` islands of a friendly town. */
export function newGhosts(prev: WorldSnapshot, next: WorldSnapshot, friendly: Set<number>, radius: number): { id: number; name: string; was: string; points: number; ix: number; iy: number; dist: number | null }[] {
  const mine = [...next.towns.values()].filter((tw) => tw.playerId && friendly.has(next.players.get(tw.playerId)?.allianceId ?? -1));
  const out: { id: number; name: string; was: string; points: number; ix: number; iy: number; dist: number | null }[] = [];
  for (const tw of next.towns.values()) {
    if (tw.playerId) continue;
    const before = prev.towns.get(tw.id);
    if (!before?.playerId) continue;
    let d: number | null = null;
    for (const m of mine) { const x = distance(m.islandX, m.islandY, tw.islandX, tw.islandY); if (d === null || x < d) d = x; }
    if (mine.length && (d === null || d > radius)) continue;
    out.push({ id: tw.id, name: tw.name, was: prev.players.get(before.playerId)?.name ?? `#${before.playerId}`, points: tw.points, ix: tw.islandX, iy: tw.islandY, dist: d === null ? null : Math.round(d * 10) / 10 });
  }
  return out.sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0) || b.points - a.points);
}

// ---------------------------------------------------------------- runners (called by the scheduler)
const boardBusy = new Set<string>();
/** Every minute: live boards (passive hub read) and conquest/revolt trackers (revolts change between refreshes). */
export async function runTrackers(ctx: Ctx, now = Date.now()) {
  const bridge = runtime.bridge, admin = runtime.admin, hub = runtime.hub;
  if (!bridge || !admin) return;
  const nowSec = Math.floor(now / 1000);
  for (const g of ctx.store.allGuilds()) {
    if (!g.world || boardBusy.has(g.guildId)) continue;
    const s = admin.settings(g.guildId);
    const { board, conquests } = s.trackers;
    if (!(board.on && board.channelId) && !(conquests.on && conquests.channelId)) continue;
    boardBusy.add(g.guildId);
    try {
      const v = hub ? await hub.view(g.guildId, g.lang, true) : null;
      if (board.on && board.channelId && v) await upsertTracked(ctx, bridge, g.guildId, 'board', board.channelId, liveBoardPayload(v, g.lang, nowSec, config.publicUrl ? `${config.publicUrl}/live` : null));
      if (conquests.on && conquests.channelId) {
        const snap = await ctx.worlds.ensure(g.world);
        await upsertTracked(ctx, bridge, g.guildId, 'conquests', conquests.channelId, conquestPayload(snap, trackerSides(ctx, g.guildId, snap, s), revoltsFor(ctx, g.guildId, g.world, v, nowSec), g.lang, nowSec));
      }
    } catch (e) { log.warn(`trackers ${g.guildId}: ${(e as Error).message}`); } finally { boardBusy.delete(g.guildId); }
  }
}

/** After a world refresh: ghost-town watcher posts (one message per refresh with new ghosts near us). */
export async function runGhostWatch(ctx: Ctx, prev: WorldSnapshot | undefined, next: WorldSnapshot) {
  const bridge = runtime.bridge, admin = runtime.admin;
  if (!bridge || !admin || !prev) return;
  for (const g of ctx.store.allGuilds()) {
    if (g.world !== next.world) continue;
    const s = admin.settings(g.guildId);
    const gh = s.trackers.ghosts;
    if (!gh.on || !gh.channelId) continue;
    const list = newGhosts(prev, next, trackerSides(ctx, g.guildId, next, s).friendly, gh.radius);
    if (!list.length) continue;
    const lines = list.slice(0, 15).map((x) => `👻 **${x.name}** · ${x.points.toLocaleString('en')} ${t(g.lang, 'ghost.pts')} · (${x.ix}|${x.iy})${x.dist !== null ? ` · ${t(g.lang, 'ghost.dist', { d: x.dist })}` : ''} · ${t(g.lang, 'ghost.was', { p: x.was })}`);
    await bridge.post(gh.channelId, { embeds: [{ title: t(g.lang, 'ghost.title', { n: list.length, world: next.world }), description: lines.join('\n'), color: 0x8f8f8f }], allowedMentions: { parse: [] } })
      .catch((e) => log.warn(`ghost watch ${g.guildId}: ${(e as Error).message}`));
  }
}

/** Activity clock: count score changes per UTC hour (the change happened during the hour before the refresh). */
export function bumpActivityClock(ctx: Ctx, world: string, refreshedAtSec: number) {
  const changed = [...ctx.store.getActivity(world).values()].filter((a) => a.lastChangeAt === refreshedAtSec && a.firstSeenAt !== refreshedAtSec).map((a) => a.playerId);
  ctx.store.bumpPlayerHours(world, changed, new Date((refreshedAtSec - 1800) * 1000).getUTCHours());
}

/** Scheduled announcements and expired access grants (DB-only check every 30 s). */
export async function runAnnouncements(ctx: Ctx, now = Date.now()) {
  ctx.store.purgeExpiredGrants(now);
  const bridge = runtime.bridge;
  if (!bridge) return;
  for (const a of ctx.store.dueAnnouncements(now)) {
    try { const id = await bridge.post(a.channelId, { content: a.text, allowedMentions: { parse: [] } }); ctx.store.markAnnouncement(a.id, 'sent', id, null); } catch (e) { ctx.store.markAnnouncement(a.id, 'failed', null, String((e as Error).message).slice(0, 200)); }
  }
}

/** 24-hour activity bar (pure): ▁▂▃▄▅▆▇█ per hour, shifted to the guild's timezone. */
export function clockBar(hoursUtc: number[], offsetMin: number): { bar: string; peak: number[] } {
  const shift = Math.round(offsetMin / 60);
  const local = Array.from({ length: 24 }, (_, h) => hoursUtc[((h - shift) % 24 + 24) % 24] ?? 0);
  const max = Math.max(1, ...local);
  const blocks = '▁▂▃▄▅▆▇█';
  const bar = local.map((n) => (n ? blocks[Math.min(7, Math.floor((n / max) * 7.999))] : '·')).join('');
  const peak = local.map((n, h) => [n, h]).filter(([n]) => n > 0).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, h]) => h);
  return { bar, peak };
}
/** UTC offset in minutes of a time zone right now. */
export function tzOffsetMin(tz: string, at = Date.now()): number {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at));
    const g = (k: string) => Number(p.find((x) => x.type === k)?.value);
    return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - Math.floor(at / 60000) * 60000) / 60000);
  } catch { return 0; }
}
