/**
 * Compact world-map payload for the web app: towns, players, alliances, our/enemy sides and the conquest history
 * (official conquers file) the client replays on the time slider. Arrays instead of objects keep it small
 * (a big world is a few hundred KB before gzip).
 */
import type { WorldSnapshot } from '../data/snapshot.js';

export type { MapPayload } from './types.js';
import type { MapPayload } from './types.js';

export function buildMapPayload(snap: WorldSnapshot, sides: { ours: number[]; enemies: number[] }, opts: { now?: number; maxConquests?: number; history?: Record<string, Record<number, number>>; me?: number | null } = {}): MapPayload {
  const towns: MapPayload['towns'] = [];
  for (const x of snap.towns.values()) towns.push([x.id, x.islandX, x.islandY, x.slot, x.playerId ?? 0, x.points, x.name]);
  const players: MapPayload['players'] = [];
  for (const p of snap.players.values()) players.push([p.id, p.name, p.allianceId ?? 0, p.points]);
  const alliances: MapPayload['alliances'] = [];
  for (const a of snap.alliances.values()) alliances.push([a.id, a.name, a.points, a.towns]);
  const max = opts.maxConquests ?? 25_000;
  const cq = [...snap.conquers].sort((a, b) => a.time - b.time).slice(-max)
    .map((c): MapPayload['conquests'][number] => [c.time, c.townId, c.newPlayerId ?? 0, c.oldPlayerId ?? 0, c.newAllianceId ?? 0, c.oldAllianceId ?? 0]);
  return { world: snap.world, generatedAt: opts.now ?? Date.now(), towns, players, alliances, sides: { ours: sides.ours, enemies: sides.enemies }, conquests: cq, history: opts.history ?? {}, me: opts.me ?? null };
}
