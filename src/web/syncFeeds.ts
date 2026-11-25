/**
 * Data sync from an external client: incoming commands (alerts) and planned sends (ops).
 * Lenient on purpose: `ts` may be ms or seconds, unknown fields are ignored and a malformed item is skipped (counted),
 * never the whole list. Each POST carries the FULL current list and replaces the previous one.
 * The client must only send what the game already shows the player; this server never talks to the game.
 */
import { GG_VERSION, cleanUnitMap, normTs, sanitizeName, type UnitMap } from './ggCore.js';

export const FEED_LIMITS = { cmds: 500, ops: 500, id: 64, note: 200, reason: 200, unitsText: 120, kind: 40 } as const;
export type FeedKind = 'incoming' | 'ops';
export type IncomingType = 'attack' | 'support' | 'revolt' | 'conquest' | 'spy' | 'other';
export const INCOMING_TYPES: IncomingType[] = ['attack', 'support', 'revolt', 'conquest', 'spy', 'other'];
/** Types that count as a threat for alerts (support/other never ping). */
export const HOSTILE_TYPES = new Set<IncomingType>(['attack', 'revolt', 'conquest', 'spy']);

/**
 * Prediction of an incoming command's units. `units` may be a unit map with counts, a short text, or a list of unit ids
 * (types only: the top predicted group); `groups` is the full ranked list of candidate groups with a percentage.
 */
export interface PredGroup { pct: number; units: string[] }
export interface Prediction { kind?: string; units?: string | UnitMap | string[]; groups?: PredGroup[]; conf?: number; note?: string }
export interface IncomingCmd {
  id: string; town_id: number; town_n: string; type: IncomingType; arrival: number;
  from_town_id?: number; from_town_n?: string; from_player_id?: number; from_player?: string; from_alliance?: string;
  started?: number; pred?: Prediction;
}
export type OpStatus = 'scheduled' | 'sent' | 'failed';
export interface SyncOp {
  id: string; kind: 'attack' | 'support'; from_town_id: number; from_town_n: string; target_town_id: number; target_town_n: string;
  target_player?: string; units?: string | UnitMap; send_at: number; arrive_at?: number; status: OpStatus; sent_at?: number; arrival?: number; reason?: string;
}
export interface FeedHead { v: number; world: string; player_id: number; player_name: string; ts: number }
export type FeedFail = 'invalid' | 'world' | 'tooLarge';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const intIn = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : null;
};
/** Unix seconds; a millisecond value is converted. Plausible range only (2001…2096). */
export function toSec(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  const s = v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
  return s >= 1e9 && s <= 4e9 ? s : null;
}
const cleanId = (v: unknown): string | null => {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
  return s && s.length <= FEED_LIMITS.id && /^[\w:.\-]+$/.test(s) ? s : null;
};
const optName = (v: unknown, max = 40) => { const s = sanitizeName(v, max); return s || undefined; };
const optInt = (v: unknown) => intIn(v, 1, 2_000_000_000) ?? undefined;

const TYPE_ALIASES: Record<string, IncomingType> = {
  attack: 'attack', attack_land: 'attack', attack_sea: 'attack', attack_incoming: 'attack', breakthrough: 'attack', siege: 'conquest',
  support: 'support', revolt: 'revolt', revolt_arising: 'revolt', revolt_running: 'revolt', conquest: 'conquest', takeover: 'conquest', attack_takeover: 'conquest',
  spy: 'spy', espionage: 'spy', attack_spy: 'spy',
};
export function normType(v: unknown): IncomingType {
  const k = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return TYPE_ALIASES[k] ?? 'other';
}
/** Units are either an official unit map or a short free text ("~300 slingers"). */
function cleanUnits(v: unknown): string | UnitMap | undefined {
  if (typeof v === 'string') { const s = sanitizeName(v, FEED_LIMITS.unitsText); return s || undefined; }
  if (isObj(v)) { const m = cleanUnitMap(v); return m && Object.keys(m).length ? m : undefined; }
  return undefined;
}
const UNIT_ID = /^[a-z][a-z0-9_]{0,39}$/;
/** A list of unit ids (types only), de-duplicated, at most 20. */
function unitIds(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const ids = [...new Set(v.filter((x): x is string => typeof x === 'string' && UNIT_ID.test(x)))].slice(0, 20);
  return ids.length ? ids : undefined;
}
function cleanGroups(v: unknown): PredGroup[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: PredGroup[] = [];
  for (const g of v.slice(0, 12)) {
    if (!isObj(g) || typeof g.pct !== 'number' || !Number.isFinite(g.pct)) continue;
    const units = unitIds(g.units);
    if (!units) continue;
    out.push({ pct: Math.max(0, Math.min(100, Math.round(g.pct))), units });
  }
  return out.length ? out.sort((a, b) => b.pct - a.pct) : undefined;
}
export function cleanPred(v: unknown): Prediction | undefined {
  if (!isObj(v)) return undefined;
  const p: Prediction = {};
  const kind = optName(v.kind, FEED_LIMITS.kind); if (kind) p.kind = kind;
  const units = Array.isArray(v.units) ? unitIds(v.units) : cleanUnits(v.units); if (units) p.units = units;
  const groups = cleanGroups(v.groups); if (groups) p.groups = groups;
  if (typeof v.conf === 'number' && Number.isFinite(v.conf)) {
    const c = v.conf > 1 && v.conf <= 100 ? v.conf / 100 : v.conf;
    if (c >= 0 && c <= 1) p.conf = Math.round(c * 100) / 100;
  }
  const note = optName(v.note, FEED_LIMITS.note); if (note) p.note = note;
  return Object.keys(p).length ? p : undefined;
}
/** Total unit count of a unit map, or null when only a text is known. */
export function unitTotal(u: string | UnitMap | string[] | undefined): number | null {
  if (!u || typeof u === 'string' || Array.isArray(u)) return null;
  return Object.values(u).reduce((a, b) => a + b, 0);
}

function cleanIncoming(raw: unknown): IncomingCmd | null {
  if (!isObj(raw)) return null;
  const id = cleanId(raw.id), town_id = intIn(raw.town_id, 1, 2_000_000_000), arrival = toSec(raw.arrival);
  if (!id || town_id === null || arrival === null) return null;
  const c: IncomingCmd = { id, town_id, town_n: sanitizeName(raw.town_n, 40) || `#${town_id}`, type: normType(raw.type), arrival };
  const ft = optInt(raw.from_town_id); if (ft) c.from_town_id = ft;
  const ftn = optName(raw.from_town_n); if (ftn) c.from_town_n = ftn;
  const fp = optInt(raw.from_player_id); if (fp) c.from_player_id = fp;
  const fpn = optName(raw.from_player); if (fpn) c.from_player = fpn;
  const fa = optName(raw.from_alliance); if (fa) c.from_alliance = fa;
  const st = toSec(raw.started); if (st) c.started = st;
  const pred = cleanPred(raw.pred); if (pred) c.pred = pred;
  return c;
}

const OP_STATUS: Record<string, OpStatus> = { scheduled: 'scheduled', pending: 'scheduled', planned: 'scheduled', queued: 'scheduled', sent: 'sent', done: 'sent', ok: 'sent', success: 'sent', failed: 'failed', error: 'failed', fail: 'failed' };
function cleanOp(raw: unknown): SyncOp | null {
  if (!isObj(raw)) return null;
  const id = cleanId(raw.id), from = intIn(raw.from_town_id, 1, 2_000_000_000), to = intIn(raw.target_town_id, 1, 2_000_000_000), send_at = toSec(raw.send_at);
  const status = OP_STATUS[typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : ''];
  if (!id || from === null || to === null || send_at === null || !status) return null;
  const o: SyncOp = { id, kind: raw.kind === 'support' ? 'support' : 'attack', from_town_id: from, from_town_n: sanitizeName(raw.from_town_n, 40) || `#${from}`,
    target_town_id: to, target_town_n: sanitizeName(raw.target_town_n, 40) || `#${to}`, send_at, status };
  const tp = optName(raw.target_player); if (tp) o.target_player = tp;
  const u = cleanUnits(raw.units); if (u) o.units = u;
  const aa = toSec(raw.arrive_at); if (aa) o.arrive_at = aa;
  const sa = toSec(raw.sent_at); if (sa) o.sent_at = sa;
  const ar = toSec(raw.arrival); if (ar) o.arrival = ar;
  const reason = optName(raw.reason, FEED_LIMITS.reason); if (reason) o.reason = reason;
  return o;
}

function head(b: unknown, now: number, worldOk: (w: string) => boolean): { ok: true; h: FeedHead; b: Record<string, unknown> } | { ok: false; err: FeedFail } {
  if (!isObj(b) || b.v !== GG_VERSION) return { ok: false, err: 'invalid' };
  const world = typeof b.world === 'string' ? b.world.trim().toLowerCase() : '';
  if (!world || !worldOk(world)) return { ok: false, err: 'world' };
  const player_id = intIn(b.player_id, 1, 2_000_000_000);
  const player_name = sanitizeName(b.player_name, 40);
  const ts = normTs(b.ts, now);
  if (player_id === null || !player_name || ts === null) return { ok: false, err: 'invalid' };
  return { ok: true, h: { v: GG_VERSION, world, player_id, player_name, ts }, b };
}

export type FeedResult<T> = { ok: true; h: FeedHead; items: T[]; skipped: number } | { ok: false; err: FeedFail };
function list<T>(b: unknown, field: string, max: number, clean: (x: unknown) => (T & { id: string }) | null, now: number, worldOk: (w: string) => boolean): FeedResult<T> {
  const hd = head(b, now, worldOk);
  if (!hd.ok) return hd;
  const arr = hd.b[field];
  if (!Array.isArray(arr)) return { ok: false, err: 'invalid' };
  if (arr.length > max) return { ok: false, err: 'tooLarge' };
  const seen = new Set<string>();
  const items: T[] = [];
  let skipped = 0;
  for (const raw of arr) {
    const x = clean(raw);
    if (!x || seen.has(x.id)) { skipped++; continue; }
    seen.add(x.id);
    items.push(x);
  }
  return { ok: true, h: hd.h, items, skipped };
}
export const validateIncoming = (b: unknown, now: number, worldOk: (w: string) => boolean): FeedResult<IncomingCmd> => list(b, 'cmds', FEED_LIMITS.cmds, cleanIncoming, now, worldOk);
export const validateOps = (b: unknown, now: number, worldOk: (w: string) => boolean): FeedResult<SyncOp> => list(b, 'ops', FEED_LIMITS.ops, cleanOp, now, worldOk);

/** Commands of a POST that should raise an alert: hostile, still to land, not alerted before, big enough when the size is known. */
export function newAlerts(cmds: IncomingCmd[], already: Set<string>, nowSec: number, opts: { minSize: number; types: IncomingType[] }): IncomingCmd[] {
  const types = new Set(opts.types.length ? opts.types : [...HOSTILE_TYPES]);
  return cmds.filter((c) => {
    if (already.has(c.id) || c.arrival <= nowSec || !types.has(c.type)) return false;
    const n = unitTotal(c.pred?.units);
    return !(opts.minSize > 0 && n !== null && n < opts.minSize);
  }).sort((a, b) => a.arrival - b.arrival);
}

/** Group ops for the tab: scheduled (soonest first), sent (latest arrival first), failed (newest first). */
export function groupOps(ops: SyncOp[]): Record<OpStatus, SyncOp[]> {
  const g: Record<OpStatus, SyncOp[]> = { scheduled: [], sent: [], failed: [] };
  for (const o of ops) g[o.status].push(o);
  g.scheduled.sort((a, b) => a.send_at - b.send_at);
  g.sent.sort((a, b) => (b.arrival ?? b.arrive_at ?? b.send_at) - (a.arrival ?? a.arrive_at ?? a.send_at));
  g.failed.sort((a, b) => b.send_at - a.send_at);
  return g;
}

/** Two of our planned sends that land on the same town within `windowSec` of each other (clash / snipe-risk hint). */
export function opClashes(ops: SyncOp[], windowSec = 1): [string, string][] {
  const out: [string, string][] = [];
  const land = ops.filter((o) => o.status === 'scheduled' && o.arrive_at).sort((a, b) => a.arrive_at! - b.arrive_at!);
  for (let i = 0; i < land.length; i++) for (let j = i + 1; j < land.length && land[j].arrive_at! - land[i].arrive_at! <= windowSec; j++) {
    if (land[i].target_town_id === land[j].target_town_id && land[i].kind !== land[j].kind) out.push([land[i].id, land[j].id]);
  }
  return out;
}
