/**
 * Land-at-T op planner (pure). Computes when each member must click Send so their units land at T.
 * The bot NEVER sends anything in game (InnoGames rules): it only tells players the time.
 *
 * Travel time (as used by community tools such as GRCRT):
 *   seconds = 50 · distance_px / speed_boosted + 900 / world_speed
 *   speed_boosted = unit_speed · (1 + research/building bonus) · (1 + hero/spell/boost bonus)
 * units.json speeds already include the world's unit speed. Town pixel positions depend on the island
 * template (not public), so map-based times are estimates; the exact value is the travel time the game
 * shows in the attack window, which members can enter instead (then the send time is exact).
 */
import type { Town } from './data/parse.js';
import { localToEpoch } from './time.js';

export interface UnitInfo { id: string; name: string; speed: number; naval: boolean; flying: boolean }
export interface WorldInfo { units: Map<string, UnitInfo>; worldSpeed: number; unitSpeed: number }

export const BONUS = { meteorology: 0.1, cartography: 0.1, lighthouse: 0.15 } as const;
/** Pixels per island-grid unit on the world map. */
export const PX_PER_ISLAND = 128;
/** Typical spread of a town's position inside its island (px): drives the ± shown for estimates. */
export const TOWN_POS_SPREAD_PX = 180;
export const TRANSPORTS = ['big_transporter', 'small_transporter'] as const;

export const UNIT_EN: Record<string, string> = {
  sword: 'Swordsman', slinger: 'Slinger', archer: 'Archer', hoplite: 'Hoplite', rider: 'Horseman', chariot: 'Chariot', catapult: 'Catapult',
  minotaur: 'Minotaur', manticore: 'Manticore', zyklop: 'Cyclops', harpy: 'Harpy', medusa: 'Medusa', centaur: 'Centaur', pegasus: 'Pegasus',
  cerberus: 'Cerberus', fury: 'Erinys', griffin: 'Griffin', calydonian_boar: 'Calydonian Boar', satyr: 'Satyr', spartoi: 'Spartoi', ladon: 'Ladon',
  godsent: 'Divine Envoy', big_transporter: 'Transport Boat', bireme: 'Bireme', attack_ship: 'Light Ship', demolition_ship: 'Fire Ship',
  small_transporter: 'Fast Transport Ship', trireme: 'Trireme', colonize_ship: 'Colony Ship', sea_monster: 'Hydra', siren: 'Siren',
};

/** Parse units.json (official, per world). Militia (speed 0) is dropped. */
export function parseUnits(json: string): Map<string, UnitInfo> {
  const raw = JSON.parse(json) as Record<string, { id?: string; name?: string; speed?: number; is_naval?: boolean; flying?: boolean }>;
  const out = new Map<string, UnitInfo>();
  for (const [id, u] of Object.entries(raw)) {
    if (!u || !(Number(u.speed) > 0)) continue;
    out.set(id, { id, name: String(u.name ?? UNIT_EN[id] ?? id), speed: Number(u.speed), naval: !!u.is_naval, flying: !!u.flying });
  }
  return out;
}

/** World and unit speed from world_settings.json (names are localized: use the "speed" rows, else positions 3/4). */
export function parseWorldSpeeds(json: string): { worldSpeed: number; unitSpeed: number } {
  const ws = (JSON.parse(json) as { world_settings?: { name?: string; value?: unknown }[] }).world_settings ?? [];
  const re = /speed|ταχύτητα|geschwind|vitesse|velocid|snelheid|prędko|hız|rychlost|sebesség|viteză|скорост/i;
  const speeds = ws.filter((r) => re.test(String(r.name ?? '')) && Number(r.value) > 0).map((r) => Number(r.value));
  const at = (i: number) => (Number(ws[i]?.value) > 0 ? Number(ws[i]?.value) : undefined);
  return { worldSpeed: speeds[0] ?? at(3) ?? 1, unitSpeed: speeds[1] ?? at(4) ?? 1 };
}

/** Approximate absolute map position (px) of a town: island grid × 128, odd columns shifted half a tile. */
export function townPx(t: Pick<Town, 'islandX' | 'islandY'>): { x: number; y: number } {
  return { x: t.islandX * PX_PER_ISLAND, y: t.islandY * PX_PER_ISLAND + (t.islandX % 2 === 1 ? PX_PER_ISLAND / 2 : 0) };
}

export interface Mods { meteorology?: boolean; cartography?: boolean; lighthouse?: boolean; boost?: number; transport?: string }

/** Effective speed of one unit with the member's modifiers. */
export function boostedSpeed(u: UnitInfo, m: Mods): number {
  let bonus = 0;
  if (u.naval) { if (m.cartography) bonus += BONUS.cartography; if (m.lighthouse) bonus += BONUS.lighthouse; }
  else if (m.meteorology) bonus += BONUS.meteorology;
  return u.speed * (1 + bonus) * (1 + Math.max(0, m.boost ?? 0) / 100);
}

export interface TravelEstimate { seconds: number; uncertainty: number; speed: number; distPx: number; sameIsland: boolean; viaTransport: string | null }

export function estimateTravel(from: Town, to: Town, unitId: string, info: WorldInfo, m: Mods = {}): TravelEstimate {
  const u = info.units.get(unitId);
  if (!u) throw new Error(`unknown unit ${unitId}`);
  const sameIsland = from.islandX === to.islandX && from.islandY === to.islandY;
  let speed = boostedSpeed(u, m);
  let viaTransport: string | null = null;
  if (!u.naval && !u.flying && !sameIsland) {
    const tr = info.units.get(m.transport && (TRANSPORTS as readonly string[]).includes(m.transport) ? m.transport : 'big_transporter');
    if (tr) { speed = Math.min(speed, boostedSpeed(tr, m)); viaTransport = tr.id; }
  }
  const a = townPx(from);
  const b = townPx(to);
  // Same island: distance between slots is unknown; use a typical intra-island distance.
  const distPx = sameIsland ? TOWN_POS_SPREAD_PX : Math.hypot(a.x - b.x, a.y - b.y);
  const base = 900 / Math.max(1, info.worldSpeed);
  const seconds = Math.round((50 * distPx) / speed + base);
  const uncertainty = Math.round((50 * TOWN_POS_SPREAD_PX) / speed);
  return { seconds, uncertainty, speed, distPx, sameIsland, viaTransport };
}

/** "1:02:03", "02:03", "1h 2m 3s", "45m", "3600" → seconds; null if unparseable or > 7 days. */
export function parseDuration(s: string | null | undefined): number | null {
  if (!s) return null;
  const v = s.trim().toLowerCase();
  let secs: number | null = null;
  const colon = /^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/.exec(v);
  if (colon) secs = colon[3] !== undefined ? +colon[1] * 3600 + +colon[2] * 60 + +colon[3] : +colon[1] * 60 + +colon[2];
  else if (/^\d+$/.test(v)) secs = Number(v);
  else {
    const m = /^(?:(\d+)\s*(?:h|ω|ώ)[^\d]*)?(?:(\d+)\s*(?:m|λ)[^\d]*)?(?:(\d+)\s*(?:s|δ)[^\d]*)?$/.exec(v);
    if (m && (m[1] || m[2] || m[3])) secs = (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0));
  }
  return secs !== null && secs > 0 && secs <= 7 * 86_400 ? secs : null;
}

/**
 * Landing time in the WORLD's timezone (what the game clock shows):
 * "2026-11-25 21:30[:00]", "25/11 21:30[:00]", "25/11/2026 21:30", "21:30[:00]" (next occurrence),
 * a unix timestamp, or a Discord timestamp "<t:1764099000>".
 */
export function parseLandTime(s: string, tz: string, nowSec: number): number | null {
  const v = s.trim();
  const dt = /<t:(\d{9,11})(?::\w)?>/.exec(v);
  if (dt) return Number(dt[1]);
  if (/^\d{9,11}$/.test(v)) return Number(v);
  const iso = localToEpoch(v, tz);
  if (iso !== null && /^\d{4}-/.test(v)) return iso;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowSec * 1000));
  const [ty] = today.split('-');
  const dm = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (dm) {
    const year = dm[3] ? (dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : ty;
    let e = localToEpoch(`${year}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')} ${dm[4].padStart(2, '0')}:${dm[5]}:${dm[6] ?? '00'}`, tz);
    if (e !== null && !dm[3] && e < nowSec - 86_400) e = localToEpoch(`${Number(year) + 1}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')} ${dm[4].padStart(2, '0')}:${dm[5]}:${dm[6] ?? '00'}`, tz);
    return e;
  }
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (hm) {
    let e = localToEpoch(`${today} ${hm[1].padStart(2, '0')}:${hm[2]}:${hm[3] ?? '00'}`, tz);
    if (e !== null && e <= nowSec) e += 86_400;
    return e;
  }
  return null;
}

export const fmtDuration = (secs: number) => {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Wall-clock "HH:MM:SS" (and date) in the world's timezone, for players reading the in-game clock. */
export function worldClock(sec: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .format(new Date(sec * 1000)).replace(',', '');
}
