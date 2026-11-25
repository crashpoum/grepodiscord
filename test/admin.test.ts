import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_SETTINGS, canDraw, canSee, grantExpiry, isActive, mayRun, parseOwners, sanitizeSettings, suggestLinks, validTimezone, type Grant, type Viewer } from '../src/admin/settings.js';
import { claimAllowed, confirmLink, createClaim, effectivePlayer, linkState } from '../src/admin/linking.js';
import { AdminService, auditDetail } from '../src/admin/service.js';
import { clockBar, newGhosts, tzOffsetMin } from '../src/bot/trackers.js';
import { manualWait } from '../src/web/live.js';
import { Store } from '../src/db.js';
import { createWebApp } from '../src/web/server.js';
import { issueSession } from '../src/web/auth.js';
import { LiveHub } from '../src/web/live.js';
import { WEB_STRINGS } from '../src/web/strings.js';
import { STRINGS } from '../src/i18n.js';
import type { Ctx } from '../src/services.js';
import { snap } from './helpers.js';

const V = (over: Partial<Viewer> = {}): Viewer => ({ userId: 'u1', roles: [], owner: false, admin: false, link: 'confirmed', guest: false, ...over });
const NOW = 1_800_000_000_000;

describe('admin settings', () => {
  it('sanitizes untrusted input and keeps defaults for missing fields', () => {
    const s = sanitizeSettings({ alerts: { channelId: '123456789012', roleId: 'x', minSize: -5, types: ['attack', 'nope'] }, colors: { own: '#ABCDEF', enemy: 'red' },
      live: { pollSeconds: 1, teams: ['a', 'b', 'c', 'd'] }, planner: { windowMin: 999, timezone: 'Mars/Base' }, junk: 1 });
    expect(s.alerts).toEqual({ channelId: '123456789012', roleId: null, minSize: 0, types: ['attack'] });
    expect(s.colors).toEqual({ own: '#abcdef', ally: null, enemy: null });
    expect(s.live.pollSeconds).toBeGreaterThanOrEqual(3);
    expect(s.live.teams.length).toBeLessThanOrEqual(3);
    expect(s.planner.timezone).toBe('Europe/Athens');
    expect(s.visibility).toEqual(DEFAULT_SETTINGS.visibility);
    expect(s).not.toHaveProperty('junk');
    expect(validTimezone('Europe/London')).toBe('Europe/London');
    expect(validTimezone('Nope/Nope')).toBeNull();
  });
});

describe('permissions', () => {
  const s = sanitizeSettings({ visibility: { troops: { who: 'roles', roles: ['111111'] }, alerts: { who: 'all' }, ops: { who: 'admins' } }, drawing: { who: 'roles', roles: ['222222'] } });
  it('owner/admin see everything; guests nothing; role rules; pending members per setting', () => {
    expect(canSee('ops', V({ admin: true }), s, [], NOW)).toBe(true);
    expect(canSee('ops', V({ owner: true }), s, [], NOW)).toBe(true);
    expect(canSee('alerts', V({ guest: true }), s, [], NOW)).toBe(false);
    expect(canSee('alerts', V(), s, [], NOW)).toBe(true);
    expect(canSee('troops', V(), s, [], NOW)).toBe(false);
    expect(canSee('troops', V({ roles: ['111111'] }), s, [], NOW)).toBe(true);
    expect(canSee('troops', V({ roles: null }), s, [], NOW)).toBe(false); // roles unknown → deny
    expect(canSee('ops', V(), s, [], NOW)).toBe(false);
    const basic = sanitizeSettings({ linking: { unconfirmed: 'basic' } });
    expect(canSee('alerts', V({ link: 'pending' }), basic, [], NOW)).toBe(false);
    expect(canSee('alerts', V({ link: 'pending' }), DEFAULT_SETTINGS, [], NOW)).toBe(true);
  });
  it('grants: member or role, timed ones expire, revoked ones are gone', () => {
    const g = (over: Partial<Grant>): Grant => ({ id: 1, kind: 'user', targetId: 'u1', scope: 'ops', expiresAt: null, createdBy: 'o', createdAt: NOW, ...over });
    expect(canSee('ops', V(), s, [g({})], NOW)).toBe(true);
    expect(canSee('ops', V(), s, [g({ scope: 'troops' })], NOW)).toBe(false);
    expect(canSee('ops', V(), s, [g({ expiresAt: NOW - 1 })], NOW)).toBe(false);
    expect(canSee('ops', V({ roles: ['333333'] }), s, [g({ kind: 'role', targetId: '333333', expiresAt: NOW + 1000 })], NOW)).toBe(true);
    expect(canSee('ops', V({ guest: true }), s, [g({})], NOW)).toBe(false);
    expect(isActive(g({ expiresAt: NOW + 1 }), NOW)).toBe(true);
    expect(grantExpiry('perm', null, NOW)).toBeNull();
    expect(grantExpiry('1h', null, NOW)).toBe(NOW + 3600_000);
    expect(grantExpiry('1d', null, NOW)).toBe(NOW + 86400_000);
    expect(grantExpiry('1w', null, NOW)).toBe(NOW + 7 * 86400_000);
    expect(grantExpiry('custom', NOW + 7200_000, NOW)).toBe(NOW + 7200_000);
    expect(grantExpiry('custom', NOW - 1, NOW)).toBe('bad');
    expect(grantExpiry('forever', null, NOW)).toBe('bad');
  });
  it('drawing permission and owner-only actions', () => {
    expect(canDraw(V(), s)).toBe(false);
    expect(canDraw(V({ roles: ['222222'] }), s)).toBe(true);
    expect(canDraw(V({ admin: true }), s)).toBe(true);
    expect(canDraw(V({ guest: true }), DEFAULT_SETTINGS)).toBe(false);
    for (const a of ['admins.add', 'admins.remove', 'backup.restore']) { expect(mayRun(a, { owner: false, admin: true })).toBe(false); expect(mayRun(a, { owner: true, admin: true })).toBe(true); }
    expect(mayRun('settings.save', { owner: false, admin: true })).toBe(true);
    expect(mayRun('settings.save', { owner: false, admin: false })).toBe(false);
    expect([...parseOwners('123456789012, bad ,234567890123')]).toEqual(['123456789012', '234567890123']);
    expect(auditDetail('announce.post', { channelId: '1', text: 'hello' })).toContain('"hello"');
  });
});

describe('linking', () => {
  const w = snap();
  it('claims only for our alliance/pacts (unless allowed), one player per member', () => {
    const sides = { ours: [10], allies: [] };
    expect(claimAllowed(w, 1, sides, DEFAULT_SETTINGS)).toEqual({ ok: true });
    expect(claimAllowed(w, 3, sides, DEFAULT_SETTINGS)).toEqual({ ok: false, why: 'notOurs' });
    expect(claimAllowed(w, 3, sides, sanitizeSettings({ linking: { allowAnyAlliance: true } }))).toEqual({ ok: true });
    expect(claimAllowed(w, 999, sides, DEFAULT_SETTINGS)).toEqual({ ok: false, why: 'unknown' });
    expect(claimAllowed(w, 3, { ours: [], allies: [] }, DEFAULT_SETTINGS)).toEqual({ ok: true });

    const st = new Store(':memory:');
    expect(createClaim(st, { guildId: 'g', userId: 'a', userName: 'A', world: 'en999', playerId: 1, source: 'iam' }, NOW)).toEqual({ ok: true });
    expect(linkState(st, 'g', 'a', 'en999')).toBe('pending');
    expect(effectivePlayer(st, 'g', 'a', 'en999', DEFAULT_SETTINGS)).toBe(1);
    expect(effectivePlayer(st, 'g', 'a', 'en999', sanitizeSettings({ linking: { unconfirmed: 'basic' } }))).toBeNull();
    // Someone else can't claim the same player while it is pending.
    expect(createClaim(st, { guildId: 'g', userId: 'b', userName: 'B', world: 'en999', playerId: 1, source: 'iam' }, NOW)).toEqual({ ok: false, why: 'taken' });
    expect(confirmLink(st, 'g', 'a', 'en999', 1, 'admin', NOW)).toEqual({ ok: true });
    expect(linkState(st, 'g', 'a', 'en999')).toBe('confirmed');
    expect(confirmLink(st, 'g', 'b', 'en999', 1, 'admin', NOW)).toEqual({ ok: false, why: 'taken' });
    expect(createClaim(st, { guildId: 'g', userId: 'a', userName: 'A', world: 'en999', playerId: 1, source: 'iam' }, NOW)).toEqual({ ok: false, why: 'already' });
  });
  it('nickname suggestions match normalized names and "[TAG] Name", skipping taken players and linked members', () => {
    const players = [{ id: 1, name: 'Leonidas_GR' }, { id: 2, name: 'Ariadne' }, { id: 3, name: 'Kleon' }];
    const out = suggestLinks([{ userId: 'm1', name: 'leonidas gr' }, { userId: 'm2', name: '[ABC] Ariadne' }, { userId: 'm3', name: 'Kleon' }, { userId: 'm4', name: 'zz' }], players, new Set([3]), new Set());
    expect(out.map((x) => [x.userId, x.playerId])).toEqual([['m1', 1], ['m2', 2]]);
    expect(suggestLinks([{ userId: 'm1', name: 'Ariadne' }], players, new Set(), new Set(['m1']))).toEqual([]);
  });
});

describe('trackers and live helpers', () => {
  it('activity clock bar shifts UTC hours to the guild timezone', () => {
    const h = Array(24).fill(0); h[18] = 4; h[19] = 2;
    const r = clockBar(h, 120);
    expect(r.bar).toHaveLength(24);
    expect(r.peak).toEqual([20, 21]);
    expect(tzOffsetMin('UTC')).toBe(0);
    expect([120, 180]).toContain(tzOffsetMin('Europe/Athens'));
  });
  it('ghost watcher finds towns that just became ghosts near our towns', () => {
    const prev = snap({ towns: ['100,1,Alice+1,450,530,1,600', '300,3,Cara+town,455,535,4,200', '500,2,Bob+far,900,900,5,100'].join('\n') });
    const next = snap({ towns: ['100,1,Alice+1,450,530,1,600', '300,,Cara+town,455,535,4,200', '500,,Bob+far,900,900,5,100'].join('\n') });
    const g = newGhosts(prev, next, new Set([10]), 15);
    expect(g.map((x) => x.id)).toEqual([300]);
    expect(g[0].was).toBe("Cara's");
  });
  it('manual refresh: 10 s cooldown, never during a poll', () => {
    expect(manualWait(0, false, 100_000)).toBe(0);
    expect(manualWait(100_000, false, 104_000)).toBe(6000);
    expect(manualWait(100_000, false, 110_000)).toBe(0);
    expect(manualWait(0, true, 100_000)).toBeGreaterThan(0);
  });
});

describe('admin and guest HTTP routes', () => {
  it('owner-only actions, CSRF header, audit log, guest links read-only and revocable', async () => {
    let t = NOW;
    const now = () => t;
    const OWNER = '100000000000000001', ADMIN = '200000000000000002';
    const store = new Store(':memory:');
    store.setGuild({ guildId: 'g1', world: 'gr125', lang: 'en', verifiedRoleId: null });
    const c = { store } as unknown as Ctx;
    const secret = 'g'.repeat(32);
    const admin = new AdminService(c, secret, now, new Set([OWNER]), () => null);
    const app = createWebApp({ ctx: c, guilds: { has: () => true, name: () => 'G' }, secret, staticDir: null, fetchImpl: fetch, admin, now,
      hub: new LiveHub(c, async () => [], { pollSeconds: 20, rpm: 5, now }) });
    const srv = http.createServer(app.handler);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const tok = (u: string) => issueSession(secret, { u, g: 'g1', n: u }, 1, t);
    const act = (u: string, body: Record<string, unknown>, csrf = true) => fetch(`${base}/api/admin/action`, { method: 'POST', body: JSON.stringify(body),
      headers: { Authorization: `Bearer ${tok(u)}`, 'Content-Type': 'application/json', ...(csrf ? { 'X-GC': '1' } : {}) } });
    try {
      expect((await act(OWNER, { action: 'admins.add', userId: ADMIN, name: 'Leo' }, false)).status).toBe(403); // no CSRF header
      expect((await act('300000000000000003', { action: 'settings.save', settings: {} })).status).toBe(403); // not an admin
      expect((await act(OWNER, { action: 'admins.add', userId: ADMIN, name: 'Leo' })).status).toBe(200);
      // An admin can change settings but not the admin list.
      expect((await act(ADMIN, { action: 'settings.save', settings: { alerts: { minSize: 50 } } })).status).toBe(200);
      const no = await act(ADMIN, { action: 'admins.add', userId: '400000000000000004' });
      expect(no.status).toBe(403);
      expect(await no.json()).toEqual({ error: 'ownerOnly' });
      expect((await act(ADMIN, { action: 'admins.remove', userId: ADMIN })).status).toBe(403);
      expect((await act(ADMIN, { action: 'backup.restore', data: {} })).status).toBe(403);
      expect(admin.settings('g1').alerts.minSize).toBe(50);
      const audit = store.listAudit('g1');
      expect(audit.map((a) => a.action)).toEqual(['settings.save', 'admins.add']);
      // Grants with expiry; revocable early.
      const gr = await (await act(ADMIN, { action: 'grants.add', kind: 'user', targetId: '500000000000000005', scope: 'ops', preset: '1h' })).json() as { id: number };
      expect(store.listGrants('g1')[0]).toMatchObject({ scope: 'ops', expiresAt: t + 3600_000 });
      expect((await act(ADMIN, { action: 'grants.remove', id: gr.id })).status).toBe(200);
      expect(store.listGrants('g1')).toHaveLength(0);
      // /api/me tabs reflect permissions.
      const me = await (await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${tok('600000000000000006')}` } })).json() as { tabs: Record<string, boolean> };
      expect(me.tabs).toMatchObject({ troops: true, alerts: true, ops: false, admin: false });

      // Guest link: read-only live/map, nothing else; revoking it kills the session.
      store.addGuestLink({ id: 'gl1', guildId: 'g1', label: 'Pact', createdBy: OWNER, createdAt: t, expiresAt: t + 3600_000 });
      const gtok = issueSession(secret, { u: 'guest:gl1', g: 'g1', n: 'Pact', k: 'guest', j: 'gl1' }, 1, t);
      const gh = { Authorization: `Bearer ${gtok}` };
      expect((await fetch(`${base}/api/me`, { headers: gh })).status).toBe(200);
      expect((await fetch(`${base}/api/sync/incoming`, { headers: gh })).status).toBe(403);
      expect((await fetch(`${base}/api/admin/state`, { headers: gh })).status).toBe(403);
      expect((await fetch(`${base}/api/live/refresh`, { method: 'POST', headers: { ...gh, 'X-GC': '1' } })).status).toBe(403);
      store.revokeGuestLink('g1', 'gl1');
      expect((await fetch(`${base}/api/me`, { headers: gh })).status).toBe(401);

      // Manual live refresh: second click inside 10 s → 429.
      const lr = () => fetch(`${base}/api/live/refresh`, { method: 'POST', headers: { Authorization: `Bearer ${tok(ADMIN)}`, 'X-GC': '1' } });
      expect((await lr()).status).toBe(202);
      t += 2000;
      expect((await lr()).status).toBe(429);
    } finally { app.hub.stop(); srv.close(); }
  });
});

describe('strings', () => {
  it('new web and bot strings exist in EN and GR', () => {
    for (const k of ['tabAlerts', 'tabOps', 'tabAdmin', 'tabMini', 'alertsTitle', 'opsTitle', 'admTitle', 'heatLayer', 'townHistory', 'miniTitle', 'refreshNow'] as const) {
      expect(WEB_STRINGS.en[k]).toBeTruthy();
      expect(WEB_STRINGS.el[k]).toBeTruthy();
      expect(WEB_STRINGS.el[k]).not.toBe(WEB_STRINGS.en[k]);
    }
    const en = STRINGS.en as Record<string, string>, el = STRINGS.el as Record<string, string>;
    for (const k of Object.keys(en).filter((x) => /^(admin|alert|board|tracker|ghost|clock|iam)\./.test(x))) expect(el[k], k).toBeTruthy();
  });
});
