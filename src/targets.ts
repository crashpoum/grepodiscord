/**
 * Soft-target radar and quit prediction (pure). Inputs are only public data: the official hourly world
 * files (players, towns, conquers, kills), our own activity tracking and our own daily history snapshots.
 * Scores are heuristics (0–100), not certainties; every score carries the reasons and a confidence.
 */
import type { DailyRow, DailySet } from './db.js';
import type { Player, Town } from './data/parse.js';
import type { WorldSnapshot } from './data/snapshot.js';
import { townOcean } from './data/snapshot.js';
import type { Activity } from './diff.js';
import { TownGrid } from './war.js';

const DAY = 86_400;
const clamp = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/** World-local calendar day (YYYY-MM-DD) for an epoch-second instant. */
export function dayIn(tz: string, sec: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(sec * 1000));
}
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const shiftDay = (day: string, delta: number) => new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);

/** Rows for player_daily / alliance_daily from a snapshot. */
export function dailyRows(snap: WorldSnapshot): { players: DailyRow[]; alliances: DailyRow[] } {
  const players = [...snap.players.values()].map((p) => ({ id: p.id, allianceId: p.allianceId, points: p.points, abp: snap.playerAbp.get(p.id) ?? 0, dbp: snap.playerDbp.get(p.id) ?? 0, towns: p.towns }));
  const alliances = [...snap.alliances.values()].map((a) => ({ id: a.id, allianceId: a.id, points: a.points, abp: snap.allianceAbp.get(a.id) ?? 0, dbp: snap.allianceDbp.get(a.id) ?? 0, towns: a.towns, members: a.members }));
  return { players, alliances };
}

// ---------------------------------------------------------------- quit prediction
export type QuitSignal = 'idle' | 'points' | 'bp' | 'towns' | 'alliance';
export interface QuitScore {
  playerId: number; score: number; confidence: number;
  /** Signal → strength 0..1 (only signals we could measure). */
  signals: Partial<Record<QuitSignal, number>>;
  facts: { idleHours?: number; trackedHours?: number; pointsDelta?: number; pointsPct?: number; bpDelta?: number; lost7: number; gained7: number; spanDays: number };
}
export const QUIT_WEIGHTS: Record<QuitSignal, number> = { idle: 0.35, points: 0.25, bp: 0.15, towns: 0.15, alliance: 0.1 };

export interface QuitInputs { snap: WorldSnapshot; activity: Map<number, Activity>; old: DailySet | null; today: string; now: number; conquest7?: Map<number, { lost: number; gained: number }> }

/** Towns lost / gained per player in the last 7 days, from the official conquers file. */
export function conquestCounts(snap: WorldSnapshot, now: number, days = 7): Map<number, { lost: number; gained: number }> {
  const m = new Map<number, { lost: number; gained: number }>();
  const get = (id: number) => { let x = m.get(id); if (!x) { x = { lost: 0, gained: 0 }; m.set(id, x); } return x; };
  for (const c of snap.conquers) {
    if (c.time < now - days * DAY) continue;
    if (c.oldPlayerId && c.oldPlayerId !== c.newPlayerId) get(c.oldPlayerId).lost++;
    if (c.newPlayerId && c.oldPlayerId !== c.newPlayerId) get(c.newPlayerId).gained++;
  }
  return m;
}

export function quitScore(p: Player, x: QuitInputs): QuitScore {
  const signals: Partial<Record<QuitSignal, number>> = {};
  const abp = x.snap.playerAbp.get(p.id) ?? 0;
  const dbp = x.snap.playerDbp.get(p.id) ?? 0;
  const cc = (x.conquest7 ?? conquestCounts(x.snap, x.now)).get(p.id) ?? { lost: 0, gained: 0 };
  const facts: QuitScore['facts'] = { lost7: cc.lost, gained7: cc.gained, spanDays: 0 };

  // 1. Idle: no change in points/ABP/DBP/towns. 0 h → 0, 72 h+ → 1. Needs ≥ 6 h of tracking.
  const a = x.activity.get(p.id);
  if (a) {
    facts.trackedHours = Math.floor((x.now - a.firstSeenAt) / 3600);
    facts.idleHours = Math.floor((x.now - a.lastChangeAt) / 3600);
    if (facts.trackedHours >= 6) signals.idle = clamp(facts.idleHours / 72);
  }
  // 2/3. Trends vs the stored day closest to a week ago (needs ≥ 1 full day of history).
  const o = x.old?.rows.get(p.id);
  const span = x.old ? daysBetween(x.old.day, x.today) : 0;
  if (o && span >= 1) {
    facts.spanDays = span;
    facts.pointsDelta = p.points - o.points;
    facts.pointsPct = o.points > 0 ? (p.points - o.points) / o.points : 0;
    const perDay = facts.pointsPct / span;
    signals.points = facts.pointsDelta < 0 ? 1 : clamp(1 - perDay / 0.005); // ≥ 0.5 %/day growth = healthy
    facts.bpDelta = Math.max(0, abp - o.abp) + Math.max(0, dbp - o.dbp);
    const expected = Math.max(200, p.points * 0.01) * span; // some fighting is normal for an active player
    signals.bp = clamp(1 - facts.bpDelta / expected);
  }
  // 4. Losing towns without taking any.
  if (cc.lost > 0) signals.towns = cc.gained > 0 ? clamp(0.5 * (cc.lost - cc.gained) / (cc.lost + p.towns)) : clamp(0.5 + cc.lost / (cc.lost + Math.max(1, p.towns)));
  else signals.towns = 0;
  // 5. No alliance (left or never joined).
  signals.alliance = p.allianceId === null ? 1 : 0;

  let w = 0;
  let sum = 0;
  for (const [k, v] of Object.entries(signals) as [QuitSignal, number][]) { w += QUIT_WEIGHTS[k]; sum += QUIT_WEIGHTS[k] * v; }
  return { playerId: p.id, score: w ? Math.round((sum / w) * 100) : 0, confidence: Math.round(w * 100), signals, facts };
}

export interface QuitFilter { allianceIds?: number[]; excludeAllianceIds?: number[]; minPoints?: number; limit?: number }
export function rankQuitters(x: QuitInputs, f: QuitFilter = {}): QuitScore[] {
  const cc = x.conquest7 ?? conquestCounts(x.snap, x.now);
  const out: QuitScore[] = [];
  for (const p of x.snap.players.values()) {
    if (f.minPoints && p.points < f.minPoints) continue;
    if (f.allianceIds?.length && (p.allianceId === null || !f.allianceIds.includes(p.allianceId))) continue;
    if (p.allianceId !== null && f.excludeAllianceIds?.includes(p.allianceId)) continue;
    if (p.towns === 0) continue;
    out.push(quitScore(p, { ...x, conquest7: cc }));
  }
  out.sort((a, b) => b.score - a.score || b.confidence - a.confidence);
  return out.slice(0, f.limit ?? 15);
}

// ---------------------------------------------------------------- soft targets
export type SoftReason = 'ghost' | 'idle' | 'stagnant' | 'lowDef' | 'noDefGrowth' | 'isolated' | 'noAlliance' | 'smallTown' | 'justConquered' | 'shrinking';
export interface SoftTarget {
  town: Town; player: Player | null; score: number; quit: number | null;
  /** Distance to the nearest reference town (ours) and that town. */
  dist: number; from: Town | null; reasons: SoftReason[]; idleHours?: number; pointsPct?: number;
}
export interface SoftOptions {
  /** Reference towns ("our" towns): distance is measured from the nearest of these. */
  refs: Town[]; radius: number;
  excludeAllianceIds: number[]; excludePlayerIds?: number[];
  oceans?: number[]; minPoints?: number; maxPoints?: number; includeGhosts?: boolean; limit?: number;
}
export const SOFT_WEIGHTS = { quit: 0.3, lowDef: 0.15, defGrowth: 0.15, isolation: 0.2, smallTown: 0.1, justConquered: 0.1 };

export function softTargets(x: QuitInputs, o: SoftOptions): SoftTarget[] {
  if (!o.refs.length) return [];
  const refGrid = new TownGrid(o.refs);
  const allGrid = new TownGrid(x.snap.towns.values());
  const cc = conquestCounts(x.snap, x.now);
  const lastConquest = new Map<number, number>();
  for (const c of x.snap.conquers) if (c.time >= x.now - 3 * DAY && (lastConquest.get(c.townId) ?? 0) < c.time) lastConquest.set(c.townId, c.time);
  const quitCache = new Map<number, QuitScore>();
  const exclP = new Set(o.excludePlayerIds ?? []);
  const out: SoftTarget[] = [];
  for (const town of x.snap.towns.values()) {
    if (o.oceans?.length && !o.oceans.includes(townOcean(town))) continue;
    const near = refGrid.nearest(town.islandX, town.islandY, o.radius);
    if (!near) continue;
    if (town.playerId === null) {
      if (o.includeGhosts === false) continue;
      out.push({ town, player: null, score: Math.round(80 + 15 * clamp(1 - town.points / 12_000)), quit: null, dist: near.dist, from: near.town, reasons: ['ghost'] });
      continue;
    }
    const p = x.snap.players.get(town.playerId);
    if (!p || exclP.has(p.id)) continue;
    if (p.allianceId !== null && o.excludeAllianceIds.includes(p.allianceId)) continue;
    if (o.minPoints && p.points < o.minPoints) continue;
    if (o.maxPoints && p.points > o.maxPoints) continue;
    let q = quitCache.get(p.id);
    if (!q) { q = quitScore(p, { ...x, conquest7: cc }); quitCache.set(p.id, q); }
    const reasons: SoftReason[] = [];
    const parts: [number, number][] = [[SOFT_WEIGHTS.quit, q.score / 100]];
    if ((q.signals.idle ?? 0) >= 0.5) reasons.push('idle');
    if ((q.signals.points ?? 0) >= 0.8) reasons.push('stagnant');
    if ((q.signals.towns ?? 0) >= 0.5) reasons.push('shrinking');
    // Low defensive record: DBP relative to points (active defenders often have DBP ≥ points).
    const dbp = x.snap.playerDbp.get(p.id) ?? 0;
    const lowDef = clamp(1 - dbp / Math.max(1, p.points));
    parts.push([SOFT_WEIGHTS.lowDef, lowDef]);
    if (lowDef >= 0.8) reasons.push('lowDef');
    const o7 = x.old?.rows.get(p.id);
    if (o7 && x.old && daysBetween(x.old.day, x.today) >= 1) {
      const g = clamp(1 - Math.max(0, dbp - o7.dbp) / Math.max(300, p.points * 0.03));
      parts.push([SOFT_WEIGHTS.defGrowth, g]);
      if (g >= 0.9) reasons.push('noDefGrowth');
    }
    // Isolation: no alliance, or no alliance-mate town within 20 islands.
    let iso = 1;
    if (p.allianceId === null) reasons.push('noAlliance');
    else {
      const mate = allGrid.nearest(town.islandX, town.islandY, 20, (t) => t.playerId !== null && t.playerId !== p.id && x.snap.players.get(t.playerId)?.allianceId === p.allianceId);
      iso = mate ? clamp((mate.dist - 3) / 15) : 1;
      if (iso >= 0.7) reasons.push('isolated');
    }
    parts.push([SOFT_WEIGHTS.isolation, iso]);
    const small = clamp(1 - town.points / 12_000);
    parts.push([SOFT_WEIGHTS.smallTown, small]);
    if (small >= 0.6) reasons.push('smallTown');
    const jc = lastConquest.has(town.id) ? 1 : 0;
    parts.push([SOFT_WEIGHTS.justConquered, jc]);
    if (jc) reasons.push('justConquered');
    const wsum = parts.reduce((s, [w]) => s + w, 0);
    const score = Math.round((parts.reduce((s, [w, v]) => s + w * v, 0) / wsum) * 100);
    out.push({ town, player: p, score, quit: q.score, dist: near.dist, from: near.town, reasons, idleHours: q.facts.idleHours, pointsPct: q.facts.pointsPct });
  }
  out.sort((a, b) => b.score - a.score || a.dist - b.dist);
  // One line per player (their best town). Ghost towns are listed individually but capped at a third of
  // the list so they never crowd out real players (use /radar ghosts for all of them).
  const limit = o.limit ?? 15;
  const maxGhosts = Math.max(1, Math.ceil(limit / 3));
  const seen = new Set<number>();
  let ghosts = 0;
  return out.filter((s) => (s.player ? !seen.has(s.player.id) && !!seen.add(s.player.id) : ghosts++ < maxGhosts)).slice(0, limit);
}
