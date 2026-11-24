/**
 * Persistence: SQLite via Node's built-in `node:sqlite` (Node >= 22.13), so there is no native DB module
 * to compile and the whole state is one file (DB_PATH) that is trivial to back up. A private
 * alliance bot writes a few rows per hour; SQLite is plenty. For a large public deployment, swap this
 * module for PostgreSQL (same method surface).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { CachedFile, FileStore } from './data/official.js';
import type { Activity } from './diff.js';
import type { FeedConfig, FeedFilter, FeedType } from './feeds.js';
import type { Lang } from './i18n.js';

export interface GuildConfig { guildId: string; world: string | null; lang: Lang; verifiedRoleId: string | null }
export interface Link { guildId: string; userId: string; world: string; playerId: number; verifiedAt: number }
/** GrepoData City Indexer credentials for one guild. Secrets: never log access/refresh tokens. */
export interface GdTokenRow {
  guildId: string; accessToken: string; refreshToken: string | null; accessExp: number | null; refreshExp: number | null;
  adminUserId: string | null; intelChannelId: string | null; source: 'command' | 'env'; alertStage: number; lastError: string | null; updatedAt: number;
}
export type WarSide = 'ours' | 'enemy';
export interface Board { id: number; guildId: string; channelId: string; messageId: string | null; world: string; createdBy: string | null; updatedAt: number | null; lastError: string | null }
export interface Baseline { id: number; points: number; abp: number; dbp: number; towns: number; ts: number }
export type ThreatScope = 'enemies' | 'all';
export interface ThreatSubRow { guildId: string; userId: string; radius: number; minBp: number; scope: ThreatScope; createdAt: number; lastAlertAt: number | null }
export type OpStatus = 'open' | 'done' | 'cancelled';
export interface Op { id: number; guildId: string; world: string; name: string | null; targetTownId: number; landAt: number; creatorId: string; channelId: string | null; status: OpStatus; createdAt: number }
export interface OpMods { meteorology?: boolean; cartography?: boolean; lighthouse?: boolean; boost?: number; transport?: string }
export interface OpMember {
  opId: number; userId: string; originTownId: number; unit: string; travelSecs: number; estimated: boolean; uncertainty: number;
  sendAt: number; mods: OpMods; assignedBy: string | null; notified: boolean; reminded: boolean;
}
export interface PendingVerification { guildId: string; userId: string; world: string; playerId: number; code: string; createdAt: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS guild_config (guild_id TEXT PRIMARY KEY, world TEXT, lang TEXT NOT NULL DEFAULT 'en', verified_role_id TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS alliance_roles (guild_id TEXT NOT NULL, alliance_id INTEGER NOT NULL, role_id TEXT NOT NULL, PRIMARY KEY (guild_id, alliance_id));
CREATE TABLE IF NOT EXISTS feeds (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, world TEXT NOT NULL, type TEXT NOT NULL, filter_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER);
CREATE INDEX IF NOT EXISTS feeds_world ON feeds(world);
CREATE TABLE IF NOT EXISTS links (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, world TEXT NOT NULL, player_id INTEGER NOT NULL, verified_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
CREATE TABLE IF NOT EXISTS pending_verifications (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, world TEXT NOT NULL, player_id INTEGER NOT NULL, code TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
CREATE TABLE IF NOT EXISTS world_state (world TEXT PRIMARY KEY, last_conquest_time INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS file_cache (world TEXT NOT NULL, file TEXT NOT NULL, etag TEXT, last_modified TEXT, body BLOB NOT NULL, fetched_at INTEGER, PRIMARY KEY (world, file));
CREATE TABLE IF NOT EXISTS gd_tokens (guild_id TEXT PRIMARY KEY, access_token TEXT NOT NULL, refresh_token TEXT, access_exp INTEGER, refresh_exp INTEGER, admin_user_id TEXT, intel_channel_id TEXT, source TEXT NOT NULL DEFAULT 'command', alert_stage INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS activity (world TEXT NOT NULL, player_id INTEGER NOT NULL, points INTEGER, abp INTEGER, dbp INTEGER, towns INTEGER, last_change_at INTEGER, first_seen_at INTEGER, PRIMARY KEY (world, player_id));
-- v1.2 (batch 1): war room, threat alerts, op planner. Additive only: existing tables/data are untouched.
CREATE TABLE IF NOT EXISTS war_sides (guild_id TEXT NOT NULL, world TEXT NOT NULL, alliance_id INTEGER NOT NULL, side TEXT NOT NULL, PRIMARY KEY (guild_id, world, alliance_id));
CREATE TABLE IF NOT EXISTS boards (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, world TEXT NOT NULL, created_by TEXT, created_at INTEGER, updated_at INTEGER, last_error TEXT);
CREATE TABLE IF NOT EXISTS baselines (world TEXT NOT NULL, kind TEXT NOT NULL, id INTEGER NOT NULL, points INTEGER, abp INTEGER, dbp INTEGER, towns INTEGER, ts INTEGER NOT NULL, PRIMARY KEY (world, kind, id));
CREATE TABLE IF NOT EXISTS threat_subs (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, radius INTEGER NOT NULL DEFAULT 10, min_bp INTEGER NOT NULL DEFAULT 3000, scope TEXT NOT NULL DEFAULT 'enemies', created_at INTEGER, last_alert_at INTEGER, PRIMARY KEY (guild_id, user_id));
CREATE TABLE IF NOT EXISTS ops (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, world TEXT NOT NULL, name TEXT, target_town_id INTEGER NOT NULL, land_at INTEGER NOT NULL, creator_id TEXT NOT NULL, channel_id TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER);
CREATE TABLE IF NOT EXISTS op_members (op_id INTEGER NOT NULL, user_id TEXT NOT NULL, origin_town_id INTEGER NOT NULL, unit TEXT NOT NULL, travel_secs INTEGER NOT NULL, estimated INTEGER NOT NULL, uncertainty INTEGER NOT NULL DEFAULT 0, send_at INTEGER NOT NULL, mods_json TEXT NOT NULL DEFAULT '{}', assigned_by TEXT, notified INTEGER NOT NULL DEFAULT 0, reminded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (op_id, user_id, origin_town_id));
CREATE INDEX IF NOT EXISTS op_members_send ON op_members(reminded, send_at);
`;

export class Store implements FileStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  // ---- guild config
  getGuild(guildId: string, defaultLang: Lang = 'en'): GuildConfig {
    const r = this.db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId) as Record<string, unknown> | undefined;
    return r
      ? { guildId, world: (r.world as string) ?? null, lang: (r.lang as Lang) ?? defaultLang, verifiedRoleId: (r.verified_role_id as string) ?? null }
      : { guildId, world: null, lang: defaultLang, verifiedRoleId: null };
  }
  setGuild(g: GuildConfig) {
    this.db.prepare(`INSERT INTO guild_config (guild_id, world, lang, verified_role_id, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET world=excluded.world, lang=excluded.lang, verified_role_id=excluded.verified_role_id, updated_at=excluded.updated_at`)
      .run(g.guildId, g.world, g.lang, g.verifiedRoleId, Date.now());
  }
  allGuilds(): GuildConfig[] {
    return (this.db.prepare('SELECT guild_id FROM guild_config').all() as { guild_id: string }[]).map((r) => this.getGuild(r.guild_id));
  }

  // ---- alliance roles
  getAllianceRoles(guildId: string): Map<number, string> {
    const rows = this.db.prepare('SELECT alliance_id, role_id FROM alliance_roles WHERE guild_id = ?').all(guildId) as { alliance_id: number; role_id: string }[];
    return new Map(rows.map((r) => [Number(r.alliance_id), r.role_id]));
  }
  setAllianceRole(guildId: string, allianceId: number, roleId: string) {
    this.db.prepare('INSERT INTO alliance_roles (guild_id, alliance_id, role_id) VALUES (?, ?, ?) ON CONFLICT(guild_id, alliance_id) DO UPDATE SET role_id=excluded.role_id').run(guildId, allianceId, roleId);
  }
  removeAllianceRole(guildId: string, allianceId: number): boolean {
    return Number(this.db.prepare('DELETE FROM alliance_roles WHERE guild_id = ? AND alliance_id = ?').run(guildId, allianceId).changes) > 0;
  }
  clearAllianceRoles(guildId: string) { this.db.prepare('DELETE FROM alliance_roles WHERE guild_id = ?').run(guildId); }

  // ---- feeds
  addFeed(f: Omit<FeedConfig, 'id'>): number {
    const r = this.db.prepare('INSERT INTO feeds (guild_id, channel_id, world, type, filter_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.guildId, f.channelId, f.world, f.type, JSON.stringify(f.filter), Date.now());
    return Number(r.lastInsertRowid);
  }
  removeFeed(guildId: string, id: number): boolean {
    return Number(this.db.prepare('DELETE FROM feeds WHERE guild_id = ? AND id = ?').run(guildId, id).changes) > 0;
  }
  private rowToFeed = (r: Record<string, unknown>): FeedConfig => ({
    id: Number(r.id), guildId: String(r.guild_id), channelId: String(r.channel_id), world: String(r.world), type: r.type as FeedType,
    filter: JSON.parse(String(r.filter_json || '{}')) as FeedFilter,
  });
  feedsForGuild(guildId: string): FeedConfig[] {
    return (this.db.prepare('SELECT * FROM feeds WHERE guild_id = ? ORDER BY id').all(guildId) as Record<string, unknown>[]).map(this.rowToFeed);
  }
  feedsForWorld(world: string): FeedConfig[] {
    return (this.db.prepare('SELECT * FROM feeds WHERE world = ? ORDER BY id').all(world) as Record<string, unknown>[]).map(this.rowToFeed);
  }

  /** Worlds the bot must keep fresh: guild default worlds + feed worlds + linked worlds. */
  trackedWorlds(): string[] {
    const rows = this.db.prepare(`SELECT world FROM guild_config WHERE world IS NOT NULL UNION SELECT world FROM feeds UNION SELECT world FROM links UNION SELECT world FROM pending_verifications UNION SELECT world FROM boards UNION SELECT world FROM ops WHERE status = 'open'`).all() as { world: string }[];
    return [...new Set(rows.map((r) => r.world))].sort();
  }

  // ---- links & verification
  getLink(guildId: string, userId: string): Link | null {
    const r = this.db.prepare('SELECT * FROM links WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as Record<string, unknown> | undefined;
    return r ? { guildId, userId, world: String(r.world), playerId: Number(r.player_id), verifiedAt: Number(r.verified_at) } : null;
  }
  linkForPlayer(guildId: string, world: string, playerId: number): Link | null {
    const r = this.db.prepare('SELECT * FROM links WHERE guild_id = ? AND world = ? AND player_id = ?').get(guildId, world, playerId) as Record<string, unknown> | undefined;
    return r ? { guildId, userId: String(r.user_id), world, playerId, verifiedAt: Number(r.verified_at) } : null;
  }
  linksForGuild(guildId: string): Link[] {
    return (this.db.prepare('SELECT * FROM links WHERE guild_id = ?').all(guildId) as Record<string, unknown>[])
      .map((r) => ({ guildId, userId: String(r.user_id), world: String(r.world), playerId: Number(r.player_id), verifiedAt: Number(r.verified_at) }));
  }
  setLink(l: Link) {
    this.db.prepare('INSERT INTO links (guild_id, user_id, world, player_id, verified_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET world=excluded.world, player_id=excluded.player_id, verified_at=excluded.verified_at')
      .run(l.guildId, l.userId, l.world, l.playerId, l.verifiedAt);
  }
  removeLink(guildId: string, userId: string): boolean {
    return Number(this.db.prepare('DELETE FROM links WHERE guild_id = ? AND user_id = ?').run(guildId, userId).changes) > 0;
  }
  getPending(guildId: string, userId: string): PendingVerification | null {
    const r = this.db.prepare('SELECT * FROM pending_verifications WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as Record<string, unknown> | undefined;
    return r ? { guildId, userId, world: String(r.world), playerId: Number(r.player_id), code: String(r.code), createdAt: Number(r.created_at) } : null;
  }
  allPending(): PendingVerification[] {
    return (this.db.prepare('SELECT * FROM pending_verifications').all() as Record<string, unknown>[]).map((r) => ({
      guildId: String(r.guild_id), userId: String(r.user_id), world: String(r.world), playerId: Number(r.player_id), code: String(r.code), createdAt: Number(r.created_at),
    }));
  }
  setPending(p: PendingVerification) {
    this.db.prepare('INSERT INTO pending_verifications (guild_id, user_id, world, player_id, code, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET world=excluded.world, player_id=excluded.player_id, code=excluded.code, created_at=excluded.created_at')
      .run(p.guildId, p.userId, p.world, p.playerId, p.code, p.createdAt);
  }
  removePending(guildId: string, userId: string) { this.db.prepare('DELETE FROM pending_verifications WHERE guild_id = ? AND user_id = ?').run(guildId, userId); }

  // ---- world state
  getLastConquestTime(world: string): number | null {
    const r = this.db.prepare('SELECT last_conquest_time FROM world_state WHERE world = ?').get(world) as { last_conquest_time: number } | undefined;
    return r ? Number(r.last_conquest_time) : null;
  }
  setLastConquestTime(world: string, t: number) {
    this.db.prepare('INSERT INTO world_state (world, last_conquest_time, updated_at) VALUES (?, ?, ?) ON CONFLICT(world) DO UPDATE SET last_conquest_time=excluded.last_conquest_time, updated_at=excluded.updated_at').run(world, t, Date.now());
  }

  // ---- file cache (FileStore)
  getFile(world: string, file: string): CachedFile | null {
    const r = this.db.prepare('SELECT * FROM file_cache WHERE world = ? AND file = ?').get(world, file) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { etag: (r.etag as string) ?? null, lastModified: (r.last_modified as string) ?? null, body: gunzipSync(r.body as Uint8Array).toString('utf8'), fetchedAt: Number(r.fetched_at) };
  }
  putFile(world: string, file: string, f: CachedFile) {
    this.db.prepare('INSERT INTO file_cache (world, file, etag, last_modified, body, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(world, file) DO UPDATE SET etag=excluded.etag, last_modified=excluded.last_modified, body=excluded.body, fetched_at=excluded.fetched_at')
      .run(world, file, f.etag, f.lastModified, gzipSync(f.body), f.fetchedAt);
  }

  // ---- activity
  getActivity(world: string): Map<number, Activity> {
    const rows = this.db.prepare('SELECT * FROM activity WHERE world = ?').all(world) as Record<string, number>[];
    return new Map(rows.map((r) => [Number(r.player_id), {
      playerId: Number(r.player_id), points: Number(r.points), abp: Number(r.abp), dbp: Number(r.dbp), towns: Number(r.towns),
      lastChangeAt: Number(r.last_change_at), firstSeenAt: Number(r.first_seen_at),
    }]));
  }
  replaceActivity(world: string, a: Map<number, Activity>) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM activity WHERE world = ?').run(world);
      const ins = this.db.prepare('INSERT INTO activity (world, player_id, points, abp, dbp, towns, last_change_at, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const x of a.values()) ins.run(world, x.playerId, x.points, x.abp, x.dbp, x.towns, x.lastChangeAt, x.firstSeenAt);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ---- GrepoData tokens (per guild)
  getGdToken(guildId: string): GdTokenRow | null {
    const r = this.db.prepare('SELECT * FROM gd_tokens WHERE guild_id = ?').get(guildId) as Record<string, unknown> | undefined;
    return r ? this.rowToToken(r) : null;
  }
  allGdTokens(): GdTokenRow[] {
    return (this.db.prepare('SELECT * FROM gd_tokens').all() as Record<string, unknown>[]).map(this.rowToToken);
  }
  private rowToToken = (r: Record<string, unknown>): GdTokenRow => ({
    guildId: String(r.guild_id), accessToken: String(r.access_token), refreshToken: (r.refresh_token as string) ?? null,
    accessExp: r.access_exp == null ? null : Number(r.access_exp), refreshExp: r.refresh_exp == null ? null : Number(r.refresh_exp),
    adminUserId: (r.admin_user_id as string) ?? null, intelChannelId: (r.intel_channel_id as string) ?? null,
    source: r.source === 'env' ? 'env' : 'command', alertStage: Number(r.alert_stage ?? 0), lastError: (r.last_error as string) ?? null, updatedAt: Number(r.updated_at ?? 0),
  });
  /** Insert or replace the token pair; keeps the intel channel; resets alert state. */
  setGdToken(t: { guildId: string; accessToken: string; refreshToken: string | null; accessExp: number | null; refreshExp: number | null; adminUserId: string | null; source: 'command' | 'env' }) {
    this.db.prepare(`INSERT INTO gd_tokens (guild_id, access_token, refresh_token, access_exp, refresh_exp, admin_user_id, source, alert_stage, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
      ON CONFLICT(guild_id) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token, access_exp=excluded.access_exp,
        refresh_exp=excluded.refresh_exp, admin_user_id=COALESCE(excluded.admin_user_id, gd_tokens.admin_user_id), source=excluded.source,
        alert_stage=0, last_error=NULL, updated_at=excluded.updated_at`)
      .run(t.guildId, t.accessToken, t.refreshToken, t.accessExp, t.refreshExp, t.adminUserId, t.source, Date.now());
  }
  setGdIntelChannel(guildId: string, channelId: string | null): boolean {
    return Number(this.db.prepare('UPDATE gd_tokens SET intel_channel_id = ? WHERE guild_id = ?').run(channelId, guildId).changes) > 0;
  }
  setGdAlert(guildId: string, stage: number, lastError: string | null = null) {
    this.db.prepare('UPDATE gd_tokens SET alert_stage = ?, last_error = ? WHERE guild_id = ?').run(stage, lastError, guildId);
  }
  clearGdToken(guildId: string): boolean {
    return Number(this.db.prepare('DELETE FROM gd_tokens WHERE guild_id = ?').run(guildId).changes) > 0;
  }

  // ---- war room sides (our alliances / enemy alliances), per guild + world
  getWarSides(guildId: string, world: string): { ours: number[]; enemies: number[] } {
    const rows = this.db.prepare('SELECT alliance_id, side FROM war_sides WHERE guild_id = ? AND world = ? ORDER BY alliance_id').all(guildId, world) as { alliance_id: number; side: string }[];
    return { ours: rows.filter((r) => r.side === 'ours').map((r) => Number(r.alliance_id)), enemies: rows.filter((r) => r.side === 'enemy').map((r) => Number(r.alliance_id)) };
  }
  setWarSide(guildId: string, world: string, allianceId: number, side: WarSide) {
    this.db.prepare('INSERT INTO war_sides (guild_id, world, alliance_id, side) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, world, alliance_id) DO UPDATE SET side=excluded.side').run(guildId, world, allianceId, side);
  }
  removeWarSide(guildId: string, world: string, allianceId: number): boolean {
    return Number(this.db.prepare('DELETE FROM war_sides WHERE guild_id = ? AND world = ? AND alliance_id = ?').run(guildId, world, allianceId).changes) > 0;
  }

  // ---- war-room boards
  private rowToBoard = (r: Record<string, unknown>): Board => ({
    id: Number(r.id), guildId: String(r.guild_id), channelId: String(r.channel_id), messageId: (r.message_id as string) ?? null, world: String(r.world),
    createdBy: (r.created_by as string) ?? null, updatedAt: r.updated_at == null ? null : Number(r.updated_at), lastError: (r.last_error as string) ?? null,
  });
  addBoard(b: { guildId: string; channelId: string; world: string; createdBy: string }): number {
    return Number(this.db.prepare('INSERT INTO boards (guild_id, channel_id, world, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(b.guildId, b.channelId, b.world, b.createdBy, Date.now()).lastInsertRowid);
  }
  getBoard(guildId: string, id: number): Board | null {
    const r = this.db.prepare('SELECT * FROM boards WHERE guild_id = ? AND id = ?').get(guildId, id) as Record<string, unknown> | undefined;
    return r ? this.rowToBoard(r) : null;
  }
  boardsForGuild(guildId: string): Board[] { return (this.db.prepare('SELECT * FROM boards WHERE guild_id = ? ORDER BY id').all(guildId) as Record<string, unknown>[]).map(this.rowToBoard); }
  boardsForWorld(world: string): Board[] { return (this.db.prepare('SELECT * FROM boards WHERE world = ? ORDER BY id').all(world) as Record<string, unknown>[]).map(this.rowToBoard); }
  setBoardMessage(id: number, messageId: string | null, error: string | null = null) {
    this.db.prepare('UPDATE boards SET message_id = COALESCE(?, message_id), updated_at = ?, last_error = ? WHERE id = ?').run(messageId, Date.now(), error, id);
  }
  removeBoard(guildId: string, id: number): boolean { return Number(this.db.prepare('DELETE FROM boards WHERE guild_id = ? AND id = ?').run(guildId, id).changes) > 0; }

  // ---- 24h baselines (top movers); kind 'p' = player, 'a' = alliance
  getBaselines(world: string, kind: 'p' | 'a'): Map<number, Baseline> {
    const rows = this.db.prepare('SELECT * FROM baselines WHERE world = ? AND kind = ?').all(world, kind) as Record<string, number>[];
    return new Map(rows.map((r) => [Number(r.id), { id: Number(r.id), points: Number(r.points), abp: Number(r.abp), dbp: Number(r.dbp), towns: Number(r.towns), ts: Number(r.ts) }]));
  }
  replaceBaselines(world: string, kind: 'p' | 'a', rows: Baseline[]) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM baselines WHERE world = ? AND kind = ?').run(world, kind);
      const ins = this.db.prepare('INSERT INTO baselines (world, kind, id, points, abp, dbp, towns, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const b of rows) ins.run(world, kind, b.id, b.points, b.abp, b.dbp, b.towns, b.ts);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ---- personal threat alerts
  private rowToSub = (r: Record<string, unknown>): ThreatSubRow => ({
    guildId: String(r.guild_id), userId: String(r.user_id), radius: Number(r.radius), minBp: Number(r.min_bp), scope: r.scope === 'all' ? 'all' : 'enemies',
    createdAt: Number(r.created_at ?? 0), lastAlertAt: r.last_alert_at == null ? null : Number(r.last_alert_at),
  });
  setThreatSub(s: { guildId: string; userId: string; radius: number; minBp: number; scope: ThreatScope }) {
    this.db.prepare(`INSERT INTO threat_subs (guild_id, user_id, radius, min_bp, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET radius=excluded.radius, min_bp=excluded.min_bp, scope=excluded.scope`).run(s.guildId, s.userId, s.radius, s.minBp, s.scope, Date.now());
  }
  getThreatSub(guildId: string, userId: string): ThreatSubRow | null {
    const r = this.db.prepare('SELECT * FROM threat_subs WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as Record<string, unknown> | undefined;
    return r ? this.rowToSub(r) : null;
  }
  allThreatSubs(): ThreatSubRow[] { return (this.db.prepare('SELECT * FROM threat_subs').all() as Record<string, unknown>[]).map(this.rowToSub); }
  removeThreatSub(guildId: string, userId: string): boolean { return Number(this.db.prepare('DELETE FROM threat_subs WHERE guild_id = ? AND user_id = ?').run(guildId, userId).changes) > 0; }
  markThreatAlert(guildId: string, userId: string, at: number) { this.db.prepare('UPDATE threat_subs SET last_alert_at = ? WHERE guild_id = ? AND user_id = ?').run(at, guildId, userId); }

  // ---- op planner
  private rowToOp = (r: Record<string, unknown>): Op => ({
    id: Number(r.id), guildId: String(r.guild_id), world: String(r.world), name: (r.name as string) ?? null, targetTownId: Number(r.target_town_id), landAt: Number(r.land_at),
    creatorId: String(r.creator_id), channelId: (r.channel_id as string) ?? null, status: (r.status as OpStatus) ?? 'open', createdAt: Number(r.created_at ?? 0),
  });
  private rowToMember = (r: Record<string, unknown>): OpMember => ({
    opId: Number(r.op_id), userId: String(r.user_id), originTownId: Number(r.origin_town_id), unit: String(r.unit), travelSecs: Number(r.travel_secs),
    estimated: Number(r.estimated) === 1, uncertainty: Number(r.uncertainty ?? 0), sendAt: Number(r.send_at), mods: JSON.parse(String(r.mods_json || '{}')) as OpMods,
    assignedBy: (r.assigned_by as string) ?? null, notified: Number(r.notified) === 1, reminded: Number(r.reminded) === 1,
  });
  addOp(o: { guildId: string; world: string; name: string | null; targetTownId: number; landAt: number; creatorId: string; channelId: string | null }): number {
    return Number(this.db.prepare('INSERT INTO ops (guild_id, world, name, target_town_id, land_at, creator_id, channel_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'open\', ?)')
      .run(o.guildId, o.world, o.name, o.targetTownId, o.landAt, o.creatorId, o.channelId, Date.now()).lastInsertRowid);
  }
  getOp(guildId: string, id: number): Op | null {
    const r = this.db.prepare('SELECT * FROM ops WHERE guild_id = ? AND id = ?').get(guildId, id) as Record<string, unknown> | undefined;
    return r ? this.rowToOp(r) : null;
  }
  opsForGuild(guildId: string, status: OpStatus | null = 'open'): Op[] {
    const rows = status ? this.db.prepare('SELECT * FROM ops WHERE guild_id = ? AND status = ? ORDER BY land_at').all(guildId, status) : this.db.prepare('SELECT * FROM ops WHERE guild_id = ? ORDER BY id DESC LIMIT 25').all(guildId);
    return (rows as Record<string, unknown>[]).map(this.rowToOp);
  }
  setOpStatus(id: number, status: OpStatus) { this.db.prepare('UPDATE ops SET status = ? WHERE id = ?').run(status, id); }
  /** Open ops whose landing time is older than `before` (epoch s). */
  staleOps(before: number): Op[] { return (this.db.prepare('SELECT * FROM ops WHERE status = \'open\' AND land_at < ?').all(before) as Record<string, unknown>[]).map(this.rowToOp); }
  upsertOpMember(m: Omit<OpMember, 'notified' | 'reminded'>) {
    this.db.prepare(`INSERT INTO op_members (op_id, user_id, origin_town_id, unit, travel_secs, estimated, uncertainty, send_at, mods_json, assigned_by, notified, reminded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
      ON CONFLICT(op_id, user_id, origin_town_id) DO UPDATE SET unit=excluded.unit, travel_secs=excluded.travel_secs, estimated=excluded.estimated, uncertainty=excluded.uncertainty,
        send_at=excluded.send_at, mods_json=excluded.mods_json, assigned_by=excluded.assigned_by, notified=0, reminded=0`)
      .run(m.opId, m.userId, m.originTownId, m.unit, m.travelSecs, m.estimated ? 1 : 0, m.uncertainty, m.sendAt, JSON.stringify(m.mods), m.assignedBy);
  }
  opMembers(opId: number): OpMember[] { return (this.db.prepare('SELECT * FROM op_members WHERE op_id = ? ORDER BY send_at').all(opId) as Record<string, unknown>[]).map(this.rowToMember); }
  removeOpMember(opId: number, userId: string, originTownId?: number): number {
    const r = originTownId == null
      ? this.db.prepare('DELETE FROM op_members WHERE op_id = ? AND user_id = ?').run(opId, userId)
      : this.db.prepare('DELETE FROM op_members WHERE op_id = ? AND user_id = ? AND origin_town_id = ?').run(opId, userId, originTownId);
    return Number(r.changes);
  }
  markOpMember(opId: number, userId: string, originTownId: number, field: 'notified' | 'reminded') {
    this.db.prepare(`UPDATE op_members SET ${field === 'notified' ? 'notified' : 'reminded'} = 1 WHERE op_id = ? AND user_id = ? AND origin_town_id = ?`).run(opId, userId, originTownId);
  }
  /** Members of open ops whose send time is within `leadSec` (and not more than `graceSec` in the past), not yet reminded. */
  dueReminders(now: number, leadSec: number, graceSec = 120): (OpMember & { guildId: string })[] {
    const rows = this.db.prepare(`SELECT m.*, o.guild_id AS g FROM op_members m JOIN ops o ON o.id = m.op_id
      WHERE o.status = 'open' AND m.reminded = 0 AND m.send_at <= ? AND m.send_at >= ?`).all(now + leadSec, now - graceSec) as Record<string, unknown>[];
    return rows.map((r) => ({ ...this.rowToMember(r), guildId: String(r.g) }));
  }
}
