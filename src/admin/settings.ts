/**
 * Admin panel settings (one JSON document per guild in guild_settings 'admin.settings') and the permission rules.
 * Pure functions only: sanitizing input, defaults, and "may this member see/do X" — shared by the server and tests.
 */
import type { IncomingType } from '../web/syncFeeds.js';

export type TabId = 'troops' | 'alerts' | 'ops';
export type Who = 'all' | 'roles' | 'admins';
export interface Visibility { who: Who; roles: string[] }
export interface Tracker { on: boolean; channelId: string | null }
export interface AdminSettings {
  alerts: { channelId: string | null; roleId: string | null; minSize: number; types: IncomingType[] };
  visibility: Record<TabId, Visibility>;
  colors: { own: string | null; ally: string | null; enemy: string | null };
  /** Alliances that are "us" (overrides the automatic guess); pacts/enemies live in war_sides. */
  ownAlliances: number[];
  live: { pollSeconds: number | null; teams: string[] };
  drawing: { who: Who; roles: string[]; defaultHours: number };
  sync: { requireLink: boolean };
  trackers: { board: Tracker; conquests: Tracker; ghosts: Tracker & { radius: number } };
  linking: { adminChannelId: string | null; unconfirmed: 'full' | 'basic'; allowAnyAlliance: boolean };
  planner: { windowMin: number; timezone: string };
}

export const DEFAULT_SETTINGS: AdminSettings = {
  alerts: { channelId: null, roleId: null, minSize: 0, types: ['attack', 'conquest', 'revolt'] },
  visibility: { troops: { who: 'all', roles: [] }, alerts: { who: 'all', roles: [] }, ops: { who: 'admins', roles: [] } },
  colors: { own: null, ally: null, enemy: null },
  ownAlliances: [],
  live: { pollSeconds: null, teams: [] },
  drawing: { who: 'all', roles: [], defaultHours: 24 },
  sync: { requireLink: false },
  trackers: { board: { on: false, channelId: null }, conquests: { on: false, channelId: null }, ghosts: { on: false, channelId: null, radius: 15 } },
  linking: { adminChannelId: null, unconfirmed: 'full', allowAnyAlliance: false },
  planner: { windowMin: 5, timezone: 'Europe/Athens' },
};

const SNOW = /^\d{5,25}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const snow = (v: unknown): string | null => (typeof v === 'string' && SNOW.test(v) ? v : null);
const snows = (v: unknown, max = 25): string[] => (Array.isArray(v) ? [...new Set(v.map(snow).filter((x): x is string => !!x))].slice(0, max) : []);
const int = (v: unknown, min: number, max: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d);
const who = (v: unknown, d: Who): Who => (v === 'all' || v === 'roles' || v === 'admins' ? v : d);
const color = (v: unknown): string | null => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : null);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const TYPES: IncomingType[] = ['attack', 'support', 'revolt', 'conquest', 'spy', 'other'];

export function validTimezone(tz: unknown): string | null {
  if (typeof tz !== 'string' || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return null; }
}
const tracker = (v: unknown, d: Tracker): Tracker => (isObj(v) ? { on: v.on === true, channelId: snow(v.channelId) } : { ...d });

/** Merge a (partial, untrusted) object over `base`, keeping only known, valid fields. */
export function sanitizeSettings(raw: unknown, base: AdminSettings = DEFAULT_SETTINGS): AdminSettings {
  const r = isObj(raw) ? raw : {};
  const o = structuredClone(base);
  if (isObj(r.alerts)) {
    const a = r.alerts;
    if ('channelId' in a) o.alerts.channelId = snow(a.channelId);
    if ('roleId' in a) o.alerts.roleId = snow(a.roleId);
    if ('minSize' in a) o.alerts.minSize = int(a.minSize, 0, 1_000_000, 0);
    if (Array.isArray(a.types)) o.alerts.types = TYPES.filter((t) => (a.types as unknown[]).includes(t));
  }
  if (isObj(r.visibility)) for (const t of ['troops', 'alerts', 'ops'] as TabId[]) {
    const v = r.visibility[t];
    if (isObj(v)) o.visibility[t] = { who: who(v.who, o.visibility[t].who), roles: 'roles' in v ? snows(v.roles) : o.visibility[t].roles };
  }
  if (isObj(r.colors)) for (const k of ['own', 'ally', 'enemy'] as const) if (k in r.colors) o.colors[k] = color(r.colors[k]);
  if (Array.isArray(r.ownAlliances)) o.ownAlliances = [...new Set(r.ownAlliances.filter((x): x is number => Number.isInteger(x) && (x as number) > 0))].slice(0, 10);
  if (isObj(r.live)) {
    if ('pollSeconds' in r.live) o.live.pollSeconds = r.live.pollSeconds === null ? null : int(r.live.pollSeconds, 3, 120, 5);
    if (Array.isArray(r.live.teams)) o.live.teams = r.live.teams.filter((x): x is string => typeof x === 'string' && /^[\w-]{1,32}$/.test(x)).slice(0, 3);
  }
  if (isObj(r.drawing)) {
    o.drawing.who = who(r.drawing.who, o.drawing.who);
    if ('roles' in r.drawing) o.drawing.roles = snows(r.drawing.roles);
    if ('defaultHours' in r.drawing) o.drawing.defaultHours = [1, 6, 24, 168].includes(Number(r.drawing.defaultHours)) ? Number(r.drawing.defaultHours) : 24;
  }
  if (isObj(r.sync) && 'requireLink' in r.sync) o.sync.requireLink = r.sync.requireLink === true;
  if (isObj(r.trackers)) {
    if ('board' in r.trackers) o.trackers.board = tracker(r.trackers.board, o.trackers.board);
    if ('conquests' in r.trackers) o.trackers.conquests = tracker(r.trackers.conquests, o.trackers.conquests);
    if ('ghosts' in r.trackers) { const g = r.trackers.ghosts; o.trackers.ghosts = { ...tracker(g, o.trackers.ghosts), radius: int(isObj(g) ? g.radius : undefined, 1, 100, o.trackers.ghosts.radius) }; }
  }
  if (isObj(r.linking)) {
    if ('adminChannelId' in r.linking) o.linking.adminChannelId = snow(r.linking.adminChannelId);
    if ('unconfirmed' in r.linking) o.linking.unconfirmed = r.linking.unconfirmed === 'basic' ? 'basic' : 'full';
    if ('allowAnyAlliance' in r.linking) o.linking.allowAnyAlliance = r.linking.allowAnyAlliance === true;
  }
  if (isObj(r.planner)) {
    if ('windowMin' in r.planner) o.planner.windowMin = int(r.planner.windowMin, 0, 120, 5);
    if ('timezone' in r.planner) o.planner.timezone = validTimezone(r.planner.timezone) ?? o.planner.timezone;
  }
  return o;
}

// ---------------------------------------------------------------- permissions
export interface Grant { id: number; kind: 'user' | 'role'; targetId: string; scope: TabId; expiresAt: number | null; createdBy: string; createdAt: number }
export interface Viewer {
  userId: string;
  roles: string[] | null; // null = unknown (Discord not reachable): role rules then deny
  owner: boolean; admin: boolean;
  /** 'confirmed' link, 'pending' /iam claim, or none. */
  link: 'confirmed' | 'pending' | 'none';
  guest: boolean;
}
export const isActive = (g: Grant, now: number) => g.expiresAt === null || g.expiresAt > now;
/** Temporary grant presets (ms); "custom" passes an explicit date. */
export const GRANT_PRESETS = { '1h': 3600_000, '1d': 86400_000, '1w': 7 * 86400_000 } as const;
export function grantExpiry(preset: unknown, custom: unknown, now: number): number | null | 'bad' {
  if (preset === 'perm') return null;
  if (typeof preset === 'string' && preset in GRANT_PRESETS) return now + GRANT_PRESETS[preset as keyof typeof GRANT_PRESETS];
  if (preset === 'custom') {
    const t = typeof custom === 'number' ? custom : typeof custom === 'string' ? Date.parse(custom) : NaN;
    return Number.isFinite(t) && t > now + 60_000 && t < now + 366 * 86400_000 ? t : 'bad';
  }
  return 'bad';
}

/** May this member see a tab? Admins always; guests never; then the tab's rule, then explicit grants. */
export function canSee(tab: TabId, v: Viewer, s: AdminSettings, grants: Grant[], now: number): boolean {
  if (v.guest) return false;
  if (v.owner || v.admin) return true;
  if (v.link === 'pending' && s.linking.unconfirmed === 'basic') return false;
  const rule = s.visibility[tab];
  if (rule.who === 'all') return true;
  if (rule.who === 'roles' && v.roles && rule.roles.some((r) => v.roles!.includes(r))) return true;
  return grants.some((g) => g.scope === tab && isActive(g, now) && ((g.kind === 'user' && g.targetId === v.userId) || (g.kind === 'role' && !!v.roles?.includes(g.targetId))));
}
export function canDraw(v: Viewer, s: AdminSettings): boolean {
  if (v.guest) return false;
  if (v.owner || v.admin) return true;
  if (s.drawing.who === 'all') return true;
  if (s.drawing.who === 'roles') return !!v.roles && s.drawing.roles.some((r) => v.roles!.includes(r));
  return false;
}

/** Admin actions and who may run them: admin-list changes and restore are owner-only. */
export const OWNER_ONLY = new Set(['admins.add', 'admins.remove', 'backup.restore']);
export function mayRun(action: string, v: Pick<Viewer, 'owner' | 'admin'>): boolean {
  if (v.owner) return true;
  return v.admin && !OWNER_ONLY.has(action);
}
export function parseOwners(env: string | undefined): Set<string> {
  return new Set((env ?? '').split(/[\s,]+/).filter((x) => SNOW.test(x)));
}

// ---------------------------------------------------------------- nickname suggestions
const norm = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/** Members whose display name matches a player name (exact after normalizing, or the player name inside "[TAG] Name"). */
export function suggestLinks(members: { userId: string; name: string }[], players: { id: number; name: string }[], taken: Set<number>, linkedUsers: Set<string>): { userId: string; member: string; playerId: number; player: string }[] {
  const byNorm = new Map<string, { id: number; name: string }[]>();
  for (const p of players) { const k = norm(p.name); if (k.length >= 3) byNorm.set(k, [...(byNorm.get(k) ?? []), p]); }
  const out: { userId: string; member: string; playerId: number; player: string }[] = [];
  const used = new Set<number>();
  for (const m of members) {
    if (linkedUsers.has(m.userId)) continue;
    const cands = [m.name, ...m.name.split(/[\s|/\[\]()·\-–]+/)].map(norm).filter((k) => k.length >= 3);
    for (const k of cands) {
      const hit = byNorm.get(k);
      if (hit && hit.length === 1 && !taken.has(hit[0].id) && !used.has(hit[0].id)) { out.push({ userId: m.userId, member: m.name, playerId: hit[0].id, player: hit[0].name }); used.add(hit[0].id); break; }
    }
  }
  return out;
}
