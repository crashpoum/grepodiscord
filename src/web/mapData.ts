/**
 * Compact world-map payload for the web app: towns, players, alliances, our/enemy sides and the conquest history
 * (official conquers file) the client replays on the time slider. Arrays instead of objects keep it small
 * (a big world is a few hundred KB before gzip).
 */
import type { WorldSnapshot } from '../data/snapshot.js';

export type { MapPayload } from './types.js';
import type { MapPayload } from './types.js';

export function buildMapPayload(snap: WorldSnapshot, sides: { ours: number[]; enemies: number[]; allies?: number[]; source?: MapPayload['sides']['source'] }, opts: { now?: number; maxConquests?: number; history?: Record<string, Record<number, number>>; me?: number | null } = {}): MapPayload {
  const towns: MapPayload['towns'] = [];
  for (const x of snap.towns.values()) towns.push([x.id, x.islandX, x.islandY, x.slot, x.playerId ?? 0, x.points, x.name]);
  const players: MapPayload['players'] = [];
  for (const p of snap.players.values()) players.push([p.id, p.name, p.allianceId ?? 0, p.points]);
  const alliances: MapPayload['alliances'] = [];
  for (const a of snap.alliances.values()) alliances.push([a.id, a.name, a.points, a.towns]);
  const max = opts.maxConquests ?? 25_000;
  const cq = [...snap.conquers].sort((a, b) => a.time - b.time).slice(-max)
    .map((c): MapPayload['conquests'][number] => [c.time, c.townId, c.newPlayerId ?? 0, c.oldPlayerId ?? 0, c.newAllianceId ?? 0, c.oldAllianceId ?? 0]);
  return { world: snap.world, generatedAt: opts.now ?? Date.now(), towns, players, alliances, sides: { ours: sides.ours, allies: sides.allies ?? [], enemies: sides.enemies, source: sides.source ?? (sides.ours.length ? 'set' : 'none') }, conquests: cq, history: opts.history ?? {}, me: opts.me ?? null };
}

export type MapSides = MapPayload['sides'];
const DAY = 86400;
/**
 * Who is who on the map. Before this, the map used only `/war ally` (or verified players) for "ours" and conquests of
 * the last 7 days for "enemies"; with neither, every town was grey although the legend promised blue/red.
 * Now, in order: own alliance = verified players' alliances, else /roles alliance mappings, else the /war ally list
 * (narrowed to the alliance uploading its own commands, if any), else the alliance uploading its own commands. Allies = /war ally entries that are not own.
 * Enemies = /war enemy, else the alliances taking our towns (30 days), else the senders of incoming attacks.
 */
export function mapSides(snap: WorldSnapshot, input: { explicitOurs: number[]; explicitEnemies: number[]; linkedPlayers: number[]; roleAlliances: number[]; liveOwn: number[]; liveAttackers: number[]; now: number }): MapSides {
  const ok = (ids: Iterable<number>) => [...new Set([...ids].map(Number))].filter((id) => id > 0 && snap.alliances.has(id));
  const set = ok(input.explicitOurs);
  let ours: number[] = []; let source: MapSides['source'] = 'none';
  const linked = ok(input.linkedPlayers.map((p) => snap.players.get(Number(p))?.allianceId ?? 0));
  if (linked.length) { ours = linked; source = 'verified'; }
  else if (ok(input.roleAlliances).length) { ours = ok(input.roleAlliances); source = 'roles'; }
  else if (set.length) {
    // /war ally mixes our alliance and its pacts: the one(s) uploading own commands to the share are "us", the rest allies.
    const own = set.filter((id) => input.liveOwn.map(Number).includes(id));
    ours = own.length ? own : set; source = 'set';
  } else if (ok(input.liveOwn).length) { ours = ok(input.liveOwn).slice(0, 1); source = 'live'; }
  const allies = set.filter((id) => !ours.includes(id));
  const friendly = new Set([...ours, ...allies]);
  let enemies = ok(input.explicitEnemies).filter((id) => !friendly.has(id));
  if (!enemies.length && friendly.size) {
    const count = new Map<number, number>();
    for (const c of snap.conquers) {
      if (c.time < input.now - 30 * DAY || c.oldAllianceId === null || !friendly.has(c.oldAllianceId) || c.newAllianceId === null || friendly.has(c.newAllianceId)) continue;
      count.set(c.newAllianceId, (count.get(c.newAllianceId) ?? 0) + 1);
    }
    enemies = ok([...count].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id));
    if (!enemies.length) enemies = ok(input.liveAttackers).filter((id) => !friendly.has(id)).slice(0, 5);
  }
  return { ours, allies, enemies, source };
}
