/**
 * Shared, temporary strategy markup for the world map. One revision counter per guild+world (in memory) lets every
 * viewer's short poll answer "unchanged" (204) without touching SQLite; shapes are persisted in SQLite with an expiry
 * and purged every 10 minutes. Writes are rate limited per user and capped per guild and per user.
 */
import type { Store } from '../db.js';
import type { StringKey } from '../i18n.js';
import { MARK_LIMITS, MARK_TTL, validateMark, type Mark, type MarkKind, type MarksView } from './marksCore.js';

export type MarksResult = { status: number; body: unknown } | { status: number; err: StringKey; vars?: Record<string, string | number> };
const PURGE_EVERY = 10 * 60_000;
const MANAGER_TTL = 5 * 60_000;

export class MarksService {
  private revs = new Map<string, number>();
  private writes = new Map<string, number[]>();
  private nextExp = new Map<string, number>();
  private managers = new Map<string, { at: number; v: boolean }>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private store: Store, private isManagerImpl: (guildId: string, userId: string) => Promise<boolean>, private now: () => number = Date.now) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.purge(), PURGE_EVERY);
    this.timer.unref?.();
    this.purge();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  purge(): number {
    const n = this.store.purgeExpiredMarks(this.now());
    if (n) for (const k of [...this.revs.keys()]) this.revs.set(k, Math.max(this.now(), this.revs.get(k)! + 1)); // expired shapes disappear on every viewer's next poll
    return n;
  }

  rev(guildId: string, world: string): number {
    const k = `${guildId}:${world}`;
    const ne = this.nextExp.get(k);
    if (ne !== undefined && this.now() >= ne) { this.nextExp.delete(k); this.bump(guildId, world); }
    let r = this.revs.get(k);
    if (r === undefined) { r = this.now(); this.revs.set(k, r); } // restart-safe: a fresh number after a restart
    return r;
  }
  /** Force every viewer to reload the shapes (admin "clear all"). */
  touch(guildId: string, world: string) { this.bump(guildId, world); }
  private bump(guildId: string, world: string) { const k = `${guildId}:${world}`; this.revs.set(k, Math.max(this.now(), (this.revs.get(k) ?? 0) + 1)); }

  async isManager(guildId: string, userId: string): Promise<boolean> {
    const k = `${guildId}:${userId}`; const c = this.managers.get(k);
    if (c && this.now() - c.at < MANAGER_TTL) return c.v;
    const v = await this.isManagerImpl(guildId, userId).catch(() => false);
    this.managers.set(k, { at: this.now(), v });
    if (this.managers.size > 2000) this.managers.delete(this.managers.keys().next().value!);
    return v;
  }

  /** Current shapes, or null when the client already has revision `since`. */
  async view(guildId: string, world: string, userId: string, since?: number): Promise<MarksView | null> {
    const rev = this.rev(guildId, world);
    if (since === rev) return null;
    const now = this.now();
    // Expired shapes vanish within a poll even before the next purge: re-check the earliest expiry.
    const marks: Mark[] = this.store.listMarks(guildId, world, now).map((m) => ({ id: m.id, kind: m.kind as MarkKind, color: m.color, width: m.width, pts: m.pts, text: m.text, author: m.author, mine: m.userId === userId, createdAt: m.createdAt, expiresAt: m.expiresAt }));
    const next = marks.reduce((a, m) => Math.min(a, m.expiresAt), Infinity);
    if (next !== Infinity) this.nextExp.set(`${guildId}:${world}`, next); else this.nextExp.delete(`${guildId}:${world}`);
    return { rev, marks, canClearAll: await this.isManager(guildId, userId), limits: MARK_LIMITS };
  }

  private rateOk(userId: string): boolean {
    const n = this.now();
    const arr = (this.writes.get(userId) ?? []).filter((t) => n - t < 60_000);
    if (arr.length >= MARK_LIMITS.writesPerMin) { this.writes.set(userId, arr); return false; }
    arr.push(n); this.writes.set(userId, arr);
    if (this.writes.size > 5000) this.writes.delete(this.writes.keys().next().value!);
    return true;
  }

  create(guildId: string, world: string, userId: string, author: string, body: unknown): MarksResult {
    if (!this.rateOk(userId)) return { status: 429, err: 'web.marks.rate' };
    const v = validateMark(body);
    if (!v.ok) return { status: 400, err: 'web.marks.invalid' };
    const now = this.now();
    if (this.store.countMarks(guildId, world, now) >= MARK_LIMITS.perGuild) return { status: 409, err: 'web.marks.full', vars: { n: MARK_LIMITS.perGuild } };
    if (this.store.countMarks(guildId, world, now, userId) >= MARK_LIMITS.perUser) return { status: 409, err: 'web.marks.userFull', vars: { n: MARK_LIMITS.perUser } };
    const m = v.m;
    const name = (author || 'Discord user').replace(/[\u0000-\u001f<>]/g, '').slice(0, 40);
    const expiresAt = now + MARK_TTL[m.ttl] * 1000;
    const id = this.store.addMark({ guildId, world, userId, author: name, kind: m.kind, color: m.color, width: m.width, pts: m.pts, text: m.text ?? '', createdAt: now, expiresAt });
    this.bump(guildId, world);
    const mark: Mark = { id, kind: m.kind, color: m.color, width: m.width, pts: m.pts, text: m.text ?? '', author: name, mine: true, createdAt: now, expiresAt };
    return { status: 201, body: { mark, rev: this.rev(guildId, world) } };
  }

  async remove(guildId: string, world: string, userId: string, id: unknown): Promise<MarksResult> {
    if (!this.rateOk(userId)) return { status: 429, err: 'web.marks.rate' };
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return { status: 400, err: 'web.marks.invalid' };
    let ok = this.store.deleteMark(guildId, world, n, userId);
    if (!ok && (await this.isManager(guildId, userId))) ok = this.store.deleteMark(guildId, world, n, null);
    if (!ok) return { status: 403, err: 'web.marks.denied' };
    this.bump(guildId, world);
    return { status: 200, body: { ok: true, rev: this.rev(guildId, world) } };
  }

  async clear(guildId: string, world: string, userId: string, all: boolean): Promise<MarksResult> {
    if (!this.rateOk(userId)) return { status: 429, err: 'web.marks.rate' };
    if (all && !(await this.isManager(guildId, userId))) return { status: 403, err: 'web.marks.denied' };
    const removed = this.store.clearMarks(guildId, world, all ? null : userId);
    this.bump(guildId, world);
    return { status: 200, body: { ok: true, removed, rev: this.rev(guildId, world) } };
  }
}
