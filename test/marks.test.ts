import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/db.js';
import { MarksService } from '../src/web/marks.js';
import { fitPoints, sanitizeText, simplify, validateMark, MARK_LIMITS } from '../src/web/marksCore.js';
import { markBox, segDist, fmtLeft } from '../web/src/draw.js';
import { createWebApp } from '../src/web/server.js';
import { issueSession } from '../src/web/auth.js';
import { LiveHub } from '../src/web/live.js';
import { WEB_STRINGS } from '../src/web/strings.js';
import type { Ctx } from '../src/services.js';

const ok = { kind: 'arrow', color: '#ff3b3b', width: 4, pts: [450, 530, 460, 540], ttl: '24h' };

describe('markup core', () => {
  it('sanitizes text: no HTML, no control chars, capped', () => {
    expect(sanitizeText('<b>Hi</b> <img src=x onerror=alert(1)> there\u0000\n\tnow')).toBe('Hi there now');
    expect(sanitizeText('a <script>alert(1)</script>')).toBe('a alert(1)');
    expect(sanitizeText('x'.repeat(500))).toHaveLength(MARK_LIMITS.text);
    expect(sanitizeText('5 > 3 < 4')).toBe('5 3 4');
  });
  it('RDP simplifies straight runs and keeps corners; fitPoints enforces the cap', () => {
    const line = Array.from({ length: 100 }, (_, i) => [i, 0]).flat();
    expect(simplify(line, 0.1)).toEqual([0, 0, 99, 0]);
    const corner = [0, 0, 5, 0, 10, 0, 10, 5, 10, 10];
    expect(simplify(corner, 0.1)).toEqual([0, 0, 10, 0, 10, 10]);
    const noisy = Array.from({ length: 5000 }, (_, i) => [i * 0.1, Math.sin(i) * 3]).flat();
    expect(fitPoints(noisy, 0.01).length / 2).toBeLessThanOrEqual(MARK_LIMITS.points);
  });
  it('validates shapes', () => {
    expect(validateMark(ok).ok).toBe(true);
    expect(validateMark({ ...ok, kind: 'polygon' })).toEqual({ ok: false, err: 'kind' });
    expect(validateMark({ ...ok, color: 'red; background:url(x)' })).toEqual({ ok: false, err: 'color' });
    expect(validateMark({ ...ok, width: 99 })).toEqual({ ok: false, err: 'width' });
    expect(validateMark({ ...ok, ttl: '30d' })).toEqual({ ok: false, err: 'ttl' });
    expect(validateMark({ ...ok, pts: [1, 2, 3] })).toEqual({ ok: false, err: 'points' });
    expect(validateMark({ ...ok, pts: [1, 2, 3, 'x'] })).toEqual({ ok: false, err: 'points' });
    expect(validateMark({ ...ok, pts: [1, 2, 3, 4e9] })).toEqual({ ok: false, err: 'points' });
    expect(validateMark({ ...ok, kind: 'pen', pts: Array(MARK_LIMITS.points * 2 + 2).fill(1) })).toEqual({ ok: false, err: 'points' });
    expect(validateMark({ ...ok, kind: 'text', pts: [1, 2], text: '<b></b>' })).toEqual({ ok: false, err: 'text' });
    const t = validateMark({ ...ok, kind: 'text', pts: [1.23456, 2], text: '<i>CS</i> here' });
    expect(t).toEqual({ ok: true, m: { kind: 'text', color: '#ff3b3b', width: 4, pts: [1.23, 2], text: 'CS here', ttl: '24h' } });
  });
  it('client geometry helpers', () => {
    expect(markBox({ kind: 'pen', pts: [5, 9, 1, 3, 7, 2] })).toEqual([1, 2, 7, 9]);
    expect(segDist(5, 5, 0, 0, 10, 0)).toBe(5);
    expect(segDist(-3, 4, 0, 0, 10, 0)).toBe(5);
    expect(fmtLeft(30 * 60_000)).toBe('30m');
    expect(fmtLeft(5 * 3600_000)).toBe('5h');
    expect(fmtLeft(7 * 86400_000)).toBe('7d');
  });
  it('EN and GR strings for every tool', () => {
    for (const k of ['toolPen', 'toolArrow', 'toolCircle', 'toolRect', 'toolLine', 'toolText', 'toolEraser', 'drawUndo', 'drawClearMine', 'drawClearAll', 'drawShow', 'ttl1h', 'ttl7d'] as const) {
      expect(WEB_STRINGS.en[k]).toBeTruthy(); expect(WEB_STRINGS.el[k]).toBeTruthy(); expect(WEB_STRINGS.el[k]).not.toBe(WEB_STRINGS.en[k]);
    }
  });
});

describe('markup service', () => {
  const setup = (manager = false) => {
    let t = 1_000_000;
    const store = new Store(':memory:');
    const svc = new MarksService(store, async (_g, u) => manager && u === 'boss', () => t);
    return { store, svc, adv: (ms: number) => { t += ms; } };
  };
  it('creates, lists with author, bumps the revision and answers unchanged polls with null', async () => {
    const { svc } = setup();
    const r0 = svc.rev('g', 'gr1');
    const c = svc.create('g', 'gr1', 'u1', 'Al', ok);
    expect(c.status).toBe(201);
    const v = await svc.view('g', 'gr1', 'u1');
    expect(v!.rev).not.toBe(r0);
    expect(v!.marks).toHaveLength(1);
    expect(v!.marks[0]).toMatchObject({ author: 'Al', mine: true, kind: 'arrow' });
    expect(JSON.stringify(v)).not.toContain('u1'); // user ids are never sent
    expect((await svc.view('g', 'gr1', 'u2'))!.marks[0].mine).toBe(false);
    expect(await svc.view('g', 'gr1', 'u1', v!.rev)).toBeNull();
    expect((await svc.view('g', 'gr2', 'u1'))!.marks).toHaveLength(0); // per world
    expect((await svc.view('h', 'gr1', 'u1'))!.marks).toHaveLength(0); // per guild
  });
  it('expires shapes (24h default choice, 1h here) and purges them', async () => {
    const { svc, store, adv } = setup();
    svc.create('g', 'w', 'u1', 'Al', { ...ok, ttl: '1h' });
    svc.create('g', 'w', 'u1', 'Al', { ...ok, ttl: '7d' });
    const v1 = await svc.view('g', 'w', 'u1');
    expect(v1!.marks).toHaveLength(2);
    adv(3600_000 + 1);
    const v2 = await svc.view('g', 'w', 'u1', v1!.rev); // revision moved because a shape expired
    expect(v2!.marks).toHaveLength(1);
    expect(svc.purge()).toBe(1);
    expect(store.countMarks('g', 'w', 0)).toBe(1);
  });
  it('only the author or a manager deletes; clear mine vs clear all', async () => {
    const { svc } = setup(true);
    const a = svc.create('g', 'w', 'u1', 'Al', ok) as { body: { mark: { id: number } } };
    svc.create('g', 'w', 'u2', 'Bo', ok);
    svc.create('g', 'w', 'u2', 'Bo', ok);
    expect((await svc.remove('g', 'w', 'u2', a.body.mark.id)).status).toBe(403);
    expect((await svc.remove('g', 'w', 'u1', a.body.mark.id)).status).toBe(200);
    expect((await svc.clear('g', 'w', 'u1', true)).status).toBe(403); // not a manager
    expect((await svc.clear('g', 'w', 'u2', false) as { body: { removed: number } }).body.removed).toBe(2);
    svc.create('g', 'w', 'u2', 'Bo', ok);
    expect((await svc.view('g', 'w', 'boss'))!.canClearAll).toBe(true);
    expect((await svc.clear('g', 'w', 'boss', true) as { body: { removed: number } }).body.removed).toBe(1);
  });
  it('rate limits and caps per user and per guild', () => {
    const { svc, adv } = setup();
    let last = 0;
    for (let i = 0; i < MARK_LIMITS.writesPerMin + 1; i++) last = svc.create('g', 'w', 'u1', 'Al', ok).status;
    expect(last).toBe(429);
    adv(61_000);
    // per-user cap
    for (let i = 0; i < MARK_LIMITS.perUser; i++) { if (i && i % MARK_LIMITS.writesPerMin === 0) adv(61_000); svc.create('g', 'w', 'u1', 'Al', ok); }
    adv(61_000);
    expect(svc.create('g', 'w', 'u1', 'Al', ok)).toMatchObject({ status: 409, err: 'web.marks.userFull' });
    // per-guild cap
    let n = MARK_LIMITS.perUser;
    for (let u = 2; n < MARK_LIMITS.perGuild; u++) for (let i = 0; i < MARK_LIMITS.perUser && n < MARK_LIMITS.perGuild; i++) { if (i && i % MARK_LIMITS.writesPerMin === 0) adv(61_000); svc.create('g', 'w', `u${u}`, 'X', ok); n++; }
    adv(61_000);
    expect(svc.create('g', 'w', 'u99', 'Z', ok)).toMatchObject({ status: 409, err: 'web.marks.full' });
    expect(svc.create('g', 'w', 'u99', 'Z', { ...ok, kind: 'nope' })).toMatchObject({ status: 400 });
  });
  it('keeps existing data: the table is additive (re-opening the schema is a no-op)', () => {
    const { store } = setup();
    store.addMark({ guildId: 'g', world: 'w', userId: 'u', author: 'A', kind: 'pen', color: '#ffffff', width: 2, pts: [1, 2, 3, 4], text: '', createdAt: 1, expiresAt: 9e15 });
    store.db.exec('CREATE TABLE IF NOT EXISTS map_marks (id INTEGER PRIMARY KEY)');
    expect(store.countMarks('g', 'w', 0)).toBe(1);
  });
});

describe('markup HTTP API', () => {
  it('needs a session and the CSRF header; GET 204 when unchanged; text is sanitized', async () => {
    const store = new Store(':memory:');
    store.setGuild({ guildId: 'g1', world: 'gr999', lang: 'en', verifiedRoleId: null });
    const c = { store } as unknown as Ctx;
    const secret = 'm'.repeat(32);
    const app = createWebApp({ ctx: c, guilds: { has: () => true, name: () => 'G', manager: async () => false }, secret, staticDir: null, fetchImpl: fetch,
      hub: new LiveHub(c, async () => [], { pollSeconds: 20, rpm: 5, now: Date.now }) });
    const srv = http.createServer(app.handler);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const auth = { Authorization: `Bearer ${issueSession(secret, { u: 'u1', g: 'g1', n: 'Al' })}` };
      expect((await fetch(`${base}/api/marks`)).status).toBe(401);
      const v0 = await (await fetch(`${base}/api/marks`, { headers: auth })).json() as { rev: number; marks: unknown[]; canClearAll: boolean };
      expect(v0).toMatchObject({ marks: [], canClearAll: false });
      expect((await fetch(`${base}/api/marks?rev=${v0.rev}`, { headers: auth })).status).toBe(204);
      const body = JSON.stringify({ kind: 'text', color: '#ffffff', width: 4, pts: [450, 530], text: '<img src=x onerror=1>Go <b>here</b>', ttl: '6h' });
      expect((await fetch(`${base}/api/marks`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body })).status).toBe(403); // no X-GC
      const r = await fetch(`${base}/api/marks`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-GC': '1' }, body });
      expect(r.status).toBe(201);
      const created = await r.json() as { mark: { id: number; text: string; author: string } };
      expect(created.mark).toMatchObject({ text: 'Go here', author: 'Al' });
      const v1 = await (await fetch(`${base}/api/marks?rev=${v0.rev}`, { headers: auth })).json() as { marks: unknown[] };
      expect(v1.marks).toHaveLength(1);
      const del = await fetch(`${base}/api/marks/delete`, { method: 'POST', headers: { ...auth, 'X-GC': '1' }, body: JSON.stringify({ id: created.mark.id }) });
      expect(del.status).toBe(200);
      const all = await fetch(`${base}/api/marks/clear`, { method: 'POST', headers: { ...auth, 'X-GC': '1' }, body: JSON.stringify({ all: true }) });
      expect(all.status).toBe(403);
      expect((await fetch(`${base}/api/marks/nope`, { method: 'POST', headers: { ...auth, 'X-GC': '1' } })).status).toBe(405);
    } finally { app.hub.stop(); srv.close(); }
  });
});
