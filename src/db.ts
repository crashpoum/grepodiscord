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
CREATE TABLE IF NOT EXISTS activity (world TEXT NOT NULL, player_id INTEGER NOT NULL, points INTEGER, abp INTEGER, dbp INTEGER, towns INTEGER, last_change_at INTEGER, first_seen_at INTEGER, PRIMARY KEY (world, player_id));
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
    const rows = this.db.prepare(`SELECT world FROM guild_config WHERE world IS NOT NULL UNION SELECT world FROM feeds UNION SELECT world FROM links UNION SELECT world FROM pending_verifications`).all() as { world: string }[];
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
}
