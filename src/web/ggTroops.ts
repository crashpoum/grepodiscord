/**
 * Data-sync service (troops): key lookup (hashed), rate limit, validate, store latest snapshot.
 * The POST/DELETE /api/gg/troops route is unauthenticated by Discord session — only the per-user bearer key.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from '../db.js';
import { isValidWorldId } from '../data/official.js';
import { GG_KEY_PREFIX, GG_LIMITS, looksLikeGgKey, validatePayload, type GgPlayerSnap, type GgTown } from './ggCore.js';
import { validateIncoming, validateOps, type FeedKind, type IncomingCmd, type SyncOp } from './syncFeeds.js';

export interface FeedPlayer<T> { playerId: number; playerName: string; mine: boolean; ts: number; recvAt: number; items: T[] }
/** Hooks from the admin settings: require a linked player before data is accepted; new incoming commands (alerts). */
export interface SyncHooks {
  requireLink?: (guildId: string, userId: string) => boolean;
  onIncoming?: (e: { guildId: string; world: string; userId: string; playerId: number; playerName: string; cmds: IncomingCmd[] }) => void;
}

export function newGgKey(): string { return GG_KEY_PREFIX + randomBytes(24).toString('base64url'); }
export function hashGgKey(key: string): string { return 'sha256:' + createHash('sha256').update(key).digest('hex'); }

/** CORS: only official Grepolis HTTPS origins (world hosts like gr125.grepolis.com, www, beta). */
export function grepolisOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:' || u.origin !== origin) return null;
    const h = u.hostname.toLowerCase();
    if (h === 'grepolis.com' || (h.endsWith('.grepolis.com') && h.length > '.grepolis.com'.length)) return u.origin;
  } catch { /* invalid */ }
  return null;
}
export function ggCorsHeaders(originHeader: string | undefined): { allow: boolean; headers: Record<string, string> } {
  const origin = grepolisOrigin(originHeader);
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    headers['Access-Control-Max-Age'] = '86400';
  }
  return { allow: !originHeader || !!origin, headers };
}

export class GgService {
  private writes = new Map<string, number>();
  constructor(private store: Store, private now: () => number = Date.now, public hooks: SyncHooks = {}) {}

  issue(guildId: string, userId: string, playerId: number | null): { key: string; rotated: boolean } {
    const rotated = !!this.store.getGgKeyByUser(guildId, userId);
    const key = newGgKey();
    this.store.upsertGgKey({ keyHash: hashGgKey(key), guildId, userId, playerId, createdAt: this.now() });
    return { key, rotated };
  }
  unlink(guildId: string, userId: string): { hadKey: boolean; removed: number } {
    const hadKey = this.store.deleteGgKey(guildId, userId);
    const removed = this.store.deleteGgTroopsForUser(guildId, userId) + this.store.deleteFeedsForUser(guildId, userId);
    return { hadKey, removed };
  }

  /** Seconds until this key may write again (for the 429 Retry-After header). */
  retryAfter(k: string): number { return Math.max(1, Math.ceil((GG_LIMITS.rateMs - (this.now() - (this.writes.get(k) ?? 0))) / 1000)); }
  private rateOk(keyHash: string): boolean {
    const n = this.now(), last = this.writes.get(keyHash) ?? 0;
    if (n - last < GG_LIMITS.rateMs) return false;
    this.writes.set(keyHash, n);
    if (this.writes.size > 5000) {
      for (const [k, t] of this.writes) if (n - t > 60_000) this.writes.delete(k);
    }
    return true;
  }

  /**
   * POST a snapshot. `worldOk` is the guild's configured world (must match the body).
   * `boundPlayer` is the verified (or previously stored) player id, if any — a mismatch is rejected.
   */
  post(key: string | null, body: unknown): { status: number; body: Record<string, unknown> } {
    if (!key || !looksLikeGgKey(key)) return { status: 401, body: { error: 'unauthorized' } };
    const row = this.store.getGgKeyByHash(hashGgKey(key));
    if (!row) return { status: 401, body: { error: 'unauthorized' } };
    const expect = this.store.getGuild(row.guildId).world;
    const v = validatePayload(body, this.now(), (w) => !!expect && w === expect && isValidWorldId(w));
    if (!v.ok) return { status: v.err === 'tooLarge' ? 413 : 400, body: { error: v.err } };
    const link = this.store.getLink(row.guildId, row.userId);
    const bound = row.playerId ?? (link && link.world === v.p.world ? link.playerId : null);
    if (bound !== null && bound !== v.p.player_id) return { status: 400, body: { error: 'player' } };
    if (this.hooks.requireLink?.(row.guildId, row.userId)) return { status: 403, body: { error: 'link' } };
    if (!this.rateOk(row.keyHash)) return { status: 429, body: { error: 'rate', retry_after: this.retryAfter(row.keyHash) } };
    if (row.playerId === null) this.store.setGgKeyPlayer(row.keyHash, v.p.player_id);
    this.store.putGgTroops({
      guildId: row.guildId, world: v.p.world, playerId: v.p.player_id, playerName: v.p.player_name,
      userId: row.userId, ts: v.p.ts, recvAt: this.now(), townsJson: JSON.stringify(v.p.towns),
    });
    return { status: 200, body: { ok: true, towns: v.p.towns.length } };
  }

  remove(key: string | null, kind: 'troops' | FeedKind = 'troops'): { status: number; body: Record<string, unknown> } {
    if (!key || !looksLikeGgKey(key)) return { status: 401, body: { error: 'unauthorized' } };
    const row = this.store.getGgKeyByHash(hashGgKey(key));
    if (!row) return { status: 401, body: { error: 'unauthorized' } };
    const n = kind === 'troops' ? this.store.deleteGgTroopsForUser(row.guildId, row.userId) : this.store.deleteFeedsForUser(row.guildId, row.userId, kind);
    return { status: 200, body: { ok: true, removed: n } };
  }

  /**
   * POST the full incoming-command list or the full planned-sends list. Same key, binding, world check and opt-out as
   * troops; its own 15 s write limit per endpoint. The new list replaces the previous one.
   */
  postFeed(kind: FeedKind, key: string | null, body: unknown): { status: number; body: Record<string, unknown> } {
    if (!key || !looksLikeGgKey(key)) return { status: 401, body: { error: 'unauthorized' } };
    const row = this.store.getGgKeyByHash(hashGgKey(key));
    if (!row) return { status: 401, body: { error: 'unauthorized' } };
    const expect = this.store.getGuild(row.guildId).world;
    const worldOk = (w: string) => !!expect && w === expect && isValidWorldId(w);
    const v = kind === 'incoming' ? validateIncoming(body, this.now(), worldOk) : validateOps(body, this.now(), worldOk);
    if (!v.ok) return { status: v.err === 'tooLarge' ? 413 : 400, body: { error: v.err } };
    const link = this.store.getLink(row.guildId, row.userId);
    const bound = row.playerId ?? (link && link.world === v.h.world ? link.playerId : null);
    if (bound !== null && bound !== v.h.player_id) return { status: 400, body: { error: 'player' } };
    if (this.hooks.requireLink?.(row.guildId, row.userId)) return { status: 403, body: { error: 'link' } };
    if (!this.rateOk(`${kind}:${row.keyHash}`)) return { status: 429, body: { error: 'rate', retry_after: this.retryAfter(`${kind}:${row.keyHash}`) } };
    if (row.playerId === null) this.store.setGgKeyPlayer(row.keyHash, v.h.player_id);
    this.store.putFeed({ guildId: row.guildId, world: v.h.world, kind, playerId: v.h.player_id, playerName: v.h.player_name, userId: row.userId, ts: v.h.ts, recvAt: this.now(), itemsJson: JSON.stringify(v.items) });
    if (kind === 'incoming' && v.items.length) {
      try { this.hooks.onIncoming?.({ guildId: row.guildId, world: v.h.world, userId: row.userId, playerId: v.h.player_id, playerName: v.h.player_name, cmds: v.items as IncomingCmd[] }); } catch { /* alerts never fail the write */ }
    }
    return { status: 200, body: { ok: true, [kind === 'incoming' ? 'cmds' : 'ops']: v.items.length, skipped: v.skipped } };
  }

  feedView<T extends IncomingCmd | SyncOp>(kind: FeedKind, guildId: string, world: string, userId: string): { players: FeedPlayer<T>[]; serverNow: number } {
    const players: FeedPlayer<T>[] = [];
    for (const r of this.store.listFeeds(guildId, world, kind)) {
      let items: T[] = [];
      try { const x = JSON.parse(r.itemsJson); if (Array.isArray(x)) items = x as T[]; } catch { items = []; }
      players.push({ playerId: r.playerId, playerName: r.playerName, mine: r.userId === userId, ts: r.ts, recvAt: r.recvAt, items });
    }
    return { players, serverNow: this.now() };
  }

  view(guildId: string, world: string, userId: string): { players: GgPlayerSnap[]; serverNow: number } {
    const players: GgPlayerSnap[] = [];
    for (const r of this.store.listGgTroops(guildId, world)) {
      let towns: GgTown[] = [];
      try { const x = JSON.parse(r.townsJson); if (Array.isArray(x)) towns = x as GgTown[]; } catch { towns = []; }
      players.push({ playerId: r.playerId, playerName: r.playerName, mine: r.userId === userId, ts: r.ts, recvAt: r.recvAt, towns });
    }
    return { players, serverNow: this.now() };
  }
}

export async function readGgBody(req: IncomingMessage, max = GG_LIMITS.body): Promise<{ ok: true; body: unknown } | { ok: false; status: 413 | 400 }> {
  const len = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(len) && len > max) return { ok: false, status: 413 };
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > max) { req.destroy(); return { ok: false, status: 413 }; }
      chunks.push(c as Buffer);
    }
  } catch { return { ok: false, status: 400 }; }
  if (!chunks.length) return { ok: true, body: {} };
  try { return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; } catch { return { ok: false, status: 400 }; }
}

/** Write a JSON response and attach CORS headers (already computed). */
export function ggSend(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    ...extra,
  });
  res.end(raw);
}
