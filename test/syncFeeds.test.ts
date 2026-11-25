import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { cleanPred, groupOps, newAlerts, normType, opClashes, toSec, unitTotal, validateIncoming, validateOps, type IncomingCmd, type SyncOp } from '../src/web/syncFeeds.js';
import { Store } from '../src/db.js';
import { GgService } from '../src/web/ggTroops.js';
import { createWebApp } from '../src/web/server.js';
import { issueSession } from '../src/web/auth.js';
import { LiveHub } from '../src/web/live.js';
import { AdminService } from '../src/admin/service.js';
import { predText, alertLine } from '../src/bot/alerts.js';
import type { Ctx } from '../src/services.js';

const fixture = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8')) as Record<string, unknown>;
const INC = fixture('sync-incoming.json'), OPS = fixture('sync-ops.json');
/** The samples were captured at ts 1795566386654 (ms): validate "as of" that moment. */
const NOW = 1795566386654;
const okW = (w: string) => w === 'gr125';

describe('incoming feed: real client sample', () => {
  it('accepts the sample exactly (nothing skipped) and keeps every documented field', () => {
    const r = validateIncoming(INC, NOW, okW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skipped).toBe(0);
    expect(r.h).toEqual({ v: 1, world: 'gr125', player_id: 7, player_name: 'crashpoum99', ts: NOW }); // header ts is kept in ms (like troops)
    expect(r.items.map((c) => [c.id, c.type])).toEqual([['9100', 'support'], ['9003', 'revolt'], ['9001', 'attack'], ['9002', 'conquest']]);
    const atk = r.items.find((c) => c.id === '9001')!;
    expect(atk).toMatchObject({ town_id: 11, town_n: 'Akropolis', arrival: 1795569986, from_town_id: 77, from_player_id: 42, from_player: 'papasn55', from_alliance: 'HDNW', started: 1795559186 });
    // pred.units is a list of unit TYPES (no counts); groups are the full list with percentages, highest first.
    expect(atk.pred).toEqual({ kind: 'naval', conf: 0.86, units: ['bireme', 'attack_ship'], groups: [{ pct: 86, units: ['bireme', 'attack_ship'] }, { pct: 40, units: ['trireme'] }, { pct: 12, units: ['colonize_ship'] }] });
    const colo = r.items.find((c) => c.id === '9002')!;
    expect(colo.pred).toMatchObject({ kind: 'colo', conf: 0.91, units: ['colonize_ship'], note: 'approximate travel time; Possible colony ship' });
    expect(r.items.find((c) => c.id === '9100')!.pred).toBeUndefined();
  });
  it('is lenient: ts in seconds, unknown fields ignored, bad items skipped and counted, duplicates dropped', () => {
    const cmds = [...(INC.cmds as object[]), { id: 'x', town_id: 'nope', arrival: 1 }, { ...(INC.cmds as object[])[0] }, { id: 5, town_id: 9, arrival: 1795569000123, type: 'attack_takeover', whatever: { deep: 1 } }];
    const r = validateIncoming({ ...INC, ts: Math.floor(NOW / 1000), extra: 'ignored', cmds }, NOW, okW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skipped).toBe(2);
    expect(r.items).toHaveLength(5);
    expect(r.items[4]).toEqual({ id: '5', town_id: 9, town_n: '#9', type: 'conquest', arrival: 1795569000 });
  });
  it('an empty cmds array is valid and means "nothing incoming"', () => {
    const r = validateIncoming({ ...INC, cmds: [] }, NOW, okW);
    expect(r.ok && r.items.length).toBe(0);
  });
  it('rejects a wrong world, a missing list and oversized lists', () => {
    expect(validateIncoming({ ...INC, world: 'en1' }, NOW, okW)).toEqual({ ok: false, err: 'world' });
    expect(validateIncoming({ ...INC, cmds: undefined }, NOW, okW)).toEqual({ ok: false, err: 'invalid' });
    expect(validateIncoming({ ...INC, cmds: Array.from({ length: 501 }, () => ({})) }, NOW, okW)).toEqual({ ok: false, err: 'tooLarge' });
  });
  it('prediction helpers: conf as percent, unit maps, free text; totals only for maps', () => {
    expect(cleanPred({ conf: 86 })).toEqual({ conf: 0.86 });
    expect(cleanPred({ units: { sword: 10, slinger: 5 } })).toEqual({ units: { sword: 10, slinger: 5 } });
    expect(cleanPred({ units: '~300 slingers' })).toEqual({ units: '~300 slingers' });
    expect(cleanPred({ units: ['Bad Id!', 'sword', 'sword'] })).toEqual({ units: ['sword'] });
    expect(unitTotal({ sword: 10, slinger: 5 })).toBe(15);
    expect(unitTotal(['sword'])).toBeNull();
    expect(unitTotal('~300')).toBeNull();
    expect(toSec(1795566386654)).toBe(1795566386);
    expect(toSec(1795566386)).toBe(1795566386);
    expect(toSec(12)).toBeNull();
    expect(normType('ESPIONAGE')).toBe('spy');
    expect(normType('???')).toBe('other');
  });
});

describe('ops feed: real client sample', () => {
  it('accepts the sample exactly and keeps planned vs actual times', () => {
    const r = validateOps(OPS, NOW, okW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skipped).toBe(0);
    const by = Object.fromEntries(r.items.map((o) => [o.id, o]));
    expect(by.cfail1).toMatchObject({ status: 'failed', reason: 'the window had passed', send_at: 1795566226, arrive_at: 1795566286, units: { archer: 10 } });
    expect(by.csent1).toMatchObject({ status: 'sent', send_at: 1795566576, arrive_at: 1795567386, sent_at: 1795566382, arrival: 1795566586 });
    expect(by.csup1).toMatchObject({ kind: 'support', status: 'scheduled', target_player: 'FriendJoe', units: { bireme: 10 } });
    expect(by.cpend1).toMatchObject({ kind: 'attack', target_town_n: 'TargetHold', units: { hoplite: 200, slinger: 50 } });
    const g = groupOps(r.items);
    expect(g.scheduled.map((o) => o.id)).toEqual(['csup1', 'cpend1']);
    expect(g.sent.map((o) => o.id)).toEqual(['csent1']);
    expect(g.failed.map((o) => o.id)).toEqual(['cfail1']);
  });
  it('status aliases and clash detection (attack + support landing within 1 s on one town)', () => {
    const base = (OPS.ops as Record<string, unknown>[])[3];
    const r = validateOps({ ...OPS, ops: [{ ...base, id: 'a', status: 'PENDING' }, { ...base, id: 's', kind: 'support', arrive_at: 1795573587 }, { ...base, id: 'z', status: 'unknown' }] }, NOW, okW);
    expect(r.ok && r.skipped).toBe(1);
    if (!r.ok) return;
    expect(r.items.every((o) => o.status === 'scheduled')).toBe(true);
    expect(opClashes(r.items as SyncOp[])).toEqual([['a', 's']]);
  });
});

describe('alerts selection and text', () => {
  const r = validateIncoming(INC, NOW, okW);
  const cmds = (r.ok ? r.items : []) as IncomingCmd[];
  const nowSec = Math.floor(NOW / 1000);
  it('only hostile, future, new commands of the chosen types; unknown sizes always pass the minimum', () => {
    expect(newAlerts(cmds, new Set(), nowSec, { minSize: 0, types: ['attack', 'conquest', 'revolt'] }).map((c) => c.id)).toEqual(['9003', '9001', '9002']);
    expect(newAlerts(cmds, new Set(['9001']), nowSec, { minSize: 500, types: ['attack'] })).toEqual([]);
    expect(newAlerts(cmds, new Set(), nowSec + 100_000, { minSize: 0, types: ['attack'] })).toEqual([]);
    const sized = { ...cmds[2], id: 'big', pred: { units: { sword: 40 } } };
    expect(newAlerts([sized], new Set(), nowSec, { minSize: 100, types: ['attack'] })).toEqual([]);
    expect(newAlerts([sized], new Set(), nowSec, { minSize: 10, types: ['attack'] })).toHaveLength(1);
  });
  it('prediction text shows every group as a percentage, in EN and GR', () => {
    const atk = cmds.find((c) => c.id === '9001')!;
    const en = predText(atk, 'en'), el = predText(atk, 'el');
    expect(en).toContain('86%'); expect(en).toContain('40%'); expect(en).toContain('12%');
    expect(el).toContain('86%');
    expect(el).not.toBe(en);
    expect(alertLine(atk, 'crashpoum99', 'en')).toContain('<t:1795569986:R>');
  });
});

describe('sync incoming/ops HTTP endpoints', () => {
  it('same key, alias path, 15 s limit with Retry-After, DELETE opt-out, permission-checked reads', async () => {
    let t = NOW;
    const now = () => t;
    const store = new Store(':memory:');
    store.setGuild({ guildId: 'g1', world: 'gr125', lang: 'en', verifiedRoleId: null });
    const gg = new GgService(store, now);
    const { key } = gg.issue('g1', 'u1', 7);
    const c = { store } as unknown as Ctx;
    const secret = 'g'.repeat(32);
    const admin = new AdminService(c, secret, now, new Set(['100000000000000001']), () => null);
    const app = createWebApp({ ctx: c, guilds: { has: () => true, name: () => 'G' }, secret, staticDir: null, fetchImpl: fetch, gg, admin, now,
      hub: new LiveHub(c, async () => [], { pollSeconds: 20, rpm: 5, now }) });
    const srv = http.createServer(app.handler);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Origin: 'https://gr125.grepolis.com' };
    try {
      const a = await fetch(`${base}/api/gg/incoming`, { method: 'POST', headers: auth, body: JSON.stringify(INC) });
      expect(a.status).toBe(200);
      expect(await a.json()).toEqual({ ok: true, cmds: 4, skipped: 0 });
      // Same endpoint again within 15 s → 429 + Retry-After (readable cross-origin).
      const b = await fetch(`${base}/api/sync/incoming`, { method: 'POST', headers: auth, body: JSON.stringify(INC) });
      expect(b.status).toBe(429);
      expect(Number(b.headers.get('retry-after'))).toBe(15);
      expect(b.headers.get('access-control-expose-headers') ?? '').toMatch(/Retry-After/i);
      // The ops endpoint has its own limit; the neutral alias path works.
      const o = await fetch(`${base}/api/sync/ops`, { method: 'POST', headers: auth, body: JSON.stringify(OPS) });
      expect(o.status).toBe(200);
      expect(await o.json()).toEqual({ ok: true, ops: 4, skipped: 0 });
      // Bound to the key's player.
      t += 16_000;
      expect((await fetch(`${base}/api/sync/incoming`, { method: 'POST', headers: auth, body: JSON.stringify({ ...INC, player_id: 8 }) })).status).toBe(400);

      const sess = (u: string) => ({ Authorization: `Bearer ${issueSession(secret, { u, g: 'g1', n: u }, 1, t)}` });
      const inc = await (await fetch(`${base}/api/sync/incoming`, { headers: sess('u1') })).json() as { players: { playerName: string; mine: boolean; items: IncomingCmd[] }[] };
      expect(inc.players[0]).toMatchObject({ playerName: 'crashpoum99', mine: true });
      expect(inc.players[0].items).toHaveLength(4);
      // Ops are admins-only by default; a member without a grant is refused.
      expect((await fetch(`${base}/api/sync/ops`, { headers: sess('u2') })).status).toBe(403);
      store.addGrant({ guildId: 'g1', kind: 'user', targetId: 'u2', scope: 'ops', expiresAt: t + 3600_000, createdBy: 'x', createdAt: t });
      expect((await fetch(`${base}/api/sync/ops`, { headers: sess('u2') })).status).toBe(200);
      t += 2 * 3600_000; // grant expired
      expect((await fetch(`${base}/api/sync/ops`, { headers: { Authorization: `Bearer ${issueSession(secret, { u: 'u2', g: 'g1', n: 'u2' }, 1, t)}` } })).status).toBe(403);

      // Each POST's full list replaces the previous one; empty = clear.
      expect((await fetch(`${base}/api/sync/incoming`, { method: 'POST', headers: auth, body: JSON.stringify({ ...INC, ts: t, cmds: [] }) })).status).toBe(200);
      const s3 = { Authorization: `Bearer ${issueSession(secret, { u: 'u1', g: 'g1', n: 'u1' }, 1, t)}` };
      const cleared = await (await fetch(`${base}/api/sync/incoming`, { headers: s3 })).json() as { players: { items: unknown[] }[] };
      expect(cleared.players[0].items).toHaveLength(0);
      // DELETE opts out.
      expect((await fetch(`${base}/api/sync/ops`, { method: 'DELETE', headers: auth })).status).toBe(200);
      store.addAdmin('g1', 'u1', 'u1', 'x', t);
      const gone = await (await fetch(`${base}/api/sync/ops`, { headers: s3 })).json() as { players: unknown[] };
      expect(gone.players).toHaveLength(0);
    } finally { app.hub.stop(); srv.close(); }
  });
});
