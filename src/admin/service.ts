/**
 * Admin panel backend: settings document, viewer permissions (owner / admins / roles / grants) and every panel action.
 * Each action is checked server-side (mayRun) and written to the audit log. The owner (OWNER_USER_ID) is the only one
 * who can add or remove admins and restore a backup.
 */
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../services.js';
import { config } from '../config.js';
import { runtime, type BotBridge } from '../bridge.js';
import { DEFAULT_SETTINGS, canDraw, canSee, grantExpiry, isActive, mayRun, sanitizeSettings, suggestLinks, type AdminSettings, type Grant, type TabId, type Viewer } from './settings.js';
import { confirmLink, linkState } from './linking.js';
import { issueSession, type WebSession } from '../web/auth.js';
import type { LiveHub } from '../web/live.js';
import type { MarksService } from '../web/marks.js';
import type { GgService } from '../web/ggTroops.js';

const KEY = 'admin.settings';
const ROLE_TTL = 60_000;
export const GUEST_MAX_HOURS = 7 * 24;
export type ActionResult = { status: number; body: Record<string, unknown> };

export class AdminService {
  private roleCache = new Map<string, { at: number; v: string[] | null }>();
  private cache = new Map<string, { at: number; s: AdminSettings }>();
  hub: LiveHub | null = null;
  marks: MarksService | null = null;
  gg: GgService | null = null;
  constructor(private ctx: Ctx, private secret: string, private now: () => number = Date.now, private owners: Set<string> = new Set(config.ownerUserIds), private bridge: () => BotBridge | null = () => runtime.bridge) {}

  // ------------------------------------------------------------ settings
  settings(g: string): AdminSettings {
    const c = this.cache.get(g);
    if (c && this.now() - c.at < 5000) return c.s;
    let raw: unknown = null;
    try { raw = JSON.parse(this.ctx.store.getSetting(g, KEY) ?? 'null'); } catch { raw = null; }
    const s = sanitizeSettings(raw, DEFAULT_SETTINGS);
    this.cache.set(g, { at: this.now(), s });
    return s;
  }
  saveSettings(g: string, patch: unknown): AdminSettings {
    const s = sanitizeSettings(patch, this.settings(g));
    this.ctx.store.setSetting(g, KEY, JSON.stringify(s));
    this.cache.set(g, { at: this.now(), s });
    return s;
  }
  grants(g: string): Grant[] {
    const n = this.now();
    return this.ctx.store.listGrants(g).filter((x) => isActive(x, n));
  }

  // ------------------------------------------------------------ viewers
  isOwner(userId: string) { return this.owners.has(userId); }
  async roles(g: string, u: string): Promise<string[] | null> {
    const k = `${g}:${u}`, c = this.roleCache.get(k);
    if (c && this.now() - c.at < ROLE_TTL) return c.v;
    const v = await (this.bridge()?.memberRoles(g, u) ?? Promise.resolve(null)).catch(() => null);
    this.roleCache.set(k, { at: this.now(), v });
    if (this.roleCache.size > 2000) this.roleCache.delete(this.roleCache.keys().next().value!);
    return v;
  }
  async viewer(s: WebSession): Promise<Viewer> {
    const guest = s.k === 'guest';
    const owner = !guest && this.isOwner(s.u);
    const admin = !guest && (owner || this.ctx.store.isAdmin(s.g, s.u));
    const world = this.ctx.store.getGuild(s.g).world;
    const needRoles = !guest && !admin;
    return { userId: s.u, roles: needRoles ? await this.roles(s.g, s.u) : [], owner, admin, link: guest ? 'none' : linkState(this.ctx.store, s.g, s.u, world), guest };
  }
  can(tab: TabId, v: Viewer, g: string) { return canSee(tab, v, this.settings(g), this.grants(g), this.now()); }
  canDraw(v: Viewer, g: string) { return canDraw(v, this.settings(g)); }
  /** Flags for /api/me: which tabs to show. */
  async tabs(s: WebSession) {
    const v = await this.viewer(s);
    return { troops: this.can('troops', v, s.g), alerts: this.can('alerts', v, s.g), ops: this.can('ops', v, s.g), admin: v.admin, owner: v.owner, draw: this.canDraw(v, s.g), guest: v.guest, link: v.link };
  }
  /** Is this Discord user a bot admin here (owner or listed)? Used by the Approve/Reject buttons too. */
  isBotAdmin(g: string, u: string) { return this.isOwner(u) || this.ctx.store.isAdmin(g, u); }

  // ------------------------------------------------------------ panel state
  async state(g: string, v: Viewer) {
    const store = this.ctx.store;
    const gc = store.getGuild(g, config.defaultLang);
    const world = gc.world;
    const snap = world ? await this.ctx.worlds.ensure(world).catch(() => null) : null;
    const pname = (id: number | null) => (id && snap?.players.get(id)?.name) || (id ? `#${id}` : null);
    const aname = (id: number) => snap?.alliances.get(id)?.name ?? `#${id}`;
    const b = this.bridge();
    const links = store.linksForGuild(g).filter((l) => !world || l.world === world);
    const seen = store.seenMembers(g);
    const listed = await (b?.members(g) ?? Promise.resolve(null)).catch(() => null);
    const members = listed ?? seen.map((m) => ({ userId: m.userId, name: m.name }));
    const names = new Map<string, string>([...seen.map((m) => [m.userId, m.name] as [string, string]), ...(listed ?? []).map((m) => [m.userId, m.name] as [string, string])]);
    const nm = (u: string) => names.get(u) ?? null;
    const pendings = store.listClaims(g, 'pending');
    const taken = new Set([...links.map((l) => l.playerId), ...pendings.map((c) => c.playerId)]);
    const sides = world ? store.getWarSides(g, world) : { ours: [], enemies: [] };
    const s = this.settings(g);
    const suggestions = snap ? suggestLinks(members, [...snap.players.values()].map((p) => ({ id: p.id, name: p.name })), taken, new Set([...links.map((l) => l.userId), ...pendings.map((c) => c.userId)])).slice(0, 50) : [];
    const topAlliances = snap ? [...snap.alliances.values()].sort((a, c) => c.points - a.points).slice(0, 60).map((a) => ({ id: a.id, name: a.name, points: a.points })) : [];
    const lastRefreshSec = world ? this.ctx.worlds.lastRefreshAt(world) ?? null : null;
    const lastRefresh = lastRefreshSec ? lastRefreshSec * 1000 : null; // WorldManager keeps unix seconds
    return {
      me: { userId: v.userId, owner: v.owner, admin: v.admin }, ownerConfigured: this.owners.size > 0,
      guild: { id: g, lang: gc.lang, world }, settings: s,
      admins: store.listAdmins(g), owners: [...this.owners].map((u) => ({ userId: u, name: nm(u) })),
      grants: store.listGrants(g).map((x) => ({ ...x, active: isActive(x, this.now()), name: x.kind === 'user' ? nm(x.targetId) : (b?.roles(g).find((r) => r.id === x.targetId)?.name ?? null) })),
      channels: b?.channels(g) ?? [], roles: b?.roles(g) ?? [],
      claims: pendings.map((c) => ({ ...c, player: pname(c.playerId), userName: c.userName ?? nm(c.userId) })),
      links: links.map((l) => ({ userId: l.userId, name: nm(l.userId), playerId: l.playerId, player: pname(l.playerId), at: l.verifiedAt })),
      suggestions, membersListed: !!listed,
      sides: { own: s.ownAlliances.map((id) => ({ id, name: aname(id) })), pacts: sides.ours.filter((id) => !s.ownAlliances.includes(id)).map((id) => ({ id, name: aname(id) })), enemies: sides.enemies.map((id) => ({ id, name: aname(id) })) },
      alliances: topAlliances,
      sync: store.syncOverview(g).map((x) => ({ ...x, name: nm(x.userId), player: pname(x.playerId) })),
      live: this.hub?.health(g) ?? null,
      audit: store.listAudit(g, 100),
      announcements: store.listAnnouncements(g),
      guests: store.listGuestLinks(g),
      status: { uptimeSec: Math.floor((this.now() - runtime.startedAt) / 1000), worldRefreshedAt: lastRefresh, errors: runtime.errors.slice(-20).reverse(), discord: !!b, publicUrl: config.publicUrl || null, serverNow: this.now() },
    };
  }

  // ------------------------------------------------------------ actions
  async run(g: string, v: Viewer, who: string | null, action: string, body: Record<string, unknown>): Promise<ActionResult> {
    if (!v.admin) return { status: 403, body: { error: 'forbidden' } };
    if (!mayRun(action, v)) return { status: 403, body: { error: 'ownerOnly' } };
    const r = await this.exec(g, v, action, body);
    if (r.status < 300) this.ctx.store.audit(g, v.userId, who, action, auditDetail(action, body), this.now());
    return r;
  }

  /** A player/alliance given as id (number or digits) or exact name (case-insensitive) → id in the current world. */
  private async resolve(world: string, kind: 'player' | 'alliance', v: unknown): Promise<number | null> {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
    const snap = await this.ctx.worlds.ensure(world).catch(() => null);
    const map = kind === 'player' ? snap?.players : snap?.alliances;
    if (Number.isInteger(n) && n > 0) return !map || map.has(n) ? n : null;
    if (typeof v !== 'string' || !map) return null;
    const q = v.trim().toLowerCase();
    for (const x of map.values()) if (x.name.toLowerCase() === q) return x.id;
    return null;
  }

  private async exec(g: string, v: Viewer, action: string, b: Record<string, unknown>): Promise<ActionResult> {
    const store = this.ctx.store;
    const ok = (extra: Record<string, unknown> = {}): ActionResult => ({ status: 200, body: { ok: true, ...extra } });
    const bad = (error: string, status = 400): ActionResult => ({ status, body: { error } });
    const snow = (x: unknown) => (typeof x === 'string' && /^\d{5,25}$/.test(x) ? x : null);
    const world = store.getGuild(g).world;
    switch (action) {
      case 'settings.save': { const s = this.saveSettings(g, b.settings); return ok({ settings: s }); }
      case 'admins.add': {
        const u = snow(b.userId); if (!u) return bad('user');
        store.addAdmin(g, u, typeof b.name === 'string' ? b.name.slice(0, 64) : await this.bridge()?.userName(g, u).catch(() => null) ?? null, v.userId, this.now());
        return ok();
      }
      case 'admins.remove': { const u = snow(b.userId); if (!u) return bad('user'); return store.removeAdmin(g, u) ? ok() : bad('notFound', 404); }
      case 'grants.add': {
        const kind = b.kind === 'role' ? 'role' : 'user', target = snow(b.targetId), scope = ['troops', 'alerts', 'ops'].includes(String(b.scope)) ? String(b.scope) : 'ops';
        if (!target) return bad('target');
        const exp = grantExpiry(b.preset, b.until, this.now());
        if (exp === 'bad') return bad('expiry');
        return ok({ id: store.addGrant({ guildId: g, kind, targetId: target, scope, expiresAt: exp, createdBy: v.userId, createdAt: this.now() }) });
      }
      case 'grants.remove': return store.removeGrant(g, Number(b.id)) ? ok() : bad('notFound', 404);
      case 'sides.set': {
        if (!world) return bad('noWorld', 409);
        const id = await this.resolve(world, 'alliance', b.allianceId); if (!id) return bad('alliance');
        const s = this.settings(g);
        const own = s.ownAlliances.filter((x) => x !== id);
        store.removeWarSide(g, world, id);
        if (b.side === 'own') { own.push(id); store.setWarSide(g, world, id, 'ours'); }
        else if (b.side === 'pact') store.setWarSide(g, world, id, 'ours');
        else if (b.side === 'enemy') store.setWarSide(g, world, id, 'enemy');
        this.saveSettings(g, { ownAlliances: own });
        return ok();
      }
      case 'live.restart': this.hub?.restart(g); return ok();
      case 'marks.clear': {
        if (!world) return bad('noWorld', 409);
        const n = store.clearMarks(g, world, null);
        this.marks?.touch(g, world);
        return ok({ removed: n });
      }
      case 'sync.revokeData': { const u = snow(b.userId); if (!u) return bad('user'); return ok({ removed: store.deleteGgTroopsForUser(g, u) + store.deleteFeedsForUser(g, u) }); }
      case 'sync.revokeKey': { const u = snow(b.userId); if (!u) return bad('user'); const r = this.gg ? this.gg.unlink(g, u) : { hadKey: store.deleteGgKey(g, u), removed: 0 }; return ok(r); }
      case 'lang.set': {
        if (b.lang !== 'en' && b.lang !== 'el') return bad('lang');
        const gc = store.getGuild(g, config.defaultLang); store.setGuild({ ...gc, lang: b.lang }); return ok();
      }
      case 'announce.post': {
        const ch = snow(b.channelId), text = typeof b.text === 'string' ? b.text.trim().slice(0, 2000) : '';
        if (!ch || !text) return bad('announce');
        const at = typeof b.at === 'number' ? b.at : typeof b.at === 'string' && b.at ? Date.parse(b.at) : NaN;
        if (Number.isFinite(at) && at > this.now() + 30_000) {
          if (at > this.now() + 60 * 86400_000) return bad('when');
          return ok({ id: store.addAnnouncement({ guildId: g, channelId: ch, text, postAt: at, createdBy: v.userId, createdAt: this.now() }), scheduled: true });
        }
        const br = this.bridge(); if (!br) return bad('discord', 503);
        const id = store.addAnnouncement({ guildId: g, channelId: ch, text, postAt: this.now(), createdBy: v.userId, createdAt: this.now() });
        try { const mid = await br.post(ch, { content: text, allowedMentions: { parse: [] } }); store.markAnnouncement(id, 'sent', mid, null); return ok({ id }); } catch (e) { store.markAnnouncement(id, 'failed', null, String((e as Error).message).slice(0, 200)); return bad('post', 502); }
      }
      case 'announce.cancel': return store.cancelAnnouncement(g, Number(b.id)) ? ok() : bad('notFound', 404);
      case 'guest.create': {
        if (!config.publicUrl) return bad('noPublicUrl', 409);
        const hours = Math.min(GUEST_MAX_HOURS, Math.max(1, Math.round(Number(b.hours) || 24)));
        const id = randomBytes(9).toString('base64url');
        const label = (typeof b.label === 'string' ? b.label : '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'Guest';
        const exp = this.now() + hours * 3600_000;
        store.addGuestLink({ id, guildId: g, label, createdBy: v.userId, createdAt: this.now(), expiresAt: exp });
        const tok = issueSession(this.secret, { u: `guest:${id}`, g, n: label, k: 'guest', j: id }, hours, this.now());
        return ok({ id, url: `${config.publicUrl}/go/guest?t=${tok}`, expiresAt: exp });
      }
      case 'guest.revoke': return store.revokeGuestLink(g, String(b.id ?? '')) ? ok() : bad('notFound', 404);
      case 'claims.approve': case 'claims.reject': {
        const u = snow(b.userId); if (!u) return bad('user');
        const c = store.getClaim(g, u); if (!c || c.status !== 'pending') return bad('notFound', 404);
        if (action === 'claims.reject') { store.decideClaim(g, u, 'rejected', v.userId, this.now()); return ok(); }
        const r = confirmLink(store, g, u, c.world, c.playerId, v.userId, this.now());
        if (!r.ok) return bad(r.why, 409);
        await this.bridge()?.syncRoles(g, [u]).catch(() => undefined);
        return ok();
      }
      case 'claims.assign': case 'claims.bulk': {
        if (!world) return bad('noWorld', 409);
        const items = action === 'claims.bulk' && Array.isArray(b.items) ? b.items.slice(0, 100) : [b];
        const done: string[] = [], failed: string[] = [];
        for (const it of items as Record<string, unknown>[]) {
          const u = snow(it?.userId), p = await this.resolve(world, 'player', it?.playerId ?? it?.player);
          if (!u || !p) { failed.push(String(it?.userId)); continue; }
          const r = confirmLink(store, g, u, world, p, v.userId, this.now());
          (r.ok ? done : failed).push(u);
        }
        if (done.length) await this.bridge()?.syncRoles(g, done).catch(() => undefined);
        return failed.length && !done.length ? bad('taken', 409) : ok({ done: done.length, failed });
      }
      case 'links.remove': { const u = snow(b.userId); if (!u) return bad('user'); store.removeLink(g, u); store.removeClaim(g, u); await this.bridge()?.syncRoles(g, [u]).catch(() => undefined); return ok(); }
      case 'backup.restore': {
        const data = b.data as Record<string, unknown> | undefined;
        if (!data || typeof data !== 'object' || (data as { format?: unknown }).format !== BACKUP_FORMAT) return bad('backup');
        const n = store.importGuild(g, (data as { tables?: Record<string, unknown> }).tables ?? {});
        this.cache.delete(g);
        return ok({ rows: n });
      }
    }
    return bad('unknownAction', 404);
  }

  backup(g: string) {
    return { format: BACKUP_FORMAT, guildId: g, createdAt: new Date(this.now()).toISOString(), tables: this.ctx.store.exportGuild(g) };
  }
}
export const BACKUP_FORMAT = 'grepocord-backup-1';

/** Short, secret-free audit line. */
export function auditDetail(action: string, b: Record<string, unknown>): string {
  const pick = (...ks: string[]) => ks.filter((k) => b[k] !== undefined && b[k] !== null && b[k] !== '').map((k) => `${k}=${String(b[k]).slice(0, 60)}`).join(' ');
  switch (action) {
    case 'settings.save': return Object.keys((b.settings as object) ?? {}).join(', ');
    case 'announce.post': return `${pick('channelId', 'at')} "${String(b.text ?? '').slice(0, 80)}"`;
    case 'backup.restore': return 'restore';
    case 'claims.bulk': return `${Array.isArray(b.items) ? b.items.length : 0} item(s)`;
    default: return pick('userId', 'targetId', 'kind', 'scope', 'preset', 'until', 'allianceId', 'side', 'id', 'lang', 'label', 'hours', 'playerId');
  }
}
