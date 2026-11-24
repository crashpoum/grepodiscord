/**
 * Personal town-threat alerts (pure). For one opted-in, verified member, find what happened near their
 * towns in the latest refresh, using only public world data: conquests, newly founded towns and
 * attack-BP spikes. No game login, no internal API, nothing is ever done in game.
 */
import type { Conquest, Town } from './data/parse.js';
import type { WorldSnapshot } from './data/snapshot.js';
import type { BpDelta } from './diff.js';
import type { ThreatScope } from './db.js';
import { TownGrid } from './war.js';
import { fmt, t, type Lang } from './i18n.js';

export interface ThreatSub { playerId: number; radius: number; minBp: number; scope: ThreatScope }
export interface ThreatEvents { conquests: Conquest[]; founded: Town[]; bp: BpDelta[] }
export type ThreatItem =
  | { kind: 'lost'; c: Conquest }
  | { kind: 'conquest'; c: Conquest; near: Town; dist: number }
  | { kind: 'founded'; town: Town; near: Town; dist: number }
  | { kind: 'attacker'; playerId: number; delta: number; town: Town; near: Town; dist: number };

/** Who counts as hostile for this member: never themselves or our side; 'enemies' = enemy list (or everyone else if empty). */
export function hostility(sub: ThreatSub, snap: WorldSnapshot, ours: number[], enemies: number[]) {
  const me = snap.players.get(sub.playerId);
  const friendly = new Set(ours);
  if (me?.allianceId) friendly.add(me.allianceId);
  const enemySet = new Set(enemies);
  return (playerId: number | null, allianceId: number | null): boolean => {
    if (playerId === null || playerId === sub.playerId) return false;
    if (allianceId !== null && friendly.has(allianceId)) return false;
    if (sub.scope === 'all' || enemySet.size === 0) return true;
    return allianceId !== null && enemySet.has(allianceId);
  };
}

export function findThreats(sub: ThreatSub, snap: WorldSnapshot, ev: ThreatEvents, ours: number[], enemies: number[]): ThreatItem[] {
  const items: ThreatItem[] = [];
  const hostile = hostility(sub, snap, ours, enemies);
  for (const c of ev.conquests) {
    if (c.oldPlayerId === sub.playerId && c.newPlayerId !== sub.playerId) items.push({ kind: 'lost', c });
  }
  const mine = snap.townsByPlayer.get(sub.playerId) ?? [];
  if (!mine.length) return items;
  const grid = new TownGrid(mine);
  for (const c of ev.conquests) {
    if (c.oldPlayerId === sub.playerId || !hostile(c.newPlayerId, c.newAllianceId)) continue;
    const x = snap.towns.get(c.townId);
    const n = x && grid.nearest(x.islandX, x.islandY, sub.radius);
    if (n) items.push({ kind: 'conquest', c, near: n.town, dist: n.dist });
  }
  for (const x of ev.founded) {
    const owner = x.playerId !== null ? snap.players.get(x.playerId) : undefined;
    if (!owner || !hostile(owner.id, owner.allianceId)) continue;
    const n = grid.nearest(x.islandX, x.islandY, sub.radius);
    if (n) items.push({ kind: 'founded', town: x, near: n.town, dist: n.dist });
  }
  for (const d of ev.bp) {
    if (d.kind !== 'att' || d.delta < sub.minBp) continue;
    const p = snap.players.get(d.id);
    if (!p || !hostile(p.id, p.allianceId)) continue;
    let best: { town: Town; near: Town; dist: number } | null = null;
    for (const x of snap.townsByPlayer.get(p.id) ?? []) {
      const n = grid.nearest(x.islandX, x.islandY, sub.radius);
      if (n && (!best || n.dist < best.dist)) best = { town: x, near: n.town, dist: n.dist };
    }
    if (best) items.push({ kind: 'attacker', playerId: p.id, delta: d.delta, ...best });
  }
  return items;
}

const md = (s: string) => s.replace(/([*_`~|\\>])/g, '\\$1');

/** One DM text (≤ 2000 chars) for a member's threats. */
export function threatMessage(items: ThreatItem[], snap: WorldSnapshot, lang: Lang, guildName: string): string {
  const pn = (id: number | null) => (id === null ? t(lang, 'feed.conquest.ghost') : md(snap.players.get(id)?.name ?? `#${id}`));
  const an = (id: number | null) => (id === null ? '-' : md(snap.alliances.get(id)?.name ?? `#${id}`));
  const tn = (id: number) => md(snap.towns.get(id)?.name ?? `#${id}`);
  const lines = items.slice(0, 12).map((it) => {
    switch (it.kind) {
      case 'lost': return `🔴 ${t(lang, 'threat.lost', { town: tn(it.c.townId), player: pn(it.c.newPlayerId), alliance: an(it.c.newAllianceId), t: `<t:${it.c.time}:R>` })}`;
      case 'conquest': return `🚨 ${t(lang, 'threat.conquest', { player: pn(it.c.newPlayerId), alliance: an(it.c.newAllianceId), town: tn(it.c.townId), near: md(it.near.name), dist: it.dist.toFixed(1), t: `<t:${it.c.time}:R>` })}`;
      case 'founded': return `🏗️ ${t(lang, 'threat.founded', { player: pn(it.town.playerId), alliance: an(snap.players.get(it.town.playerId ?? -1)?.allianceId ?? null), town: md(it.town.name), near: md(it.near.name), dist: it.dist.toFixed(1) })}`;
      default: return `⚔️ ${t(lang, 'threat.attacker', { player: pn(it.playerId), alliance: an(snap.players.get(it.playerId)?.allianceId ?? null), delta: fmt(it.delta, lang), town: md(it.town.name), near: md(it.near.name), dist: it.dist.toFixed(1) })}`;
    }
  });
  if (items.length > 12) lines.push(t(lang, 'threat.more', { n: items.length - 12 }));
  return [`**${t(lang, 'threat.title', { world: snap.world, guild: md(guildName) })}**`, ...lines, '', `-# ${t(lang, 'threat.footer')}`].join('\n').slice(0, 2000);
}
