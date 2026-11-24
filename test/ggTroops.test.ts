import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/db.js';
import { GgService, grepolisOrigin, hashGgKey, newGgKey } from '../src/web/ggTroops.js';
import { cleanUnitMap, filterSnaps, looksLikeGgKey, totalUnits, validatePayload, GG_KEY_PREFIX, GG_LIMITS, type GgPlayerSnap, type GgTown } from '../src/web/ggCore.js';
import { createWebApp } from '../src/web/server.js';
import { issueSession } from '../src/web/auth.js';
import { LiveHub } from '../src/web/live.js';
import { WEB_STRINGS } from '../src/web/strings.js';
import type { Ctx } from '../src/services.js';

const town = (id: number, over: Partial<GgTown> = {}): GgTown => ({
  id, n: `Town ${id}`, sea: 55, home: { sword: 10 }, total: { sword: 10, bireme: 2 }, sup: {}, ...over,
});
const body = (over: Record<string, unknown> = {}) => ({
  v: 1, world: 'gr125', player_id: 1001, player_name: 'Leonidas', ts: Date.now(), towns: [town(1)], ...over,
});

describe('GrepoGod payload validation', () => {
  const okW = (w: string) => w === 'gr125';
  it('accepts a frSnapshot-shaped town and strips extras', () => {
    const r = validatePayload(body({ towns: [town(7, { it: { sword: 10, hoplite: 4 }, w: 25, wq: 26, wa: 1_764_103_600, sup: { hoplite: 4 } })], extra: true }), Date.now(), okW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.p.towns[0]).toMatchObject({ id: 7, n: 'Town 7', sea: 55, w: 25, wq: 26, it: { sword: 10, hoplite: 4 } });
      expect(r.p).not.toHaveProperty('extra');
    }
  });
  it('rejects bad unit maps, names, worlds and oversized town lists', () => {
    expect(cleanUnitMap({ 'Sword': 1 })).toBeNull();
    expect(cleanUnitMap({ sword: 1.5 })).toBeNull();
    expect(cleanUnitMap({ sword: 0 })).toBeNull();
    expect(cleanUnitMap({ '<img>': 1 })).toBeNull();
    expect(cleanUnitMap({ sword: 10 })).toEqual({ sword: 10 });
    expect(validatePayload(body({ world: 'xx99' }), Date.now(), okW)).toEqual({ ok: false, err: 'world' });
    expect(validatePayload(body({ v: 2 }), Date.now(), okW)).toEqual({ ok: false, err: 'invalid' });
    expect(validatePayload(body({ player_name: '   ' }), Date.now(), okW)).toEqual({ ok: false, err: 'invalid' });
    const cleaned = validatePayload(body({ player_name: '<b>Leo</b>' }), Date.now(), okW);
    expect(cleaned.ok && cleaned.ok && cleaned.p.player_name).toBe('bLeo/b');
    expect(validatePayload(body({ towns: Array.from({ length: GG_LIMITS.towns + 1 }, (_, i) => town(i + 1)) }), Date.now(), okW)).toEqual({ ok: false, err: 'tooLarge' });
    expect(validatePayload(body({ towns: [town(1), town(1)] }), Date.now(), okW)).toEqual({ ok: false, err: 'invalid' });
    expect(validatePayload(body({ towns: [town(1, { w: 99 })] }), Date.now(), okW)).toEqual({ ok: false, err: 'invalid' });
  });
  it('accepts ts in seconds or ms', () => {
    const now = Date.now();
    const a = validatePayload(body({ ts: Math.floor(now / 1000) }), now, okW);
    const b = validatePayload(body({ ts: now }), now, okW);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(Math.abs(a.p.ts - now)).toBeLessThan(2000);
      expect(Math.abs(b.p.ts - now)).toBeLessThan(2);
    }
  });
  it('filters and totals respect player / town / unit', () => {
    const snaps: GgPlayerSnap[] = [
      { playerId: 1, playerName: 'Ana', mine: true, ts: 1, recvAt: 1, towns: [town(1, { n: 'Sparta', home: { sword: 5 }, total: { sword: 5, bireme: 3 }, sup: { hoplite: 2 } }), town(2, { n: 'Athens', total: { slinger: 8 }, home: { slinger: 8 } })] },
      { playerId: 2, playerName: 'Bion', mine: false, ts: 1, recvAt: 1, towns: [town(3, { n: 'Thebes', total: { sword: 20 }, home: { sword: 20 } })] },
    ];
    expect(filterSnaps(snaps, { q: 'spa', player: null, unit: null }).map((p) => p.playerName)).toEqual(['Ana']);
    expect(filterSnaps(snaps, { q: '', player: 2, unit: null })[0].towns).toHaveLength(1);
    const onlyShips = filterSnaps(snaps, { q: '', player: null, unit: 'bireme' });
    expect(onlyShips).toHaveLength(1);
    expect(onlyShips[0].towns.map((t) => t.n)).toEqual(['Sparta']);
    expect(Object.fromEntries(totalUnits(filterSnaps(snaps, { q: '', player: null, unit: null }), 'total'))).toEqual({ sword: 25, bireme: 3, slinger: 8 });
    expect(Object.fromEntries(totalUnits(filterSnaps(snaps, { q: '', player: null, unit: null }), 'sup'))).toEqual({ hoplite: 2 });
  });
});

describe('GrepoGod keys and service', () => {
  const setup = (world = 'gr125') => {
    let t = Date.now();
    const store = new Store(':memory:');
    store.setGuild({ guildId: 'g1', world, lang: 'en', verifiedRoleId: null });
    const svc = new GgService(store, () => t);
    return { store, svc, adv: (ms: number) => { t += ms; } };
  };
  it('hashes and rotates the key; unlink deletes key and data', () => {
    const { store, svc } = setup();
    const a = svc.issue('g1', 'u1', 1001);
    expect(looksLikeGgKey(a.key)).toBe(true);
    expect(a.key.startsWith(GG_KEY_PREFIX)).toBe(true);
    expect(store.getGgKeyByHash(hashGgKey(a.key))?.userId).toBe('u1');
    expect(JSON.stringify(store.getGgKeyByUser('g1', 'u1'))).not.toContain(a.key.slice(5)); // raw secret is not stored
    const b = svc.issue('g1', 'u1', 1001);
    expect(b.rotated).toBe(true);
    expect(store.getGgKeyByHash(hashGgKey(a.key))).toBeNull();
    expect(svc.post(a.key, body()).status).toBe(401);
    expect(svc.post(b.key, body()).status).toBe(200);
    const u = svc.unlink('g1', 'u1');
    expect(u).toEqual({ hadKey: true, removed: 1 });
    expect(svc.post(b.key, body()).status).toBe(401);
  });
  it('stores the latest snapshot per player and lists it for the guild', () => {
    const { svc } = setup();
    const { key } = svc.issue('g1', 'u1', 1001);
    expect(svc.post(key, body({ towns: [town(1)] })).body).toEqual({ ok: true, towns: 1 });
    const v = svc.view('g1', 'gr125', 'u1');
    expect(v.players).toHaveLength(1);
    expect(v.players[0]).toMatchObject({ playerId: 1001, playerName: 'Leonidas', mine: true });
    expect(v.players[0].towns[0].id).toBe(1);
    expect(svc.view('g1', 'gr125', 'u2').players[0].mine).toBe(false);
  });
  it('rejects a snapshot for the wrong world or a different player than the verified one', () => {
    const { store, svc } = setup();
    store.setLink({ guildId: 'g1', userId: 'u1', world: 'gr125', playerId: 1001, verifiedAt: 1 });
    const { key } = svc.issue('g1', 'u1', 1001);
    expect(svc.post(key, body({ world: 'en123' })).body).toEqual({ error: 'world' });
    expect(svc.post(key, body({ player_id: 9999 })).body).toEqual({ error: 'player' });
  });
  it('rate-limits writes to one per 15 s per key', () => {
    const { svc, adv } = setup();
    const { key } = svc.issue('g1', 'u1', null);
    expect(svc.post(key, body()).status).toBe(200);
    expect(svc.post(key, body()).status).toBe(429);
    adv(GG_LIMITS.rateMs);
    expect(svc.post(key, body({ towns: [town(2, { n: 'Next' })] })).status).toBe(200);
  });
  it('DELETE removes the snapshot but keeps the key', () => {
    const { store, svc, adv } = setup();
    const { key } = svc.issue('g1', 'u1', null);
    svc.post(key, body());
    expect(svc.remove(key)).toMatchObject({ status: 200, body: { ok: true, removed: 1 } });
    expect(svc.view('g1', 'gr125', 'u1').players).toHaveLength(0);
    expect(store.getGgKeyByUser('g1', 'u1')).toBeTruthy();
    adv(GG_LIMITS.rateMs);
    expect(svc.post(key, body()).status).toBe(200);
  });
});

describe('CORS origins', () => {
  it('allows only https Grepolis hosts', () => {
    expect(grepolisOrigin('https://gr125.grepolis.com')).toBe('https://gr125.grepolis.com');
    expect(grepolisOrigin('https://www.grepolis.com')).toBe('https://www.grepolis.com');
    expect(grepolisOrigin('https://grepolis.com')).toBe('https://grepolis.com');
    expect(grepolisOrigin('http://gr125.grepolis.com')).toBeNull();
    expect(grepolisOrigin('https://grepolis.com.evil.example')).toBeNull();
    expect(grepolisOrigin('https://notgrepolis.com')).toBeNull();
  });
});

describe('GrepoGod HTTP API', () => {
  it('POST/DELETE with Bearer key; CORS; 401/413/429; GET needs a guild session', async () => {
    const store = new Store(':memory:');
    store.setGuild({ guildId: 'g1', world: 'gr125', lang: 'en', verifiedRoleId: null });
    const gg = new GgService(store, Date.now);
    const { key } = gg.issue('g1', 'u1', 1001);
    const c = { store } as unknown as Ctx;
    const secret = 'g'.repeat(32);
    const app = createWebApp({ ctx: c, guilds: { has: () => true, name: () => 'G' }, secret, staticDir: null, fetchImpl: fetch, gg,
      hub: new LiveHub(c, async () => [], { pollSeconds: 20, rpm: 5, now: Date.now }) });
    const srv = http.createServer(app.handler);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Origin: 'https://gr125.grepolis.com' };
    try {
      const opt = await fetch(`${base}/api/gg/troops`, { method: 'OPTIONS', headers: { Origin: 'https://gr125.grepolis.com', 'Access-Control-Request-Method': 'POST' } });
      expect(opt.status).toBe(204);
      expect(opt.headers.get('access-control-allow-origin')).toBe('https://gr125.grepolis.com');
      expect((await fetch(`${base}/api/gg/troops`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status).toBe(403);

      expect((await fetch(`${base}/api/gg/troops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) })).status).toBe(401);
      const ok = await fetch(`${base}/api/gg/troops`, { method: 'POST', headers: auth, body: JSON.stringify(body()) });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('access-control-allow-origin')).toBe('https://gr125.grepolis.com');
      expect((await ok.json())).toEqual({ ok: true, towns: 1 });
      expect((await fetch(`${base}/api/gg/troops`, { method: 'POST', headers: auth, body: JSON.stringify(body()) })).status).toBe(429);

      const big = 'x'.repeat(GG_LIMITS.body + 10);
      const huge = await fetch(`${base}/api/gg/troops`, { method: 'POST', headers: { ...auth, 'Content-Length': String(big.length) }, body: big });
      expect([413, 400]).toContain(huge.status);

      expect((await fetch(`${base}/api/gg/troops`)).status).toBe(401); // GET needs a session
      const sess = { Authorization: `Bearer ${issueSession(secret, { u: 'u1', g: 'g1', n: 'Al' })}` };
      const list = await (await fetch(`${base}/api/gg/troops`, { headers: sess })).json() as { players: { playerName: string; towns: unknown[] }[] };
      expect(list.players[0]).toMatchObject({ playerName: 'Leonidas' });
      expect(list.players[0].towns).toHaveLength(1);

      const del = await fetch(`${base}/api/gg/troops`, { method: 'DELETE', headers: auth });
      expect(del.status).toBe(200);
      const empty = await (await fetch(`${base}/api/gg/troops`, { headers: sess })).json() as { players: unknown[] };
      expect(empty.players).toHaveLength(0);
    } finally { app.hub.stop(); srv.close(); }
  });
  it('EN and GR strings for the Troops tab and the slash command exist', () => {
    for (const k of ['tabTroops', 'atHome', 'inTown', 'totalIncl', 'supportIn', 'allianceTotals', 'wall'] as const) {
      expect(WEB_STRINGS.en[k]).toBeTruthy();
      expect(WEB_STRINGS.el[k]).toBeTruthy();
      expect(WEB_STRINGS.el[k]).not.toBe(WEB_STRINGS.en[k]);
    }
  });
});
