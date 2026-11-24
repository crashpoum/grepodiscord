import { Alliance, Conquest, Player, Town, killsMap, parseAlliances, parseConquers, parseKills, parsePlayers, parseTowns } from './parse.js';
import { oceanOf } from '../geo.js';

/** Raw (decompressed) file bodies for one world. */
export interface WorldFiles {
  players: string;
  alliances: string;
  towns: string;
  conquers: string;
  player_kills_att: string;
  player_kills_def: string;
  alliance_kills_att?: string;
  alliance_kills_def?: string;
}
export const WORLD_FILE_NAMES = ['players', 'alliances', 'towns', 'conquers', 'player_kills_att', 'player_kills_def', 'alliance_kills_att', 'alliance_kills_def'] as const;
export type WorldFileName = (typeof WORLD_FILE_NAMES)[number];

export interface WorldSnapshot {
  world: string;
  players: Map<number, Player>;
  alliances: Map<number, Alliance>;
  towns: Map<number, Town>;
  townsByPlayer: Map<number, Town[]>;
  conquers: Conquest[];
  playerAbp: Map<number, number>;
  playerDbp: Map<number, number>;
  allianceAbp: Map<number, number>;
  allianceDbp: Map<number, number>;
}

export function buildSnapshot(world: string, f: WorldFiles): WorldSnapshot {
  const players = new Map(parsePlayers(f.players).map((p) => [p.id, p] as const));
  const alliances = new Map(parseAlliances(f.alliances).map((a) => [a.id, a] as const));
  const towns = new Map<number, Town>();
  const townsByPlayer = new Map<number, Town[]>();
  for (const t of parseTowns(f.towns)) {
    towns.set(t.id, t);
    if (t.playerId) {
      const arr = townsByPlayer.get(t.playerId) ?? [];
      arr.push(t);
      townsByPlayer.set(t.playerId, arr);
    }
  }
  return {
    world, players, alliances, towns, townsByPlayer,
    conquers: parseConquers(f.conquers),
    playerAbp: killsMap(parseKills(f.player_kills_att)),
    playerDbp: killsMap(parseKills(f.player_kills_def)),
    allianceAbp: killsMap(parseKills(f.alliance_kills_att ?? '')),
    allianceDbp: killsMap(parseKills(f.alliance_kills_def ?? '')),
  };
}

export function townOcean(t: Town): number {
  return oceanOf(t.islandX, t.islandY);
}

/** Case-insensitive prefix-then-substring search, for Discord autocomplete. */
export function searchByName<T extends { name: string }>(items: Iterable<T>, query: string, limit = 25, score?: (x: T) => number): T[] {
  const q = query.trim().toLowerCase();
  const prefix: T[] = [];
  const contains: T[] = [];
  for (const it of items) {
    const n = it.name.toLowerCase();
    if (!q || n.startsWith(q)) prefix.push(it);
    else if (n.includes(q)) contains.push(it);
  }
  const by = score ? (a: T, b: T) => score(b) - score(a) : () => 0;
  return [...prefix.sort(by), ...contains.sort(by)].slice(0, limit);
}
