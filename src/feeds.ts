/** Feed configuration and pure matching logic. */
import type { Conquest } from './data/parse.js';
import type { AllianceChange, BpDelta } from './diff.js';
import type { WorldSnapshot } from './data/snapshot.js';
import { townOcean } from './data/snapshot.js';

export type FeedType = 'conquests' | 'alliance' | 'bp';
export const FEED_TYPES: FeedType[] = ['conquests', 'alliance', 'bp'];

export interface FeedFilter {
  allianceIds?: number[];
  playerIds?: number[];
  oceans?: number[];
  /** bp feeds: minimum BP gained in one refresh (default 5000). */
  minBp?: number;
  /** bp feeds: which BP to watch (default both). */
  bpKind?: 'att' | 'def' | 'any';
  /** conquests: skip ghost-town (no previous owner) takeovers. */
  skipGhosts?: boolean;
}

export interface FeedConfig { id: number; guildId: string; channelId: string; world: string; type: FeedType; filter: FeedFilter }

export const DEFAULT_MIN_BP = 5000;

const anyIn = (list: number[] | undefined, ...vals: (number | null)[]) =>
  !!list && list.length > 0 && vals.some((v) => v !== null && list.includes(v));
const empty = (l?: number[]) => !l || l.length === 0;

export function matchConquest(f: FeedFilter, c: Conquest, snap: WorldSnapshot): boolean {
  if (f.skipGhosts && c.oldPlayerId === null) return false;
  const town = snap.towns.get(c.townId);
  const ocean = town ? townOcean(town) : null;
  if (empty(f.allianceIds) && empty(f.playerIds) && empty(f.oceans)) return true;
  // Entity filters (alliance/player) are OR'ed together; ocean narrows further if given alongside them.
  const entityGiven = !empty(f.allianceIds) || !empty(f.playerIds);
  const entityOk = !entityGiven || anyIn(f.allianceIds, c.newAllianceId, c.oldAllianceId) || anyIn(f.playerIds, c.newPlayerId, c.oldPlayerId);
  const oceanOk = empty(f.oceans) || (ocean !== null && f.oceans!.includes(ocean));
  return entityOk && oceanOk;
}

export function matchAllianceChange(f: FeedFilter, ch: AllianceChange): boolean {
  if (empty(f.allianceIds) && empty(f.playerIds)) return true;
  return anyIn(f.allianceIds, ch.fromAllianceId, ch.toAllianceId) || anyIn(f.playerIds, ch.playerId);
}

export function matchBp(f: FeedFilter, d: BpDelta, snap: WorldSnapshot): boolean {
  const min = f.minBp ?? DEFAULT_MIN_BP;
  if (d.delta < min) return false;
  const kind = f.bpKind ?? 'any';
  if (kind !== 'any' && kind !== d.kind) return false;
  if (empty(f.allianceIds) && empty(f.playerIds)) return true;
  const p = snap.players.get(d.id);
  return anyIn(f.playerIds, d.id) || anyIn(f.allianceIds, p?.allianceId ?? null);
}
