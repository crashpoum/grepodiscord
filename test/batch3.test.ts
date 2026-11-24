import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/db.js';
import { buildSnapshot } from '../src/data/snapshot.js';
import { GrepoDataClient, type GdSharedCommand } from '../src/data/grepodata.js';
import { config } from '../src/config.js';
import { issueSession, sign, verify, webSecret, bearer } from '../src/web/auth.js';
import { activeCommands, Budget, LiveHub, normUnits } from '../src/web/live.js';
import { buildMapPayload } from '../src/web/mapData.js';
import { createWebApp, dashboardLink, type BotGuilds } from '../src/web/server.js';
import { esc, messagePage } from '../src/web/pages.js';
import { checkActivityApp, readActivityInfo, setActivityState } from '../src/web/activityCheck.js';
import { activityUrl, handleLiveMap, handleWebButton, launchPlan, OPEN_PREFIX } from '../src/bot/webHandlers.js';
import { ownerAtTime, townXY, allianceColor } from '../web/src/geo.js';
import { WEB_STRINGS, wt } from '../src/web/strings.js';
import { STRINGS } from '../src/i18n.js';
import { commandJson } from '../src/bot/commands.js';
import type { Ctx } from '../src/services.js';
import type { WorldManager } from '../src/refresh.js';
import { files } from './helpers.js';

const NOW = 1_800_000_000;
const D = 86400;
const jwt = (p: object) => `x.${Buffer.from(JSON.stringify(p)).toString('base64url')}.y`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function world() {
  return buildSnapshot('gr999', files({
    players: ['1,Alice,10,5000,1,2', '2,Bob,20,3000,2,1'].join('\n'),
    alliances: ['10,Red,5000,2,1,1', '20,Blue,3000,1,1,2'].join('\n'),
    towns: ['100,1,Alice+1,450,530,1,6000', '101,1,Alice+2,460,540,2,4000', '200,2,Bob+1,452,533,3,9000', '600,,Ghost,453,534,8,1200'].join('\n'),
    conquers: [`101,${NOW - 3 * D},1,2,10,20,4000`, `101,${NOW - 10 * D},2,0,20,0,3000`].join('\n'),
    player_kills_att: '1,1,9000', player_kills_def: '1,1,6000',
  }));
}

function ctxWith(fetchImpl: typeof fetch): Ctx {
  const store = new Store(':memory:');
  const sn = world();
  const worlds = { ensure: async () => sn, get: () => sn } as unknown as WorldManager;
  store.setGuild({ guildId: 'g1', world: 'gr999', lang: 'el', verifiedRoleId: null });
  return { store, worlds, gd: new GrepoDataClient('https://gd', 1000, fetchImpl, async () => {}) } as Ctx;
}
const withToken = (c: Ctx) => {
  const exp = Date.now() + 3_600_000;
  c.store.setGdToken({ guildId: 'g1', accessToken: jwt({ exp: Math.floor(exp / 1000) }), refreshToken: null, accessExp: exp, refreshExp: null, adminUserId: null, source: 'command' });
};

describe('web sessions', () => {
  it('signs, verifies, rejects tampering and expiry', () => {
    const tok = issueSession('s'.repeat(32), { u: 'u1', g: 'g1' }, 1, 1000);
    expect(verify(tok, 's'.repeat(32), 2000)).toMatchObject({ u: 'u1', g: 'g1' });
    expect(verify(tok, 's'.repeat(32), 1000 + 3_600_001)).toBeNull();
    expect(verify(tok, 'other-secret-xxxxxxxx', 2000)).toBeNull();
    const [body, mac] = tok.split('.');
    const forged = `${Buffer.from(JSON.stringify({ u: 'u1', g: 'g2', exp: 9e15 })).toString('base64url')}.${mac}`;
    expect(verify(forged, 's'.repeat(32), 2000)).toBeNull();
    expect(verify(`${body}.`, 's'.repeat(32), 2000)).toBeNull();
    expect(verify(sign({ exp: 'x' }, 'k'), 'k')).toBeNull();
    expect(bearer('Bearer abc.def')).toBe('abc.def');
    expect(bearer('Basic x')).toBeNull();
  });
  it('generates one secret and keeps it in the DB; WEB_SECRET wins', () => {
    const store = new Store(':memory:');
    const a = webSecret(store, '');
    expect(a.length).toBeGreaterThan(30);
    expect(webSecret(store, '')).toBe(a);
    expect(webSecret(store, 'x'.repeat(20))).toBe('x'.repeat(20));
  });
  it('dashboard links carry the token in the query of /go/<tab> (no #fragment)', () => {
    const old = config.publicUrl;
    config.publicUrl = 'https://live.example.com';
    const l = dashboardLink('k'.repeat(32), 'g1', 'u1', 'Al', 'map', 12, 1000)!;
    expect(l.startsWith('https://live.example.com/go/map?t=')).toBe(true);
    expect(l).not.toContain('#');
    expect(verify(new URL(l).searchParams.get('t'), 'k'.repeat(32), 2000)).toMatchObject({ g: 'g1', u: 'u1', k: 'link' });
    config.publicUrl = '';
    expect(dashboardLink('k', 'g', 'u', 'n', 'live', 1)).toBeNull();
    config.publicUrl = old;
  });
});

describe('/live and /map launch', () => {
  it('builds the Activity link with custom_id and refuses foreign hosts', () => {
    expect(activityUrl('map', 'https://discord.com/activities/?link_id=0-123')).toBe('https://discord.com/activities/?link_id=0-123&custom_id=map');
    expect(activityUrl('live', 'https://evil.example/?x')).toBeNull();
    expect(activityUrl('live', '')).toBeNull();
    expect(activityUrl('live', 'https://discord.com/activities/42')).toBe('https://discord.com/activities/42?custom_id=live');
  });
  it('chooses shared / private / none', () => {
    expect(launchPlan('live', false, { activity: null, browser: null }).kind).toBe('none');
    expect(launchPlan('live', true, { activity: 'a', browser: 'b' }).kind).toBe('shared');
    expect(launchPlan('live', true, { activity: null, browser: 'b' }).kind).toBe('shared'); // public even without the Activity
    expect(launchPlan('map', false, { activity: 'a', browser: null }).kind).toBe('private');
  });
  it('registers /live and /map with Greek names', () => {
    const cmds = commandJson() as { name: string; name_localizations?: Record<string, string> }[];
    expect(cmds.find((c) => c.name === 'live')?.name_localizations?.el).toBe('ζωντανά');
    expect(cmds.find((c) => c.name === 'map')?.name_localizations?.el).toBe('χάρτης');
  });
  it('has every web string in English and Greek', () => {
    expect(Object.keys(WEB_STRINGS.el).sort()).toEqual(Object.keys(WEB_STRINGS.en).sort());
    for (const k of Object.keys(STRINGS.en).filter((x) => x.startsWith('web.'))) expect(STRINGS.el[k as keyof typeof STRINGS.el]).not.toBe(STRINGS.en[k as keyof typeof STRINGS.en]);
    expect(wt('el', 'updated', { s: 5 })).toBe('Ενημέρωση πριν 5δ');
  });
});

describe('live hub', () => {
  const cmd = (id: string, arrival: number, extra: Partial<GdSharedCommand> = {}): GdSharedCommand =>
    ({ es_id: id, arrival_at: arrival, type: 'attack', src_all_id: 20, src_twn_n: 'Bob 1', trg_all_id: 10, trg_twn_n: 'Alice 1', units: '{"sword":10,"slinger":0}', ...extra });
  it('normalizes units and filters/sorts commands', () => {
    expect(normUnits('{"sword":10,"slinger":0}')).toEqual([['sword', 10]]);
    expect(normUnits([{ name: 'hoplite', count: '5' }])).toEqual([['hoplite', 5]]);
    const out = activeCommands([cmd('b', NOW + 50), cmd('a', NOW + 10), cmd('old', NOW - 120), cmd('del', NOW + 5, { delete_status: 'hard' }), cmd('o', NOW + 20, { src_all_id: 10, trg_all_id: 20 })], new Set([10]), NOW);
    expect(out.map((c) => c.id)).toEqual(['a', 'o', 'b']);
    expect(out[0].side).toBe('in');
    expect(out[1].side).toBe('out');
  });
  it('budget caps requests per minute', () => {
    let t = 0;
    const b = new Budget(2, () => t);
    expect(b.take()).toBe(true); expect(b.take()).toBe(true); expect(b.take()).toBe(false);
    t = 61_000;
    expect(b.take()).toBe(true);
  });
  it('polls with the guild token, merges incremental pulls and fans out one snapshot', async () => {
    const calls: string[] = [];
    let nowMs = NOW * 1000;
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      calls.push(url.replace('https://gd', ''));
      expect((init?.headers as Record<string, string>).access_token).toBeTruthy();
      if (url.includes('/commands/activeteams')) return json({ success: true, operations: [{ index: 'abcd1234', team: 'Red ops', world: 'gr999', players: 3 }, { index: 'zzzz9999', world: 'gr1' }] });
      if (url.includes('/commands/get')) {
        return url.includes('last_get_cmd=0')
          ? json({ success: true, success_code: 8000, updated_at: NOW, items: [cmd('a', NOW + 100), cmd('b', NOW + 200)] })
          : json({ success: true, success_code: 8000, updated_at: NOW + 20, items: [cmd('b', NOW + 200, { delete_status: 'hard' }), cmd('c', NOW + 300)] });
      }
      if (url.includes('/indexer/v2/getindex')) return json({ total_reports: 7, spy_reports: 2, enemy_attacks: 3, latest_intel: [{ town_id: 200, town_name: 'Bob 1', player_name: 'Bob', date: '01-01-27 10:00:00', units: [{ name: 'sword', count: 4 }] }] });
      return json({}, 404);
    }) as typeof fetch;
    const c = ctxWith(fetchImpl);
    withToken(c);
    const hub = new LiveHub(c, async () => [10], { pollSeconds: 20, rpm: 10, now: () => nowMs });
    const first = await hub.view('g1', 'en'); // marks a viewer
    expect(first.warming).toBe(true);
    hub.stop();
    await hub.tick('g1');
    let v = await hub.view('g1', 'en');
    hub.stop();
    expect(v.teams).toEqual([{ key: 'abcd1234', name: 'Red ops', commands: 0, players: 3 }]);
    expect(v.commands.map((x) => x.id)).toEqual(['a', 'b']);
    expect(v.commands[0].side).toBe('in');
    expect(v.stats).toEqual({ reports: 7, spies: 2, attacks: 3 });
    expect(v.intel[0]).toMatchObject({ town: 'Bob 1', units: [['sword', 4]] });
    nowMs += 20_000;
    await hub.tick('g1');
    v = await hub.view('g1', 'en');
    hub.stop();
    expect(v.commands.map((x) => x.id)).toEqual(['a', 'c']);
    expect(calls.filter((x) => x.includes('activeteams'))).toHaveLength(1); // teams cached 5 min
    expect(calls.filter((x) => x.includes('getindex'))).toHaveLength(1); // overview cached 5 min
    expect(calls.some((x) => x.includes('last_get_cmd=' + NOW))).toBe(true);
    // idle: no viewer for >90 s -> no more requests
    nowMs += 120_000;
    const n = calls.length;
    await hub.tick('g1');
    expect(calls.length).toBe(n);
  });
  it('explains a missing token or team in the guild language', async () => {
    const c = ctxWith((async () => json({ success: false, error_code: 7202, message: 'User is not in any teams' })) as typeof fetch);
    const hub = new LiveHub(c, async () => [], { pollSeconds: 20, rpm: 10, now: () => NOW * 1000 });
    await hub.view('g1', 'el'); hub.stop();
    await hub.tick('g1');
    let v = await hub.view('g1', 'el'); hub.stop();
    expect(v.error).toBe(STRINGS.el['intel.noToken']);
    withToken(c);
    await hub.tick('g1');
    v = await hub.view('g1', 'el'); hub.stop();
    expect(v.error).toContain('gr999');
    expect(v.error).toBe(STRINGS.el['web.err.noTeams'].replace('{world}', 'gr999'));
  });
});

describe('map payload and timeline', () => {
  it('builds compact arrays, oldest conquest first', () => {
    const p = buildMapPayload(world(), { ours: [10], enemies: [20] }, { now: NOW * 1000 });
    expect(p.towns).toHaveLength(4);
    expect(p.towns.find((x) => x[0] === 600)?.[4]).toBe(0);
    expect(p.conquests.map((c) => c[0])).toEqual([NOW - 10 * D, NOW - 3 * D]);
    expect(p.sides).toEqual({ ours: [10], enemies: [20] });
  });
  it('replays owners backwards from today', () => {
    const hist = [{ time: NOW - 10 * D, newP: 2, oldP: 0, newA: 20, oldA: 0 }, { time: NOW - 3 * D, newP: 1, oldP: 2, newA: 10, oldA: 20 }];
    const cur = { p: 1, a: 10 };
    expect(ownerAtTime(cur, hist, NOW, NOW)).toEqual(cur);
    expect(ownerAtTime(cur, hist, NOW - 5 * D, NOW)).toEqual({ p: 2, a: 20 });
    expect(ownerAtTime(cur, hist, NOW - 20 * D, NOW)).toEqual({ p: 0, a: 0 });
    expect(ownerAtTime(cur, undefined, NOW - 20 * D, NOW)).toEqual(cur);
    const [x, y] = townXY(450, 530, 3);
    expect(Math.abs(x - 450.5)).toBeLessThan(0.5); expect(Math.abs(y - 530.5)).toBeLessThan(0.5);
    expect(allianceColor(10)).toMatch(/^hsl\(/);
  });
});

describe('web server', () => {
  async function serve(c: Ctx, fetchImpl: typeof fetch, guilds = ['g1']) {
    const secret = 'z'.repeat(32);
    const app = createWebApp({ ctx: c, guilds: { has: (g) => guilds.includes(g), name: (g) => (g === 'g1' ? 'Red server' : null), check: async (g) => (guilds.includes(g) ? 'yes' : 'no') }, secret, staticDir: null, fetchImpl,
      hub: new LiveHub(c, async () => [10], { pollSeconds: 20, rpm: 5, now: Date.now }) });
    const srv = http.createServer(app.handler);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    return { base, secret, close: () => { app.hub.stop(); srv.close(); } };
  }
  it('requires a session for data and serves me/map with one', async () => {
    const c = ctxWith((async () => json({}, 404)) as typeof fetch);
    const s = await serve(c, fetch);
    try {
      expect((await fetch(`${s.base}/api/me`)).status).toBe(401);
      const auth = { Authorization: `Bearer ${issueSession(s.secret, { u: 'u1', g: 'g1', n: 'Al' })}` };
      const me = await (await fetch(`${s.base}/api/me`, { headers: auth })).json() as { world: string; lang: string; guild: string; units: Record<string, string> };
      expect(me).toMatchObject({ world: 'gr999', lang: 'el', guild: 'Red server' });
      expect(me.units.sword).toBeTruthy();
      const map = await (await fetch(`${s.base}/api/map`, { headers: auth })).json() as { towns: unknown[] };
      expect(map.towns).toHaveLength(4);
      const other = { Authorization: `Bearer ${issueSession(s.secret, { u: 'u1', g: 'g9' })}` };
      expect((await fetch(`${s.base}/api/me`, { headers: other })).status).toBe(200); // signed by the bot: trusted even if it is not a guild member
      expect((await fetch(`${s.base}/terms`)).status).toBe(200);
      expect(await (await fetch(`${s.base}/privacy`)).text()).toContain('Πολιτική απορρήτου');
      const cfgJs = await (await fetch(`${s.base}/config.js`)).text();
      expect(cfgJs).toContain('window.__GC=');
      expect(cfgJs).not.toContain(config.activityClientSecret || 'never-a-secret');
      const page = await fetch(`${s.base}/live`);
      expect(page.status).toBe(503); // no bundle in this test
      expect(page.headers.get('content-security-policy')).toContain('frame-ancestors');
    } finally { s.close(); }
  });
  it('exchanges the Activity code and checks guild membership', async () => {
    const old = [config.activityClientId, config.activityClientSecret];
    config.activityClientId = '123'; config.activityClientSecret = 'sec';
    const discord = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.endsWith('/oauth2/token')) {
        const body = new URLSearchParams(String(init?.body));
        return body.get('code') === 'good' && body.get('client_secret') === 'sec' ? json({ access_token: 'dtok' }) : json({ error: 'invalid_grant' }, 400);
      }
      if (url.endsWith('/users/@me')) return json({ id: 'u1', username: 'al', global_name: 'Al' });
      if (url.endsWith('/users/@me/guilds')) return json([{ id: '111111', name: 'Red' }]);
      return json({}, 404);
    }) as typeof fetch;
    const c = ctxWith((async () => json({}, 404)) as typeof fetch);
    c.store.setGuild({ guildId: '111111', world: 'gr999', lang: 'el', verifiedRoleId: null });
    const s = await serve(c, discord, ['111111']);
    const post = (b: unknown) => fetch(`${s.base}/api/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    try {
      const ok = await post({ code: 'good', guild_id: '111111' });
      const okBody = await ok.json() as { access_token: string; session: string };
      expect(ok.status).toBe(200);
      expect(okBody.access_token).toBe('dtok');
      expect(verify(okBody.session, s.secret)).toMatchObject({ u: 'u1', g: '111111', k: 'activity' });
      const bad = await post({ code: 'bad', guild_id: '111111' });
      expect(bad.status).toBe(401);
      expect(((await bad.json()) as { error: string }).error).toBe(STRINGS.el['web.err.oauth']);
      expect((await post({ code: 'good', guild_id: '99999999' })).status).toBe(403); // not a member
      expect((await post({ code: 'good' })).status).toBe(400); // DM
    } finally { s.close(); [config.activityClientId, config.activityClientSecret] = old; }
  });
});

describe('fixes: personal link behind the tunnel, public share', () => {
  const SECRET = 'q'.repeat(32);
  async function stack(c: Ctx, guilds: BotGuilds = { has: (g) => g === 'g1', name: () => 'Red', check: async (g) => (g === 'g1' ? 'yes' : 'no') }, secret = SECRET) {
    const app = createWebApp({ ctx: c, guilds, secret, staticDir: null, fetchImpl: fetch,
      hub: new LiveHub(c, async () => [], { pollSeconds: 20, rpm: 5, now: Date.now }) });
    const bot = http.createServer(app.handler);
    await new Promise<void>((r) => bot.listen(0, '127.0.0.1', () => r()));
    const botPort = (bot.address() as AddressInfo).port;
    // Stand-in for cloudflared: plain http to the bot, X-Forwarded-Proto: https, CF-Connecting-IP.
    const proxy = http.createServer((req, res) => {
      const up = http.request({ host: '127.0.0.1', port: botPort, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.9' } }, (r) => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
      req.pipe(up);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    return { base: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, close: () => { app.hub.stop(); bot.close(); proxy.close(); } };
  }

  it('a fresh /live link logs in through the proxy: cookie (Secure, HttpOnly) + redirect to the clean URL, then the API works', async () => {
    const old = config.publicUrl;
    config.publicUrl = 'https://grepo.example.com';
    const c = ctxWith((async () => json({}, 404)) as typeof fetch);
    const st = await stack(c);
    try {
      const link = dashboardLink(SECRET, 'g1', 'u1', 'Μέλος 🛡️', 'live', 12)!;
      const r = await fetch(`${st.base}${new URL(link).pathname}${new URL(link).search}`, { redirect: 'manual' });
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe('/live');
      expect(r.headers.get('cache-control')).toBe('no-store');
      const cookie = r.headers.get('set-cookie')!;
      expect(cookie).toMatch(/^gc_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=4319\d; Secure$/);
      const me = await fetch(`${st.base}/api/me`, { headers: { Cookie: cookie.split(';')[0] } });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ guildId: 'g1', user: 'Μέλος 🛡️' });
      // no cookie at all -> "please open it from Discord" (reason none), not "expired"
      const none = await fetch(`${st.base}/api/me`);
      expect(none.status).toBe(401);
      expect(await none.json()).toMatchObject({ reason: 'none', error: STRINGS.en['web.freshLink'] });
    } finally { st.close(); config.publicUrl = old; }
  });

  it('says WHY a link is refused: other signing key, expired, bot not in the server', async () => {
    const c = ctxWith((async () => json({}, 404)) as typeof fetch);
    const st = await stack(c);
    try {
      const other = issueSession('another-process-key-xxxxxxxxxxxx', { u: 'u1', g: 'g1' });
      const bad = await fetch(`${st.base}/go/live?t=${other}`, { redirect: 'manual' });
      expect(bad.status).toBe(401);
      expect(await bad.text()).toContain('not signed by this bot');
      const old = issueSession(SECRET, { u: 'u1', g: 'g1' }, 1, Date.now() - 2 * 3600_000);
      const exp = await fetch(`${st.base}/api/me`, { headers: { Authorization: `Bearer ${old}` } });
      expect(await exp.json()).toMatchObject({ reason: 'expired' });
      const foreign = issueSession(SECRET, { u: 'u1', g: 'g9' });
      expect(await (await fetch(`${st.base}/api/me`, { headers: { Authorization: `Bearer ${foreign}` } })).json()).toMatchObject({ guildId: 'g9' });
    } finally { st.close(); }
  });

  it('trusts the signed link when the guild is missing from the gateway cache (the reported "not a member" bug)', async () => {
    const c = ctxWith((async () => json({}, 404)) as typeof fetch);
    const g = '1173401431538151496';
    c.store.setGuild({ guildId: g, world: 'gr999', lang: 'el', verifiedRoleId: null });
    const asked: string[] = [];
    // cache empty (reconnecting / not ready), REST says yes or cannot tell -> logged in; member lookup may fail softly
    for (const check of [async () => 'yes' as const, async () => 'unknown' as const, async () => { throw new Error('network'); }, undefined]) {
      const st = await stack(c, { has: () => false, name: () => null, check, member: async (gg, u) => { asked.push(`${gg}/${u}`); throw new Error('rate limited'); } });
      try {
        const link = issueSession(SECRET, { u: 'u5', g });
        const r = await fetch(`${st.base}/go/live?t=${link}`, { redirect: 'manual' });
        expect(r.status).toBe(302);
        const me = await fetch(`${st.base}/api/me`, { headers: { Cookie: r.headers.get('set-cookie')!.split(';')[0] } });
        expect(me.status).toBe(200);
        expect(await me.json()).toMatchObject({ guildId: g });
      } finally { st.close(); }
    }
    expect(asked).toContain(`${g}/u5`);
  });

  it('a signed link works even when the bot user is not a member (commands-only install); refused only if the user left', async () => {
    const c = ctxWith((async () => json({}, 404)) as typeof fetch);
    const gone = await stack(c, { has: () => false, name: () => null, check: async () => 'no' });
    try {
      const r = await fetch(`${gone.base}/go/live?t=${issueSession(SECRET, { u: 'u1', g: 'g1' })}`, { redirect: 'manual' });
      expect(r.status).toBe(302);
    } finally { gone.close(); }
    const left = await stack(c, { has: (g) => g === 'g1', name: () => 'Red', member: async () => 'no' });
    try {
      const r = await fetch(`${left.base}/go/map?t=${issueSession(SECRET, { u: 'u1', g: 'g1' })}`, { redirect: 'manual' });
      expect(r.status).toBe(403);
      expect(await r.text()).toContain(esc(STRINGS.el['web.err.left']));
    } finally { left.close(); }
  });

  it('without Discord login configured, pages hide "Sign in with Discord" and say to open a fresh link (EN + GR)', async () => {
    const c = ctxWith((async () => json({}, 404)) as typeof fetch);
    const old = { id: config.activityClientId, sec: config.activityClientSecret };
    config.activityClientId = ''; config.activityClientSecret = '';
    const st = await stack(c);
    try {
      const login = await (await fetch(`${st.base}/login`)).text();
      expect(login).not.toContain('href="/login"');
      expect(login).toContain(esc(STRINGS.en['web.freshLink']));
      const bad = await (await fetch(`${st.base}/go/live?t=${issueSession('another-process-key-xxxxxxxxxxxx', { u: 'u1', g: 'g1' })}`)).text();
      expect(bad).not.toContain('href="/login"');
      expect(bad).not.toContain(STRINGS.en['web.loginLink']);
      expect(bad).toContain(esc(STRINGS.en['web.freshLink']));
      // the "bot left" page is in the guild's language (el here)
    } finally { st.close(); config.activityClientId = old.id; config.activityClientSecret = old.sec; }
    const gr = messagePage('el', STRINGS.el['web.err.noOAuth'], { login: false, hint: true });
    expect(gr).toContain(esc(STRINGS.el['web.freshLink']));
    expect(gr).not.toContain('/login"');
    expect(messagePage('el', 'x', { login: true })).toContain('href="/login"');
    expect(STRINGS.el['web.freshLink']).toMatch(/\/live/);
    expect(STRINGS.el['web.freshLink']).not.toBe(STRINGS.en['web.freshLink']);
  });

  function fakeInteraction(commandName: string, share: boolean) {
    const calls: { kind: string; payload: any }[] = [];
    const ser = (p: unknown) => JSON.parse(JSON.stringify(p, (_k, v) => (v && typeof v.toJSON === 'function' ? v.toJSON() : v)));
    const i: any = { guildId: 'g1', commandName, customId: `${OPEN_PREFIX}map`, user: { id: 'u7', username: 'friend' }, member: { displayName: 'Friend' },
      options: { getBoolean: () => share },
      reply: async (p: unknown) => { calls.push({ kind: 'reply', payload: ser(p) }); }, followUp: async (p: unknown) => { calls.push({ kind: 'followUp', payload: ser(p) }); } };
    return { i, calls };
  }

  it('share:true posts PUBLICLY with a per-click button, never a personal link (with and without the Activity)', async () => {
    const saved = [config.publicUrl, config.webEnabled, config.activityClientId, config.activityLink];
    config.publicUrl = 'https://grepo.example.com'; config.webEnabled = true; config.activityLink = '';
    const c = ctxWith((async () => json({}, 404)) as typeof fetch);
    try {
      for (const act of ['', '1234567890']) {
        config.activityClientId = act;
        const { i, calls } = fakeInteraction('map', true);
        await handleLiveMap(c, i, 'el', 'gr999');
        expect(calls).toHaveLength(1);
        const p = calls[0].payload;
        expect(p.flags ?? 0).toBe(0); // not ephemeral
        const text = JSON.stringify(p);
        expect(text).not.toContain('/go/');
        expect(text).not.toContain('?t=');
        const buttons = p.components[0].components;
        expect(buttons.find((b: any) => b.custom_id === `${OPEN_PREFIX}map`)).toBeTruthy();
        if (act) expect(text).toContain(`https://discord.com/activities/${act}?custom_id=map`);
      }
      // a clicker gets their OWN private link
      const { i, calls } = fakeInteraction('map', true);
      await handleWebButton(c, i);
      const p = calls[0].payload;
      expect(p.flags).toBe(64);
      const url = p.components[0].components[0].url as string;
      expect(url.startsWith('https://grepo.example.com/go/map?t=')).toBe(true);
      expect(verify(new URL(url).searchParams.get('t'), webSecret(c.store))).toMatchObject({ u: 'u7', g: 'g1' });
      // ...and that per-click link logs the clicker in even when the gateway cache misses the guild
      const st = await stack(c, { has: () => false, name: () => null, check: async () => 'unknown', member: async () => 'yes' }, webSecret(c.store));
      try {
        const r = await fetch(`${st.base}/go/map?t=${new URL(url).searchParams.get('t')}`, { redirect: 'manual' });
        expect(r.status).toBe(302);
        expect(r.headers.get('location')).toBe('/map');
      } finally { st.close(); }
      // without share: private reply with the personal link
      const priv = fakeInteraction('live', false);
      await handleLiveMap(c, priv.i, 'en', 'gr999');
      expect(priv.calls[0].payload.flags).toBe(64);
    } finally { [config.publicUrl, config.webEnabled, config.activityClientId, config.activityLink] = saved as [string, boolean, string, string]; }
  });
});

describe('fixes: Discord login callback and the Activity button', () => {
  const SECRET = 'w'.repeat(32);
  async function app(c: Ctx, fetchImpl: typeof fetch, guilds: BotGuilds) {
    const a = createWebApp({ ctx: c, guilds, secret: SECRET, staticDir: null, fetchImpl, hub: new LiveHub(c, async () => [], { pollSeconds: 20, rpm: 5, now: Date.now }) });
    const srv = http.createServer(a.handler);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => { a.hub.stop(); srv.close(); } };
  }
  const discord = (guildIds: string[], tokenErr?: { error: string; error_description?: string }) => (async (u: string, init?: RequestInit) => {
    const url = String(u);
    if (url.endsWith('/oauth2/token')) {
      const b = new URLSearchParams(String(init?.body));
      expect(b.get('redirect_uri')).toBe('https://grepo.example.com/oauth/callback');
      return tokenErr ? json(tokenErr, 401) : json({ access_token: 'dtok' });
    }
    if (url.endsWith('/users/@me')) return json({ id: 'u1', username: 'al', global_name: 'Al' });
    if (url.endsWith('/users/@me/guilds')) return json(guildIds.map((id) => ({ id, name: 'x' })));
    return json({}, 404);
  }) as typeof fetch;
  const withOAuth = async (fn: () => Promise<void>) => {
    const old = [config.activityClientId, config.activityClientSecret, config.publicUrl] as const;
    config.activityClientId = '1574880931146236087'; config.activityClientSecret = 'sec'; config.publicUrl = 'https://grepo.example.com';
    try { await fn(); } finally { [config.activityClientId, config.activityClientSecret, config.publicUrl] = old; }
  };
  const stateFrom = async (base: string) => new URL((await fetch(`${base}/login?next=map`, { redirect: 'manual' })).headers.get('location')!).searchParams.get('state')!;

  it('builds the authorize URL exactly as Discord documents it', async () => withOAuth(async () => {
    const c = ctxWith((async () => json({}, 404)) as typeof fetch);
    const s = await app(c, discord([]), { has: () => true, name: () => 'Red' });
    try {
      const loc = (await fetch(`${s.base}/login`, { redirect: 'manual' })).headers.get('location')!;
      expect(loc).toMatch(/^https:\/\/discord\.com\/oauth2\/authorize\?response_type=code&client_id=1574880931146236087&scope=identify%20guilds&redirect_uri=https%3A%2F%2Fgrepo\.example\.com%2Foauth%2Fcallback&state=[\w.-]+$/);
      expect(loc).not.toContain('prompt=');
      expect(loc.length).toBeLessThan(400);
    } finally { s.close(); }
  }));

  it('logs in the reported user even when the main bot is not a member of the guild (commands-only install)', async () => withOAuth(async () => {
    const c = ctxWith((async () => json({}, 404)) as typeof fetch);
    const g = '1173401431538151496';
    c.store.setGuild({ guildId: g, world: 'gr999', lang: 'el', verifiedRoleId: null });
    const s = await app(c, discord(['42', g]), { has: () => false, name: () => 'Greek', check: async () => 'no' });
    try {
      const r = await fetch(`${s.base}/oauth/callback?code=c0de&state=${await stateFrom(s.base)}`, { redirect: 'manual' });
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe('/map');
      const me = await fetch(`${s.base}/api/me`, { headers: { Cookie: r.headers.get('set-cookie')!.split(';')[0] } });
      expect(await me.json()).toMatchObject({ guildId: g, user: 'Al' });
    } finally { s.close(); }
  }));

  it('shows the real reason when Discord login fails', async () => withOAuth(async () => {
    const c = ctxWith((async () => json({}, 404)) as typeof fetch);
    const s = await app(c, discord(['g1'], { error: 'invalid_client' }), { has: () => true, name: () => 'Red' });
    try {
      const bad = await (await fetch(`${s.base}/oauth/callback?code=c0de&state=${await stateFrom(s.base)}`)).text();
      expect(bad).toContain('invalid_client');
      expect(bad).toContain('ACTIVITY_CLIENT_SECRET');
      expect(bad).not.toContain('sec&'); // never the secret itself
      const denied = await (await fetch(`${s.base}/oauth/callback?error=access_denied&error_description=The+resource+owner+denied`)).text();
      expect(denied).toContain('access_denied');
      expect(await (await fetch(`${s.base}/oauth/callback?code=x&state=forged.sig`)).text()).toContain('state not signed by this bot');
      // a refused personal link never sends people to Discord login, even when it is configured
      const link = await (await fetch(`${s.base}/go/live?t=${issueSession('another-process-key-xxxxxxxxxxxx', { u: 'u1', g: 'g1' })}`)).text();
      expect(link).not.toContain('href="/login"');
      expect(link).toContain(esc(STRINGS.en['web.freshLink']));
    } finally { s.close(); }
  }));

  it('detects whether Activities are enabled on the app and hides "Open in Discord" when they are not', async () => {
    expect(readActivityInfo({ flags: 0, embedded_surfaces: [] })).toBe('disabled');
    expect(readActivityInfo({ flags: 9568258, embedded_surfaces: [0] })).toBe('enabled');
    expect(readActivityInfo({})).toBe('unknown');
    expect(await checkActivityApp((async () => json({ flags: 0, embedded_surfaces: [] })) as unknown as typeof fetch, '1574880931146236087')).toBe('disabled');
    const saved = [config.publicUrl, config.webEnabled, config.activityClientId, config.activityLink] as const;
    config.publicUrl = 'https://grepo.example.com'; config.webEnabled = true; config.activityClientId = '1574880931146236087'; config.activityLink = '';
    try {
      const c = ctxWith((async () => json({}, 404)) as typeof fetch);
      const reply = async () => {
        const calls: any[] = [];
        const i: any = { guildId: 'g1', commandName: 'live', user: { id: 'u7', username: 'f' }, member: { displayName: 'F' }, options: { getBoolean: () => false },
          reply: async (p: unknown) => { calls.push(JSON.parse(JSON.stringify(p, (_k, v) => (v && typeof v.toJSON === 'function' ? v.toJSON() : v)))); } };
        await handleLiveMap(c, i, 'el', 'gr999');
        return calls[0];
      };
      setActivityState('disabled');
      let p = await reply();
      expect(p.components[0].components.map((b: any) => b.url)).toEqual([expect.stringContaining('/go/live?t=')]);
      setActivityState('enabled');
      p = await reply();
      expect(p.components[0].components[0].url).toBe('https://discord.com/activities/1574880931146236087?custom_id=live');
      expect(p.embeds[0].description).toContain(STRINGS.el['web.body.launcher']);
    } finally { setActivityState('unknown'); [config.publicUrl, config.webEnabled, config.activityClientId, config.activityLink] = saved as unknown as [string, boolean, string, string]; }
  });
});
