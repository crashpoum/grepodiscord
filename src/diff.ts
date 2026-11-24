/** Pure diff logic between two consecutive hourly snapshots. */
import type { Conquest, Player } from './data/parse.js';

export function newConquests(conquers: Conquest[], sinceTime: number): Conquest[] {
  return conquers.filter((c) => c.time > sinceTime).sort((a, b) => a.time - b.time || a.townId - b.townId);
}

export function maxConquestTime(conquers: Conquest[]): number {
  let m = 0;
  for (const c of conquers) if (c.time > m) m = c.time;
  return m;
}

export type AllianceChangeKind = 'join' | 'leave' | 'switch' | 'deleted';
export interface AllianceChange {
  kind: AllianceChangeKind;
  playerId: number;
  playerName: string;
  fromAllianceId: number | null;
  toAllianceId: number | null;
  points: number;
}

/** Players whose alliance changed between snapshots (incl. new players already in an alliance and deleted members). */
export function allianceChanges(prev: Map<number, Player>, next: Map<number, Player>): AllianceChange[] {
  const out: AllianceChange[] = [];
  for (const [id, p] of next) {
    const before = prev.get(id);
    const from = before ? before.allianceId : null;
    const to = p.allianceId;
    if (from === to) continue;
    const kind: AllianceChangeKind = from === null ? 'join' : to === null ? 'leave' : 'switch';
    out.push({ kind, playerId: id, playerName: p.name, fromAllianceId: from, toAllianceId: to, points: p.points });
  }
  for (const [id, p] of prev) {
    if (!next.has(id) && p.allianceId !== null) {
      out.push({ kind: 'deleted', playerId: id, playerName: p.name, fromAllianceId: p.allianceId, toAllianceId: null, points: p.points });
    }
  }
  return out.sort((a, b) => b.points - a.points);
}

export type BpKind = 'att' | 'def';
export interface BpDelta { id: number; kind: BpKind; delta: number; total: number }

/** Positive BP gains between two kills maps. New ids count from 0. */
export function bpDeltas(prev: Map<number, number>, next: Map<number, number>, kind: BpKind): BpDelta[] {
  const out: BpDelta[] = [];
  for (const [id, total] of next) {
    const delta = total - (prev.get(id) ?? 0);
    if (delta > 0) out.push({ id, kind, delta, total });
  }
  return out.sort((a, b) => b.delta - a.delta);
}

export interface Activity { playerId: number; points: number; abp: number; dbp: number; towns: number; lastChangeAt: number; firstSeenAt: number }

/**
 * Update per-player activity: lastChangeAt moves to `now` whenever points, ABP, DBP or town count change.
 * Players missing from `players` are dropped (deleted accounts).
 */
export function updateActivity(prev: Map<number, Activity>, players: Map<number, Player>, abp: Map<number, number>, dbp: Map<number, number>, now: number): Map<number, Activity> {
  const out = new Map<number, Activity>();
  for (const [id, p] of players) {
    const a = abp.get(id) ?? 0;
    const d = dbp.get(id) ?? 0;
    const old = prev.get(id);
    if (!old) {
      out.set(id, { playerId: id, points: p.points, abp: a, dbp: d, towns: p.towns, lastChangeAt: now, firstSeenAt: now });
      continue;
    }
    const changed = old.points !== p.points || old.abp !== a || old.dbp !== d || old.towns !== p.towns;
    out.set(id, { playerId: id, points: p.points, abp: a, dbp: d, towns: p.towns, lastChangeAt: changed ? now : old.lastChangeAt, firstSeenAt: old.firstSeenAt });
  }
  return out;
}
