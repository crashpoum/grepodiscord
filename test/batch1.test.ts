import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.js';
import { GrepoDataClient, GrepoDataError } from '../src/data/grepodata.js';
import { buildSnapshot } from '../src/data/snapshot.js';
import { computeEvents } from '../src/refresh.js';
import {
  boostedSpeed, estimateTravel, fmtDuration, parseDuration, parseLandTime, parseUnits, parseWorldSpeeds, townPx, worldClock, type WorldInfo,
} from '../src/planner.js';
import { buildBoard, nextBaselines, renderBoard, resolveSides, TownGrid, V2_TEXT_LIMIT } from '../src/war.js';
import { findThreats, threatMessage } from '../src/threats.js';
import { classifyError, safeEmbed } from '../src/bot/errors.js';
import { intelTown, UserError, gdFail } from '../src/gdServices.js';
import { STRINGS } from '../src/i18n.js';
import type { Ctx } from '../src/services.js';
import type { WorldManager } from '../src/refresh.js';
import { files } from './helpers.js';
const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`;

const NOW = 1_800_000_000;
const H = 3600;

/** A small war: alliance 10 (Red, ours) vs 20 (Blue, enemy); 30 is neutral. */
function warSnap(extraConquers: string[] = []) {
  return buildSnapshot('gr999', files({
    players: ['1,Alice,10,1000,1,2', '2,Bob,20,500,2,2', '3,Cara,10,200,3,1', '4,Neutral,30,100,4,1'].join('\n'),
    alliances: ['10,Red,1200,3,2,1', '20,Blue,500,2,1,2', '30,Grey,100,1,1,3'].join('\n'),
    towns: [
      '100,1,Alice+1,450,530,1,600', '101,1,Alice+2,460,540,2,400',
      '200,2,Bob+1,452,533,3,500', '201,2,Bob+2,800,800,4,300',
      '300,3,Cara+1,455,535,5,200', '400,4,Grey+1,451,531,6,100',
    ].join('\n'),
    conquers: [
      `200,${NOW - 2 * H},2,1,20,10,500`, // Blue took Bob+1 from Alice (loss)
      `201,${NOW - 3 * H},2,,20,,300`, // ghost takeover by Blue (not ours)
      `300,${NOW - 5 * 86400},3,2,10,20,200`, // Cara took from Blue 5 days ago (gain, 7d only)
      ...extraConquers,
    ].join('\n'),
    player_kills_att: ['1,1,5000', '2,2,9000'].join('\n'),
    player_kills_def: ['1,1,300', '2,3,50'].join('\n'),
  }));
}

const unitsJson = JSON.stringify({
  militia: { id: 'militia', name: 'Militia', speed: 0, is_naval: false },
  sword: { id: 'sword', name: 'Ξιφομάχος', speed: 24, is_naval: false, flying: false },
  harpy: { id: 'harpy', name: 'Άρπυια', speed: 84, is_naval: false, flying: true },
  big_transporter: { id: 'big_transporter', name: 'Μεταφορικό', speed: 24, is_naval: true },
  small_transporter: { id: 'small_transporter', name: 'Γρήγορο', speed: 45, is_naval: true },
  bireme: { id: 'bireme', name: 'Διήρης', speed: 45, is_naval: true },
});
const info = (): WorldInfo => ({ units: parseUnits(unitsJson), worldSpeed: 3, unitSpeed: 3 });

describe('op planner maths', () => {
  it('parses travel durations', () => {
    expect(parseDuration('1:23:45')).toBe(5025);
    expect(parseDuration('23:45')).toBe(1425);
    expect(parseDuration('1h 2m 3s')).toBe(3723);
    expect(parseDuration('45m')).toBe(2700);
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('999:00:00')).toBeNull();
  });

  it('parses landing times in the world timezone', () => {
    const now = Date.UTC(2026, 10, 24, 18, 0, 0) / 1000; // 20:00 Athens
    expect(parseLandTime('2026-11-25 21:30:00', 'Europe/Athens', now)).toBe(Date.UTC(2026, 10, 25, 19, 30, 0) / 1000);
    expect(parseLandTime('25/11 21:30', 'Europe/Athens', now)).toBe(Date.UTC(2026, 10, 25, 19, 30, 0) / 1000);
    expect(parseLandTime('21:30:15', 'Europe/Athens', now)).toBe(Date.UTC(2026, 10, 24, 19, 30, 15) / 1000); // later today
    expect(parseLandTime('19:00', 'Europe/Athens', now)).toBe(Date.UTC(2026, 10, 25, 17, 0, 0) / 1000); // passed → tomorrow
    expect(parseLandTime('<t:1764099000:F>', 'Europe/Athens', now)).toBe(1764099000);
    expect(parseLandTime('soon', 'Europe/Athens', now)).toBeNull();
    expect(worldClock(Date.UTC(2026, 10, 25, 19, 30, 0) / 1000, 'Europe/Athens')).toBe('25/11/2026 21:30:00');
  });

  it('reads world/unit speed from localized world_settings.json', () => {
    const gr = JSON.stringify({ world_settings: [{ name: 'Όριο', value: 30000 }, { name: 'Σύνδεση', value: 'x' }, { name: 'Εγγραφή', value: 'x' }, { name: 'Ταχύτητα Κόσμου:', value: 3 }, { name: 'Ταχύτητα μονάδας', value: 2 }] });
    const en = JSON.stringify({ world_settings: [{ name: 'Player limit', value: 20000 }, { name: 'Login', value: 'Open' }, { name: 'Registration', value: 'Closed' }, { name: 'World speed', value: 4 }, { name: 'Unit speed', value: 3 }] });
    expect(parseWorldSpeeds(gr)).toEqual({ worldSpeed: 3, unitSpeed: 2 });
    expect(parseWorldSpeeds(en)).toEqual({ worldSpeed: 4, unitSpeed: 3 });
  });

  it('parses units.json and drops militia', () => {
    const u = parseUnits(unitsJson);
    expect(u.has('militia')).toBe(false);
    expect(u.get('harpy')).toMatchObject({ flying: true, naval: false, speed: 84 });
  });

  it('estimates travel: base + 50·px/speed, boats for land units, bonuses only where they apply', () => {
    const a = { id: 1, playerId: 1, name: 'A', islandX: 450, islandY: 530, slot: 1, points: 1 };
    const b = { id: 2, playerId: 2, name: 'B', islandX: 452, islandY: 530, slot: 1, points: 1 };
    expect(townPx({ islandX: 451, islandY: 10 }).y).toBe(10 * 128 + 64);
    const sword = estimateTravel(a, b, 'sword', info());
    expect(sword.viaTransport).toBe('big_transporter');
    expect(sword.seconds).toBe(Math.round((50 * 256) / 24 + 300));
    const fast = estimateTravel(a, b, 'sword', info(), { transport: 'small_transporter' });
    expect(fast.seconds).toBe(Math.round((50 * 256) / 24 + 300)); // still limited by the sword (24 < 45)
    const harpy = estimateTravel(a, b, 'harpy', info());
    expect(harpy.viaTransport).toBeNull();
    expect(harpy.seconds).toBe(Math.round((50 * 256) / 84 + 300));
    const u = info().units;
    expect(boostedSpeed(u.get('bireme')!, { meteorology: true })).toBe(45); // meteorology is land-only
    expect(boostedSpeed(u.get('bireme')!, { cartography: true, lighthouse: true })).toBeCloseTo(45 * 1.25);
    expect(boostedSpeed(u.get('sword')!, { meteorology: true, boost: 10 })).toBeCloseTo(24 * 1.1 * 1.1);
    expect(fmtDuration(3723)).toBe('1:02:03');
  });
});

describe('war room', () => {
  it('auto-detects our side from verified members and enemies from conquests', () => {
    const s = warSnap();
    const sides = resolveSides(s, { ours: [], enemies: [] }, [1], NOW);
    expect(sides).toMatchObject({ ours: [10], enemies: [20], autoOurs: true, autoEnemies: true });
    expect(resolveSides(s, { ours: [10], enemies: [30] }, [], NOW)).toMatchObject({ ours: [10], enemies: [30], autoOurs: false, autoEnemies: false });
  });

  it('scores towns traded, lists recent conquests, frontline and enemy conquests near us', () => {
    const s = warSnap();
    const sides = resolveSides(s, { ours: [10], enemies: [20] }, [], NOW);
    const m = buildBoard(s, sides, new Map(), NOW);
    expect(m.totals).toEqual({ gained24: 0, lost24: 1, gained7: 1, lost7: 1 });
    expect(m.score[0]).toMatchObject({ allianceId: 20, lost24: 1, gained7: 1 });
    expect(m.recent.map((r) => [r.c.townId, r.dir])).toEqual([[200, 'against']]);
    expect(m.frontline[0].enemyTown.id).toBe(200);
    expect(m.nearConquests.map((n) => n.c.townId)).toEqual([]); // Bob+1 was taken FROM us: that is a loss, not a nearby threat
  });

  it('computes top movers from the 24h baseline and rolls it daily', () => {
    const s = warSnap();
    const base = new Map([[1, { id: 1, points: 0, abp: 1000, dbp: 300, towns: 2, ts: NOW - H }], [2, { id: 2, points: 0, abp: 1000, dbp: 50, towns: 2, ts: NOW - H }]]);
    const m = buildBoard(s, resolveSides(s, { ours: [10], enemies: [20] }, [], NOW), base, NOW);
    expect(m.movers.map((x) => [x.playerId, x.side, x.abp])).toEqual([[1, 'ours', 4000], [2, 'enemy', 8000]]);
    expect(nextBaselines(s, base, NOW)).toBeNull();
    expect(nextBaselines(s, base, NOW + 86400)?.length).toBe(4);
    expect(nextBaselines(s, new Map(), NOW)?.length).toBe(4);
  });

  it('renders a Components V2 container within the 4000-character text limit', () => {
    const many = Array.from({ length: 300 }, (_, k) => `100,${NOW - k * 60},2,1,20,10,500`);
    const s = warSnap(many);
    const comps = renderBoard(buildBoard(s, resolveSides(s, { ours: [10], enemies: [20] }, [], NOW), new Map(), NOW), s, 'el', 7) as { type: number; components: { type: number; content?: string; custom_id?: string }[] }[];
    expect(comps[0].type).toBe(17);
    const text = comps[0].components.filter((c) => c.type === 10).map((c) => c.content ?? '').join('');
    expect(text.length).toBeLessThanOrEqual(V2_TEXT_LIMIT);
    expect(text).toContain('Αίθουσα πολέμου');
    expect(comps[1].components[0].custom_id).toBe('warroom:refresh:7');
  });

  it('TownGrid finds the nearest town within range only', () => {
    const g = new TownGrid([{ id: 1, playerId: 1, name: 'a', islandX: 10, islandY: 10, slot: 0, points: 0 }, { id: 2, playerId: 1, name: 'b', islandX: 40, islandY: 40, slot: 0, points: 0 }]);
    expect(g.nearest(12, 12, 5)?.town.id).toBe(1);
    expect(g.nearest(25, 25, 5)).toBeNull();
  });
});

describe('personal threat alerts', () => {
  const s = warSnap();
  const sub = { playerId: 1, radius: 10, minBp: 3000, scope: 'enemies' as const };

  it('reports own losses, enemy conquests/foundations near us and attack spikes; never friends', () => {
    const lostByAlice = s.conquers.filter((c) => c.townId === 200);
    const nearConq = [{ townId: 400, time: NOW - 60, newPlayerId: 2, oldPlayerId: 4, newAllianceId: 20, oldAllianceId: 30, townPoints: 100 }];
    const founded = [{ id: 999, playerId: 2, name: 'New', islandX: 449, islandY: 529, slot: 9, points: 50 }];
    s.towns.set(999, founded[0]);
    const items = findThreats(sub, s, { conquests: [...lostByAlice, ...nearConq], founded, bp: [{ id: 2, kind: 'att', delta: 5000, total: 9000 }, { id: 3, kind: 'att', delta: 9999, total: 1 }] }, [10], [20]);
    expect(items.map((x) => x.kind).sort()).toEqual(['attacker', 'conquest', 'founded', 'lost']);
    const msg = threatMessage(items, s, 'en', 'Srv');
    expect(msg.length).toBeLessThanOrEqual(2000);
    expect(msg).toContain('Alice+1'.slice(0, 5));
  });

  it("'enemies' scope ignores neutrals when enemies are set; 'all' does not", () => {
    const c = [{ townId: 300, time: NOW, newPlayerId: 4, oldPlayerId: null, newAllianceId: 30, oldAllianceId: null, townPoints: 1 }];
    expect(findThreats(sub, s, { conquests: c, founded: [], bp: [] }, [10], [20])).toEqual([]);
    expect(findThreats({ ...sub, scope: 'all' }, s, { conquests: c, founded: [], bp: [] }, [10], [20]).length).toBe(1);
    expect(findThreats(sub, s, { conquests: c, founded: [], bp: [] }, [10], []).length).toBe(1); // no enemies set → everyone outside our side
  });
});

describe('refresh events: founded towns', () => {
  it('detects new town ids as founded', () => {
    const st = new Store(':memory:');
    const before = files();
    const after = files({ towns: `${before.towns}\n500,2,Colony,121,881,7,100` });
    const sn = buildSnapshot('en999', after);
    st.setLastConquestTime('en999', 0);
    const ev = computeEvents('en999', new Set(['towns']), { towns: before.towns }, sn, st, NOW);
    expect(ev.founded.map((x) => x.id)).toEqual([500]);
  });
});

describe('database migration keeps existing data', () => {
  it('opens a v1.1 database, keeps rows and adds the new tables', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'gc-')), 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE guild_config (guild_id TEXT PRIMARY KEY, world TEXT, lang TEXT NOT NULL DEFAULT 'en', verified_role_id TEXT, updated_at INTEGER);
      CREATE TABLE links (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, world TEXT NOT NULL, player_id INTEGER NOT NULL, verified_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
      INSERT INTO guild_config VALUES ('g', 'gr125', 'el', 'r1', 1);
      INSERT INTO links VALUES ('g', 'u', 'gr125', 42, 5);`);
    old.close();
    const st = new Store(path);
    expect(st.getGuild('g')).toMatchObject({ world: 'gr125', lang: 'el', verifiedRoleId: 'r1' });
    expect(st.getLink('g', 'u')?.playerId).toBe(42);
    const id = st.addOp({ guildId: 'g', world: 'gr125', name: 'x', targetTownId: 1, landAt: NOW + 1000, creatorId: 'u', channelId: 'c' });
    st.upsertOpMember({ opId: id, userId: 'u', originTownId: 5, unit: 'sword', travelSecs: 900, estimated: true, uncertainty: 60, sendAt: NOW + 100, mods: { meteorology: true }, assignedBy: 'u' });
    expect(st.opMembers(id)[0]).toMatchObject({ unit: 'sword', estimated: true, mods: { meteorology: true }, notified: false });
    expect(st.dueReminders(NOW, 60)).toEqual([]);
    expect(st.dueReminders(NOW + 50, 60).map((m) => m.guildId)).toEqual(['g']);
    st.markOpMember(id, 'u', 5, 'reminded');
    expect(st.dueReminders(NOW + 50, 60)).toEqual([]);
    expect(st.trackedWorlds()).toContain('gr125');
    st.setWarSide('g', 'gr125', 10, 'ours');
    st.setWarSide('g', 'gr125', 20, 'enemy');
    expect(st.getWarSides('g', 'gr125')).toEqual({ ours: [10], enemies: [20] });
    const b = st.addBoard({ guildId: 'g', channelId: 'c', world: 'gr125', createdBy: 'u' });
    st.setBoardMessage(b, 'm1');
    expect(st.getBoard('g', b)?.messageId).toBe('m1');
    st.setThreatSub({ guildId: 'g', userId: 'u', radius: 8, minBp: 1000, scope: 'all' });
    expect(st.getThreatSub('g', 'u')).toMatchObject({ radius: 8, scope: 'all' });
    // Re-opening is idempotent.
    expect(new Store(path).getOp('g', id)?.name).toBe('x');
  });
});

describe('specific error messages (EN + GR)', () => {
  it('maps causes to keys that exist in both languages', () => {
    const keys = [
      classifyError(new UserError('intel.noToken')).key,
      classifyError(new GrepoDataError('HTTP 429', 429)).key,
      classifyError(new GrepoDataError('HTTP 401', 401)).key,
      classifyError(new GrepoDataError('HTTP 404', 404)).key,
      classifyError(new GrepoDataError('HTTP 500', 500)).key,
      classifyError(Object.assign(new Error('Missing Permissions'), { code: 50013 })).key,
      classifyError(new TypeError('fetch failed')).key,
      classifyError(new Error('boom')).key,
    ];
    expect(keys).toEqual(['intel.noToken', 'gd.rateLimited', 'gd.auth', 'gd.notFound', 'gd.unavailable', 'err.discordPerms', 'err.worldData', 'err.generic']);
    for (const k of keys) { expect(STRINGS.en[k]).toBeTruthy(); expect(STRINGS.el[k]).toBeTruthy(); expect(STRINGS.el[k]).not.toBe(STRINGS.en[k]); }
    expect(() => gdFail(new GrepoDataError('HTTP 429', 429))).toThrow(expect.objectContaining({ key: 'gd.rateLimited' }));
  });

  it('clamps embeds to Discord limits', () => {
    const e = safeEmbed({ title: 'x'.repeat(300), description: 'y'.repeat(5000), fields: Array.from({ length: 30 }, () => ({ name: '', value: 'z'.repeat(2000) })) });
    expect(e.title!.length).toBe(256);
    expect(e.fields!.length).toBeLessThanOrEqual(25);
    expect(e.fields!.every((f) => f.name.length > 0 && f.value.length <= 1024)).toBe(true);
    const total = e.title!.length + e.description!.length + e.fields!.reduce((s, f) => s + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
  });

  const ctxWith = (fetchImpl: typeof fetch) => {
    const store = new Store(':memory:');
    const sn = warSnap();
    const worlds = { ensure: async () => sn, get: () => sn } as unknown as WorldManager;
    return { store, worlds, gd: new GrepoDataClient('https://x', 1000, fetchImpl, async () => {}) } as Ctx;
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('/intel: no token, expired with failed renewal, and 200 {success:false}', async () => {
    const c = ctxWith((async () => json({ success: false, message: 'Invalid access token' })) as typeof fetch);
    await expect(intelTown(c, 'g', 'ch', 'gr999', 'id:100', 'en')).rejects.toMatchObject({ key: 'intel.noToken' });
    c.store.setGdToken({ guildId: 'g', accessToken: jwt({ exp: 1 }), refreshToken: null, accessExp: 1000, refreshExp: null, adminUserId: null, source: 'command' });
    c.store.setGdAlert('g', 3, 'HTTP 400');
    await expect(intelTown(c, 'g', 'ch', 'gr999', 'id:100', 'en')).rejects.toMatchObject({ key: 'intel.refreshFailed', vars: { error: 'HTTP 400' } });
    const exp = Date.now() + 3_600_000;
    c.store.setGdToken({ guildId: 'g', accessToken: jwt({ exp: Math.floor(exp / 1000) }), refreshToken: null, accessExp: exp, refreshExp: null, adminUserId: null, source: 'command' });
    await expect(intelTown(c, 'g', 'ch', 'gr999', 'id:100', 'en')).rejects.toMatchObject({ key: 'intel.rejected' });
  });

  it('/intel: an expired token with a refresh token is renewed on the spot', async () => {
    const fresh = jwt({ exp: Math.floor(Date.now() / 1000) + 86400 });
    const c = ctxWith((async (u: string) => (String(u).includes('/auth/refresh')
      ? json({ access_token: fresh, refresh_token: jwt({ exp: Math.floor(Date.now() / 1000) + 9e6 }) })
      : json({ name: 'Alice 1', ix: 450, iy: 530, player_id: 1, player_name: 'Alice', intel: [] }))) as typeof fetch);
    c.store.setGdToken({ guildId: 'g', accessToken: jwt({ exp: 1 }), refreshToken: jwt({ exp: Math.floor(Date.now() / 1000) + 9e6 }), accessExp: 1000, refreshExp: null, adminUserId: null, source: 'command' });
    const r = await intelTown(c, 'g', 'ch', 'gr999', 'id:100', 'en');
    expect(r.embed.title).toContain('Alice 1');
    expect(c.store.getGdToken('g')?.accessToken).toBe(fresh);
  });
});
