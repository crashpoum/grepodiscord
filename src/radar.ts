/** Inactive-player and ghost-town radar (pure). */
import type { Player, Town } from './data/parse.js';
import type { WorldSnapshot } from './data/snapshot.js';
import { townOcean } from './data/snapshot.js';
import type { Activity } from './diff.js';
import { distance } from './geo.js';

export interface Point { x: number; y: number }
export interface AreaFilter { oceans?: number[]; near?: Point; radius?: number }

function townInArea(t: Town, f: AreaFilter): { ok: boolean; dist?: number } {
  if (f.oceans && f.oceans.length && !f.oceans.includes(townOcean(t))) return { ok: false };
  if (f.near) {
    const d = distance(t.islandX, t.islandY, f.near.x, f.near.y);
    if (f.radius !== undefined && d > f.radius) return { ok: false };
    return { ok: true, dist: d };
  }
  return { ok: true };
}

export interface InactiveHit { player: Player; hoursInactive: number; town: Town; dist?: number; source: 'tracked' | 'grepodata' }
export interface Candidate { player: Player; town: Town; dist?: number }
export interface InactiveResult { hits: InactiveHit[]; trackedHours: number; candidatesUntracked: Candidate[] }

export interface InactiveOptions extends AreaFilter { hours: number; now: number; limit?: number; minPoints?: number; excludeAllianceIds?: number[] }

/**
 * Players with no change in points/ABP/DBP/towns for >= hours. Players we have not tracked long enough
 * are returned separately as `candidatesUntracked` (callers may enrich them from GrepoData).
 */
export function findInactive(snap: WorldSnapshot, activity: Map<number, Activity>, o: InactiveOptions): InactiveResult {
  const limit = o.limit ?? 15;
  const hits: InactiveHit[] = [];
  const untracked: Candidate[] = [];
  let oldestSeen = o.now;
  for (const a of activity.values()) if (a.firstSeenAt < oldestSeen) oldestSeen = a.firstSeenAt;
  for (const p of snap.players.values()) {
    if (o.minPoints && p.points < o.minPoints) continue;
    if (p.allianceId && o.excludeAllianceIds?.includes(p.allianceId)) continue;
    // Best town in area (closest if `near`).
    let best: { t: Town; d?: number } | null = null;
    for (const t of snap.townsByPlayer.get(p.id) ?? []) {
      const r = townInArea(t, o);
      if (!r.ok) continue;
      if (!best || (r.dist !== undefined && (best.d === undefined || r.dist < best.d))) best = { t, d: r.dist };
    }
    if (!best) continue;
    const a = activity.get(p.id);
    const trackedFor = a ? (o.now - a.firstSeenAt) / 3600 : 0;
    const idle = a ? (o.now - a.lastChangeAt) / 3600 : 0;
    if (a && idle >= o.hours) hits.push({ player: p, hoursInactive: Math.floor(idle), town: best.t, dist: best.d, source: 'tracked' });
    else if (!a || trackedFor < o.hours) untracked.push({ player: p, town: best.t, dist: best.d });
  }
  const sortFn = (x: { dist?: number; hoursInactive: number }, y: { dist?: number; hoursInactive: number }) =>
    o.near ? (x.dist ?? 0) - (y.dist ?? 0) : y.hoursInactive - x.hoursInactive;
  hits.sort(sortFn);
  untracked.sort((a, b) => (o.near ? (a.dist ?? 0) - (b.dist ?? 0) : b.player.points - a.player.points));
  return { hits: hits.slice(0, limit), trackedHours: Math.floor((o.now - oldestSeen) / 3600), candidatesUntracked: untracked };
}

export interface GhostHit { town: Town; dist?: number; ocean: number }

export function findGhostTowns(snap: WorldSnapshot, o: AreaFilter & { limit?: number; minPoints?: number }): GhostHit[] {
  const out: GhostHit[] = [];
  for (const t of snap.towns.values()) {
    if (t.playerId !== null) continue;
    if (o.minPoints && t.points < o.minPoints) continue;
    const r = townInArea(t, o);
    if (!r.ok) continue;
    out.push({ town: t, dist: r.dist, ocean: townOcean(t) });
  }
  out.sort((a, b) => (o.near ? (a.dist ?? 0) - (b.dist ?? 0) : b.town.points - a.town.points));
  return out.slice(0, o.limit ?? 15);
}
