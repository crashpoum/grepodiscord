/**
 * Pure travel-time, range-ring and smart-search helpers for the world map (shared by the browser bundle and tests;
 * no Node imports). Uses the same speed model as src/planner.ts:
 *   seconds = 50 * distPx / speed_boosted + 900 / worldSpeed
 *   PX_PER_ISLAND = 128, odd islandX shifted half a tile down in townPx.
 */

export interface UnitSpeedDef { speed: number; naval: boolean; flying: boolean }
export interface MapSpeeds { world: number; unit: number; units: Record<string, UnitSpeedDef> }
export interface TravelMods { meteorology?: boolean; cartography?: boolean; lighthouse?: boolean; boost?: number; transport?: 'big_transporter' | 'small_transporter' }

export const MAP_BONUS = { meteorology: 0.1, cartography: 0.1, lighthouse: 0.15 } as const;
export const MAP_PX_PER_ISLAND = 128;
export const MAP_TOWN_SPREAD_PX = 180;

/** Unit-speed-1 base speeds as fallback when a map payload has no world units.json attached. */
export const DEFAULT_BASE_UNITS: Record<string, UnitSpeedDef> = {
  colonize_ship: { speed: 3, naval: true, flying: false },
  bireme: { speed: 15, naval: true, flying: false },
  attack_ship: { speed: 13, naval: true, flying: false },
  trireme: { speed: 9, naval: true, flying: false },
  demolition_ship: { speed: 5, naval: true, flying: false },
  small_transporter: { speed: 15, naval: true, flying: false },
  big_transporter: { speed: 8, naval: true, flying: false },
  sea_monster: { speed: 8, naval: true, flying: false },
  siren: { speed: 22, naval: true, flying: false },
  sword: { speed: 8, naval: false, flying: false },
  slinger: { speed: 14, naval: false, flying: false },
  archer: { speed: 12, naval: false, flying: false },
  hoplite: { speed: 6, naval: false, flying: false },
  rider: { speed: 22, naval: false, flying: false },
  chariot: { speed: 18, naval: false, flying: false },
  catapult: { speed: 2, naval: false, flying: false },
  harpy: { speed: 25, naval: false, flying: true },
  manticore: { speed: 22, naval: false, flying: true },
  griffin: { speed: 18, naval: false, flying: true },
  pegasus: { speed: 35, naval: false, flying: true },
  ladon: { speed: 26, naval: false, flying: true },
  medusa: { speed: 6, naval: false, flying: false },
  minotaur: { speed: 10, naval: false, flying: false },
  zyklop: { speed: 8, naval: false, flying: false },
  centaur: { speed: 18, naval: false, flying: false },
  cerberus: { speed: 4, naval: false, flying: false },
  fury: { speed: 10, naval: false, flying: false },
  godsent: { speed: 16, naval: false, flying: false },
};

export const RULER_UNIT_ORDER = [
  'colonize_ship', 'attack_ship', 'bireme', 'trireme', 'small_transporter', 'big_transporter', 'demolition_ship', 'siren', 'sea_monster',
  'harpy', 'manticore', 'griffin', 'pegasus', 'ladon',
  'slinger', 'hoplite', 'rider', 'chariot', 'sword', 'archer', 'catapult', 'medusa', 'minotaur', 'fury', 'cerberus', 'godsent',
] as const;

export function fallbackSpeeds(world = 1, unit = 1): MapSpeeds {
  const units: Record<string, UnitSpeedDef> = {};
  for (const [k, u] of Object.entries(DEFAULT_BASE_UNITS)) units[k] = { ...u, speed: u.speed * Math.max(1, unit) };
  return { world: Math.max(1, world), unit: Math.max(1, unit), units };
}

export function mapBoostedSpeed(u: UnitSpeedDef, m: TravelMods = {}): number {
  let bonus = 0;
  if (u.naval) { if (m.cartography) bonus += MAP_BONUS.cartography; if (m.lighthouse) bonus += MAP_BONUS.lighthouse; }
  else if (m.meteorology) bonus += MAP_BONUS.meteorology;
  return u.speed * (1 + bonus) * (1 + Math.max(0, Math.min(200, m.boost ?? 0)) / 100);
}

export function islandPx(ix: number, iy: number): { x: number; y: number } {
  return { x: ix * MAP_PX_PER_ISLAND, y: iy * MAP_PX_PER_ISLAND + (ix % 2 === 1 ? MAP_PX_PER_ISLAND / 2 : 0) };
}

export function effectiveUnitSpeed(unitId: string, speeds: MapSpeeds, m: TravelMods = {}, sameIsland = false): { speed: number; viaTransport: string | null } | null {
  const u = speeds.units[unitId];
  if (!u || !(u.speed > 0)) return null;
  let speed = mapBoostedSpeed(u, m);
  let viaTransport: string | null = null;
  if (!u.naval && !u.flying && !sameIsland) {
    const trId = m.transport === 'small_transporter' ? 'small_transporter' : 'big_transporter';
    const tr = speeds.units[trId];
    if (tr && tr.speed > 0) { speed = Math.min(speed, mapBoostedSpeed(tr, m)); viaTransport = trId; }
  }
  return { speed, viaTransport };
}

export interface MapTravelEstimate { seconds: number; uncertainty: number; sameIsland: boolean; viaTransport: string | null; distGrid: number }

export function mapTownTravel(from: { ix: number; iy: number }, to: { ix: number; iy: number }, unitId: string, speeds: MapSpeeds, m: TravelMods = {}): MapTravelEstimate | null {
  const eff = effectiveUnitSpeed(unitId, speeds, m, from.ix === to.ix && from.iy === to.iy);
  if (!eff) return null;
  const sameIsland = from.ix === to.ix && from.iy === to.iy;
  const a = islandPx(from.ix, from.iy), b = islandPx(to.ix, to.iy);
  const distPx = sameIsland ? MAP_TOWN_SPREAD_PX : Math.hypot(a.x - b.x, a.y - b.y);
  const base = 900 / Math.max(1, speeds.world);
  return {
    seconds: Math.round((50 * distPx) / eff.speed + base),
    uncertainty: Math.round((50 * MAP_TOWN_SPREAD_PX) / eff.speed),
    sameIsland,
    viaTransport: eff.viaTransport,
    distGrid: Math.hypot(to.ix - from.ix, to.iy - from.iy),
  };
}

/** Max reach radius in island-grid units for a given travel budget in seconds (inverse of mapTownTravel). */
export function mapRangeRadius(unitId: string, maxSeconds: number, speeds: MapSpeeds, m: TravelMods = {}): number {
  const eff = effectiveUnitSpeed(unitId, speeds, m, false);
  if (!eff) return 0;
  const base = 900 / Math.max(1, speeds.world);
  if (maxSeconds <= base) return 0;
  const maxDistPx = ((maxSeconds - base) * eff.speed) / 50;
  return maxDistPx / MAP_PX_PER_ISLAND;
}

export function fmtHms(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export type SmartQuery = { kind: 'ocean'; ocean: number } | { kind: 'xy'; ix: number; iy: number } | null;

/** Parse ocean ("45", "o45", "ocean 45", "ω45", "ωκεανός 45") or coordinates ("450|530", "450, 530"). */
export function parseMapQuery(q: string): SmartQuery {
  const s = q.trim().toLowerCase();
  if (!s) return null;
  const xy = /^(\d{1,4})\s*[|,:\s]\s*(\d{1,4})$/.exec(s);
  if (xy) {
    const ix = Number(xy[1]), iy = Number(xy[2]);
    if (ix >= 0 && ix <= 1000 && iy >= 0 && iy <= 1000) return { kind: 'xy', ix, iy };
  }
  const oc = /^(?:(?:o|oc|ocean|ω|ωκ|ωκεανος|ωκεανός)\s*[:#]?\s*)?(\d{1,2})$/i.exec(s);
  if (oc) {
    const ocean = Number(oc[1]);
    if (ocean >= 0 && ocean <= 99) return { kind: 'ocean', ocean };
  }
  return null;
}
