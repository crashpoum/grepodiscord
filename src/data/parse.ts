/**
 * Pure parsers for the official Grepolis world data files
 * (https://{world}.grepolis.com/data/*.txt.gz). No I/O here.
 *
 * Formats (CSV, no header, verified live 2026-11-24):
 *  players.txt    id,name,alliance_id,points,rank,towns
 *  alliances.txt  id,name,points,towns,members,rank
 *  towns.txt      id,player_id,name,island_x,island_y,number_on_island,points
 *  conquers.txt   town_id,time,new_player_id,old_player_id,new_alliance_id,old_alliance_id,town_points
 *  *_kills_*.txt  rank,id,points
 * Names are PHP urlencode()d ("+" = space, %XX escapes).
 */

export interface Player { id: number; name: string; allianceId: number | null; points: number; rank: number; towns: number }
export interface Alliance { id: number; name: string; points: number; towns: number; members: number; rank: number }
export interface Town { id: number; playerId: number | null; name: string; islandX: number; islandY: number; slot: number; points: number }
export interface Conquest { townId: number; time: number; newPlayerId: number | null; oldPlayerId: number | null; newAllianceId: number | null; oldAllianceId: number | null; townPoints: number }
export interface KillRow { rank: number; id: number; points: number }

/** Decode a PHP urlencode()d string. Never throws on malformed escapes. */
export function decodeName(raw: string): string {
  const s = raw.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(s);
  } catch {
    // Fallback: decode valid %XX sequences one by one.
    return s.replace(/(%[0-9A-Fa-f]{2})+/g, (m) => {
      try { return decodeURIComponent(m); } catch { return m; }
    });
  }
}

function lines(text: string): string[][] {
  const out: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    out.push(line.split(','));
  }
  return out;
}

const int = (s: string | undefined): number => {
  const n = Number.parseInt(s ?? '', 10);
  return Number.isFinite(n) ? n : 0;
};
const optId = (s: string | undefined): number | null => {
  if (s === undefined || s === '') return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function parsePlayers(text: string): Player[] {
  return lines(text).filter((c) => c.length >= 6).map((c) => ({
    id: int(c[0]), name: decodeName(c[1]), allianceId: optId(c[2]),
    points: int(c[3]), rank: int(c[4]), towns: int(c[5]),
  }));
}

export function parseAlliances(text: string): Alliance[] {
  return lines(text).filter((c) => c.length >= 6).map((c) => ({
    id: int(c[0]), name: decodeName(c[1]), points: int(c[2]),
    towns: int(c[3]), members: int(c[4]), rank: int(c[5]),
  }));
}

export function parseTowns(text: string): Town[] {
  return lines(text).filter((c) => c.length >= 7).map((c) => ({
    id: int(c[0]), playerId: optId(c[1]), name: decodeName(c[2]),
    islandX: int(c[3]), islandY: int(c[4]), slot: int(c[5]), points: int(c[6]),
  }));
}

export function parseConquers(text: string): Conquest[] {
  return lines(text).filter((c) => c.length >= 7).map((c) => ({
    townId: int(c[0]), time: int(c[1]), newPlayerId: optId(c[2]), oldPlayerId: optId(c[3]),
    newAllianceId: optId(c[4]), oldAllianceId: optId(c[5]), townPoints: int(c[6]),
  }));
}

export function parseKills(text: string): KillRow[] {
  return lines(text).filter((c) => c.length >= 3).map((c) => ({ rank: int(c[0]), id: int(c[1]), points: int(c[2]) }));
}

/** Map id -> points from a kills file. */
export function killsMap(rows: KillRow[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.id, r.points);
  return m;
}
