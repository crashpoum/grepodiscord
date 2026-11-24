/**
 * GrepoGod → GrepoCord troop snapshots: shared types and strict validation (server + tests).
 * The payload's `towns` array is the town objects from GrepoGod `frSnapshot()` (cleanUnits / frWall / frSupportIn):
 *   { id, n, sea, home, total, sup?, w?, wq?, wa?, it?, res?, spells? }
 * Optional per-town `res` / `spells` come from already-loaded models (GrepoGod shRes / shSp).
 * Extra snapshot fields (moves, inc, sched, …) are ignored: this endpoint stores troops-in-towns only.
 */
export const GG_VERSION = 1;
export const GG_KEY_PREFIX = 'ggc1_';
export const GG_LIMITS = {
  body: 256 * 1024,
  towns: 250,
  name: 40,
  playerName: 40,
  units: 60,
  unitCount: 10_000_000,
  res: 10_000_000,
  pop: 1_000_000,
  spells: 12,
  rateMs: 15_000,
  /** A snapshot older than this is shown as stale (two missed 5-minute heartbeats, plus a little slack). */
  staleMs: 12 * 60_000,
} as const;

const UNIT_RE = /^[a-z][a-z0-9_]{0,39}$/;
const NAME_STRIP = /[\u0000-\u001f<>]/g;

export type UnitMap = Record<string, number>;
export interface GgRes {
  wood: number;
  stone: number;
  iron: number;
  storage: number;
  pop_free?: number;
}
export interface GgSpell {
  id: string;
  name?: string;
  ends_at?: number;
}
export interface GgTown {
  id: number;
  n: string;
  sea: number;
  home: UnitMap;
  total: UnitMap;
  sup: UnitMap;
  it?: UnitMap;
  w?: number;
  wq?: number;
  wa?: number;
  res?: GgRes;
  spells?: GgSpell[];
}
export interface GgPayload {
  v: number;
  world: string;
  player_id: number;
  player_name: string;
  ts: number;
  towns: GgTown[];
}
export type GgFail = 'invalid' | 'world' | 'player' | 'tooLarge';

export function sanitizeName(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  return s.replace(NAME_STRIP, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Whole positive counts, GrepoGod `frInUnits` rules: known-looking unit ids only. */
export function cleanUnitMap(u: unknown): UnitMap | null {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  const keys = Object.keys(u);
  if (keys.length > GG_LIMITS.units) return null;
  const o: UnitMap = {};
  for (const k of keys) {
    const n = (u as Record<string, unknown>)[k];
    if (!UNIT_RE.test(k) || typeof n !== 'number' || !Number.isInteger(n) || n <= 0 || n > GG_LIMITS.unitCount) return null;
    o[k] = n;
  }
  return o;
}

const intIn = (v: unknown, min: number, max: number): number | null =>
  (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) ? v : null;

/** Warehouse stocks; omit the whole object when GrepoGod's shRes switch is off. */
export function cleanRes(raw: unknown): GgRes | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const wood = intIn(r.wood, 0, GG_LIMITS.res);
  const stone = intIn(r.stone, 0, GG_LIMITS.res);
  const iron = intIn(r.iron, 0, GG_LIMITS.res);
  const storage = intIn(r.storage, 1, GG_LIMITS.res);
  if (wood === null || stone === null || iron === null || storage === null) return null;
  const out: GgRes = { wood, stone, iron, storage };
  if (r.pop_free !== undefined && r.pop_free !== null) {
    const p = intIn(r.pop_free, 0, GG_LIMITS.pop);
    if (p === null) return null;
    out.pop_free = p;
  }
  return out;
}

/** Active spells; omit the array when GrepoGod's shSp switch is off. A non-string `name` is dropped, never stringified. */
export function cleanSpells(raw: unknown): GgSpell[] | null {
  if (!Array.isArray(raw) || raw.length > GG_LIMITS.spells) return null;
  const out: GgSpell[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const s = item as Record<string, unknown>;
    const id = typeof s.id === 'string' ? s.id : '';
    if (!UNIT_RE.test(id)) return null;
    if (seen.has(id)) continue;
    seen.add(id);
    const sp: GgSpell = { id };
    if (typeof s.name === 'string') {
      const n = sanitizeName(s.name, GG_LIMITS.name);
      if (n && n !== '[object Object]') sp.name = n;
    }
    if (s.ends_at !== undefined && s.ends_at !== null) {
      const e = intIn(s.ends_at, 1, 4_000_000_000);
      if (e === null) return null;
      sp.ends_at = e;
    }
    out.push(sp);
  }
  return out;
}

function cleanTown(raw: unknown): GgTown | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  const id = intIn(t.id, 1, 2_000_000_000);
  const sea = intIn(t.sea, 0, 99);
  const n = sanitizeName(t.n, GG_LIMITS.name);
  const home = cleanUnitMap(t.home);
  const total = cleanUnitMap(t.total);
  if (id === null || sea === null || !n || !home || !total) return null;
  const town: GgTown = { id, n, sea, home, total, sup: {} };
  if (t.sup !== undefined) { const s = cleanUnitMap(t.sup); if (!s) return null; town.sup = s; }
  if (t.it !== undefined) { const it = cleanUnitMap(t.it); if (!it) return null; town.it = it; }
  if (t.w !== undefined) { const w = intIn(t.w, 0, 30); if (w === null) return null; town.w = w; }
  if (t.wq !== undefined) { const q = intIn(t.wq, 0, 30); if (q === null) return null; town.wq = q; }
  if (t.wa !== undefined) { const a = intIn(t.wa, 1, 4_000_000_000); if (a === null) return null; town.wa = a; }
  if (t.res !== undefined) { const r = cleanRes(t.res); if (!r) return null; town.res = r; }
  if (t.spells !== undefined) { const s = cleanSpells(t.spells); if (!s) return null; town.spells = s; }
  return town;
}

/** Client ts may be ms or seconds; stored as ms. */
export function normTs(ts: unknown, now: number): number | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null;
  const ms = ts < 1e11 ? Math.floor(ts * 1000) : Math.floor(ts);
  if (ms > now + 3600_000) return null; // more than 1 h in the future
  if (ms < now - 30 * 86400_000) return null; // older than 30 days
  return ms;
}

export function validatePayload(body: unknown, now: number, worldOk: (w: string) => boolean):
  { ok: true; p: GgPayload } | { ok: false; err: GgFail } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, err: 'invalid' };
  const b = body as Record<string, unknown>;
  if (b.v !== GG_VERSION) return { ok: false, err: 'invalid' };
  const world = typeof b.world === 'string' ? b.world.trim().toLowerCase() : '';
  if (!world || !worldOk(world)) return { ok: false, err: 'world' };
  const player_id = intIn(b.player_id, 1, 2_000_000_000);
  const player_name = sanitizeName(b.player_name, GG_LIMITS.playerName);
  const ts = normTs(b.ts, now);
  if (player_id === null || !player_name || ts === null) return { ok: false, err: 'invalid' };
  if (!Array.isArray(b.towns)) return { ok: false, err: 'invalid' };
  if (b.towns.length > GG_LIMITS.towns) return { ok: false, err: 'tooLarge' };
  const towns: GgTown[] = [];
  const seen = new Set<number>();
  for (const raw of b.towns) {
    const t = cleanTown(raw);
    if (!t || seen.has(t.id)) return { ok: false, err: 'invalid' };
    seen.add(t.id);
    towns.push(t);
  }
  return { ok: true, p: { v: GG_VERSION, world, player_id, player_name, ts, towns } };
}

export function looksLikeGgKey(key: string): boolean {
  return key.startsWith(GG_KEY_PREFIX) && key.length >= 20 && key.length <= 80 && /^[A-Za-z0-9_-]+$/.test(key);
}

export type UnitField = 'home' | 'total' | 'sup' | 'it';
export function addMaps(into: Map<string, number>, u: UnitMap | undefined) {
  if (!u) return;
  for (const [k, n] of Object.entries(u)) into.set(k, (into.get(k) ?? 0) + n);
}
export function townHasUnit(t: GgTown, unit: string): boolean {
  return !!(t.home[unit] || t.total[unit] || t.sup[unit] || t.it?.[unit]);
}

export interface GgPlayerSnap {
  playerId: number;
  playerName: string;
  mine: boolean;
  ts: number;
  recvAt: number;
  towns: GgTown[];
}
export interface GgFilters { q: string; player: number | null; unit: string | null }
export function filterSnaps(all: GgPlayerSnap[], f: GgFilters): GgPlayerSnap[] {
  const q = f.q.trim().toLowerCase();
  return all.map((p) => {
    if (f.player !== null && p.playerId !== f.player) return { ...p, towns: [] as GgTown[] };
    if (q && !p.playerName.toLowerCase().includes(q)) {
      const towns = p.towns.filter((t) => t.n.toLowerCase().includes(q) || String(t.id) === q || String(t.sea) === q);
      return { ...p, towns };
    }
    return p;
  }).map((p) => f.unit ? { ...p, towns: p.towns.filter((t) => townHasUnit(t, f.unit!)) } : p)
    .filter((p) => p.towns.length > 0 || (f.player === p.playerId && !q && !f.unit));
}

export function totalUnits(players: GgPlayerSnap[], field: UnitField = 'total'): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of players) for (const t of p.towns) addMaps(m, field === 'it' ? t.it : t[field]);
  return m;
}

/** Compact town-card height, and expanded height used by the 2-column Friends-style grid. */
export function townH(t: GgTown, open: boolean): number {
  const TH = 56, HEAD = 52, ROW = 58, RES_H = 100, SPELL_BASE = 36, SPELL_LINE = 26;
  if (!open) return TH;
  let h = HEAD + 4 + ROW;
  if (t.it) h += ROW;
  h += ROW;
  if (Object.keys(t.sup).length) h += ROW;
  if (t.res) h += RES_H;
  if (t.spells) h += SPELL_BASE + SPELL_LINE * Math.ceil(Math.max(1, t.spells.length) / 2);
  return h;
}
export function gridH(heights: number[], cols: number): number {
  if (!heights.length) return 0;
  const c = Math.max(1, cols);
  let h = 0;
  for (let i = 0; i < heights.length; i += c) {
    if (i) h += 8;
    h += Math.max(...heights.slice(i, i + c));
  }
  return h;
}
