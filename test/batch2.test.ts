import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, type DailySet } from '../src/db.js';
import { buildSnapshot } from '../src/data/snapshot.js';
import type { Activity } from '../src/diff.js';
import { conquestCounts, dailyRows, dayIn, daysBetween, quitScore, rankQuitters, shiftDay, softTargets, type QuitInputs } from '../src/targets.js';
import { DEFAULT_GEMINI_MODEL, freeTierModel, Gemini, GeminiError, pacificDay, parseRetryDelay } from '../src/ai/gemini.js';
import { matchTown, normalizeReport, reportEmbed, reportTime } from '../src/reports.js';
import { localWeekday, newspaperDue, newspaperEmbed, newspaperPrompt, templateArticle, weekFacts } from '../src/newspaper.js';
import { classifyError } from '../src/bot/errors.js';
import { parseAndStore, buildNewspaper, runNewspapers } from '../src/bot/aiHandlers.js';
import { boardExtras, recordHistory } from '../src/bot/insights.js';
import { STRINGS } from '../src/i18n.js';
import type { Ctx } from '../src/services.js';
import type { WorldManager } from '../src/refresh.js';
import { files } from './helpers.js';

const NOW = 1_800_000_000; // 2027-01-15 08:00 UTC
const H = 3600;
const D = 86400;

/** Red (10, ours) vs Blue (20); Grey (30) neutral; Lone (5) has no alliance. */
function world(conquers: string[] = []) {
  return buildSnapshot('gr999', files({
    players: ['1,Alice,10,5000,1,2', '2,Bob,20,3000,2,2', '3,Cara,20,2500,3,1', '4,Grey,30,1500,4,1', '5,Lone,,800,5,1'].join('\n'),
    alliances: ['10,Red,5000,2,1,1', '20,Blue,5500,3,2,2', '30,Grey,1500,1,1,3'].join('\n'),
    towns: [
      '100,1,Alice+1,450,530,1,6000', '101,1,Alice+2,460,540,2,4000',
      '200,2,Bob+1,452,533,3,9000', '201,2,Bob+2,800,800,4,3000',
      '300,3,Cara+1,470,550,5,2500', // Blue but far from Bob's near town → isolated
      '400,4,Grey+1,451,531,6,1500',
      '500,5,Lone+1,455,529,7,800',
      '600,,Ghost,453,534,8,1200',
    ].join('\n'),
    conquers: conquers.join('\n') || `999,${NOW - 30 * D},1,2,10,20,100`,
    player_kills_att: ['1,1,9000', '2,2,4000', '3,3,100'].join('\n'),
    player_kills_def: ['1,1,6000', '2,2,3500', '3,3,10', '4,4,20'].join('\n'),
    alliance_kills_att: '1,10,9000',
    alliance_kills_def: '1,10,6000',
  }));
}
const act = (rows: [number, number, number][]): Map<number, Activity> =>
  new Map(rows.map(([id, idleH, trackedH]) => [id, { playerId: id, points: 0, abp: 0, dbp: 0, towns: 0, lastChangeAt: NOW - idleH * H, firstSeenAt: NOW - trackedH * H }]));
const oldSet = (day: string, rows: [number, number, number, number][]): DailySet =>
  ({ day, rows: new Map(rows.map(([id, points, abp, dbp]) => [id, { id, allianceId: null, points, abp, dbp, towns: 1 }])) });

describe('quit prediction', () => {
  const snap = world([`300,${NOW - 2 * D},1,3,10,20,2500`]); // Cara lost her town 2 days ago (the file still lists it under her in this fixture)
  const today = dayIn('Europe/Athens', NOW);
  const base: QuitInputs = {
    snap, now: NOW, today,
    activity: act([[1, 1, 200], [2, 2, 200], [3, 96, 200], [4, 10, 200], [5, 80, 200]]),
    old: oldSet(shiftDay(today, -7), [[1, 4000, 7000, 5000], [2, 2990, 4000, 3500], [3, 2600, 100, 10], [4, 1400, 0, 20], [5, 800, 0, 0]]),
  };
  it('scores an idle, shrinking, non-fighting player high and an active grower low', () => {
    const cara = quitScore(snap.players.get(3)!, base);
    const alice = quitScore(snap.players.get(1)!, base);
    expect(cara.score).toBeGreaterThanOrEqual(80);
    expect(cara.facts).toMatchObject({ lost7: 1, gained7: 0, spanDays: 7, idleHours: 96 });
    expect(cara.signals.points).toBe(1); // points went down
    expect(alice.score).toBeLessThan(20);
    expect(cara.confidence).toBe(100);
  });
  it('renormalizes when history is missing and lowers confidence', () => {
    const q = quitScore(snap.players.get(5)!, { ...base, old: null, activity: new Map() });
    expect(q.signals.points).toBeUndefined();
    expect(q.signals.idle).toBeUndefined();
    expect(q.confidence).toBe(25); // towns + alliance only
    expect(q.score).toBe(40); // no alliance (0.1) / 0.25
  });
  it('ranks with alliance filters and exclusions', () => {
    expect(rankQuitters(base, { allianceIds: [20] }).map((q) => q.playerId)).toEqual([3, 2]);
    expect(rankQuitters(base, { excludeAllianceIds: [10, 20, 30] }).map((q) => q.playerId)).toEqual([5]);
  });
  it('counts conquests per player in the last 7 days', () => {
    expect(conquestCounts(snap, NOW).get(3)).toEqual({ lost: 1, gained: 0 });
    expect(conquestCounts(snap, NOW).get(1)).toEqual({ lost: 0, gained: 1 });
  });
});

describe('soft-target radar', () => {
  const snap = world();
  const today = dayIn('Europe/Athens', NOW);
  const x: QuitInputs = { snap, now: NOW, today, activity: act([[2, 1, 100], [3, 100, 100], [4, 2, 100], [5, 90, 100]]), old: oldSet(shiftDay(today, -7), [[2, 2500, 3000, 2000], [3, 2500, 100, 10], [4, 1500, 20, 20], [5, 800, 0, 0]]) };
  const refs = [snap.towns.get(100)!, snap.towns.get(101)!];
  it('ranks ghosts and idle isolated players first, excludes our side, one line per player', () => {
    const list = softTargets(x, { refs, radius: 30, excludeAllianceIds: [10] });
    const ids = list.map((s) => s.town.id);
    expect(ids).not.toContain(100);
    expect(ids[0]).toBe(600); // ghost
    expect(list.find((s) => s.town.id === 500)!.reasons).toEqual(expect.arrayContaining(['idle', 'noAlliance', 'smallTown']));
    expect(list.find((s) => s.town.id === 300)!.reasons).toContain('isolated');
    const bob = list.find((s) => s.player?.id === 2)!;
    expect(bob.town.id).toBe(200); // the near town, not the one at 800|800
    expect(bob.score).toBeLessThan(list.find((s) => s.town.id === 500)!.score);
    expect(list.filter((s) => s.player?.id === 2)).toHaveLength(1);
  });
  it('respects radius, ghosts=false, point filters and empty refs', () => {
    expect(softTargets(x, { refs, radius: 6, excludeAllianceIds: [10] }).map((s) => s.town.id).sort()).toEqual([200, 400, 500, 600]);
    expect(softTargets(x, { refs, radius: 30, excludeAllianceIds: [10], includeGhosts: false }).some((s) => s.player === null)).toBe(false);
    expect(softTargets(x, { refs, radius: 30, excludeAllianceIds: [10], includeGhosts: false, minPoints: 2000, maxPoints: 2600 }).map((s) => s.player!.id)).toEqual([3]);
    expect(softTargets(x, { refs: [], radius: 30, excludeAllianceIds: [] })).toEqual([]);
    expect(softTargets(x, { refs, radius: 30, excludeAllianceIds: [10], limit: 3 }).filter((s) => s.player === null)).toHaveLength(1); // ghosts capped
  });
});

describe('daily history store + migration', () => {
  it('upgrades a batch-1 database, keeps data, records/prunes history', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'gc2-')), 'old.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE guild_config (guild_id TEXT PRIMARY KEY, world TEXT, lang TEXT NOT NULL DEFAULT 'en', verified_role_id TEXT, updated_at INTEGER);
      CREATE TABLE boards (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, world TEXT NOT NULL, created_by TEXT, created_at INTEGER, updated_at INTEGER, last_error TEXT);
      INSERT INTO guild_config VALUES ('g', 'gr999', 'el', NULL, 1);
      INSERT INTO boards (guild_id, channel_id, message_id, world) VALUES ('g', 'c', 'm', 'gr999');`);
    old.close();
    const st = new Store(path);
    expect(st.getGuild('g').lang).toBe('el');
    expect(st.getBoard('g', 1)?.messageId).toBe('m');
    const snap = world();
    const { players, alliances } = dailyRows(snap);
    st.recordDaily('gr999', '2027-01-01', players.map((p) => ({ ...p, points: p.points - 100 })), alliances);
    st.recordDaily('gr999', '2027-01-08', players, alliances);
    st.recordDaily('gr999', '2027-01-08', players, alliances); // same day: replaced, not duplicated
    expect(st.historyDays('gr999')).toEqual(['2027-01-01', '2027-01-08']);
    expect(st.dailyAt('gr999', 'p', '2027-01-05')?.day).toBe('2027-01-01');
    expect(st.dailyAt('gr999', 'p', '2026-12-01')?.day).toBe('2027-01-01'); // oldest when nothing earlier
    expect(st.dailyAt('gr999', 'p', '2027-01-01')!.rows.get(1)!.points).toBe(4900);
    expect(st.dailyAt('gr999', 'a', '2027-01-08')!.rows.get(20)).toMatchObject({ points: 5500, members: 2 });
    expect(st.playerSeries('gr999', 1).map((r) => r.points)).toEqual([4900, 5000]);
    st.recordDaily('gr999', '2027-03-01', players, alliances, 40);
    expect(st.historyDays('gr999')).toEqual(['2027-03-01']);
    st.setSetting('g', 'board.soft', '1');
    expect(st.getSetting('g', 'board.soft')).toBe('1');
    st.setSetting('g', 'board.soft', null);
    expect(st.getSetting('g', 'board.soft')).toBeNull();
    expect(new Store(path).getBoard('g', 1)?.messageId).toBe('m');
  });
  it('day helpers', () => {
    expect(daysBetween('2027-01-01', '2027-01-08')).toBe(7);
    expect(shiftDay('2027-03-01', -1)).toBe('2027-02-28');
    expect(dayIn('Europe/Athens', Date.UTC(2026, 10, 24, 22, 30) / 1000)).toBe('2026-11-25');
  });
});

// ---------------------------------------------------------------- Gemini
const okBody = (text: string) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
const resp = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Gemini client (free tier)', () => {
  it('refuses paid / non-flash models', () => {
    expect(freeTierModel('')).toBe(DEFAULT_GEMINI_MODEL);
    expect(freeTierModel('gemini-3.1-pro-preview')).toBe(DEFAULT_GEMINI_MODEL);
    expect(freeTierModel('gemini-4-carbon')).toBe(DEFAULT_GEMINI_MODEL);
    expect(freeTierModel('gemini-3.8-flash')).toBe('gemini-3.8-flash');
    expect(freeTierModel('gemini-3.1-flash-lite')).toBe('gemini-3.1-flash-lite');
  });
  it('no key → noKey; key goes in a header, never the URL', async () => {
    await expect(new Gemini({ apiKey: '' }).generate([{ text: 'x' }])).rejects.toMatchObject({ kind: 'noKey' });
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => resp(200, okBody('hi')));
    const g = new Gemini({ apiKey: 'SECRET', fetch: f as unknown as typeof fetch, wait: async () => undefined });
    expect(await g.generate([{ text: 'x' }])).toBe('hi');
    const [url, init] = f.mock.calls[0];
    expect(String(url)).not.toContain('SECRET');
    expect(String(url)).toContain(`/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
    expect((init!.headers as Record<string, string>)['x-goog-api-key']).toBe('SECRET');
  });
  it('429 with RetryInfo waits and retries; per-day quota stops for the day', async () => {
    const waits: number[] = [];
    const retry = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }] } };
    expect(parseRetryDelay(retry)).toBe(7000);
    let n = 0;
    const f = async () => (n++ === 0 ? resp(429, retry) : resp(200, okBody('ok')));
    let clock = NOW * 1000;
    const g = new Gemini({ apiKey: 'k', fetch: f as unknown as typeof fetch, now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; } });
    expect(await g.generate([{ text: 'x' }])).toBe('ok');
    expect(waits.some((w) => w >= 7000)).toBe(true);
    const daily = { error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 500, GenerateRequestsPerDayPerProjectPerModel-FreeTier' } };
    const g2 = new Gemini({ apiKey: 'k', fetch: (async () => resp(429, daily)) as unknown as typeof fetch, wait: async () => undefined });
    await expect(g2.generate([{ text: 'x' }])).rejects.toMatchObject({ kind: 'quota' });
    await expect(g2.generate([{ text: 'x' }])).rejects.toMatchObject({ kind: 'quota' }); // no second request
  });
  it('enforces the daily cap from the usage store and the queue limit', async () => {
    const st = new Store(':memory:');
    const g = new Gemini({ apiKey: 'k', rpd: 2, store: st, fetch: (async () => resp(200, okBody('{"a":1}'))) as unknown as typeof fetch, wait: async () => undefined });
    expect(await g.json([{ text: 'x' }], { schema: {} })).toEqual({ a: 1 });
    await g.generate([{ text: 'x' }]);
    expect(st.aiUsage(pacificDay(), g.model)).toBe(2);
    await expect(g.generate([{ text: 'x' }])).rejects.toMatchObject({ kind: 'quota' });
    let release!: () => void;
    const slow = new Gemini({ apiKey: 'k', maxQueue: 1, fetch: (() => new Promise<Response>((r) => { release = () => r(resp(200, okBody('x'))); })) as unknown as typeof fetch });
    const first = slow.generate([{ text: 'a' }]);
    await expect(slow.generate([{ text: 'b' }])).rejects.toMatchObject({ kind: 'busy' });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await first;
  });
  it('bad key and safety blocks map to their own errors', async () => {
    const bad = new Gemini({ apiKey: 'k', fetch: (async () => resp(400, { error: { message: 'API key not valid. Please pass a valid API key.' } })) as unknown as typeof fetch });
    await expect(bad.generate([{ text: 'x' }])).rejects.toMatchObject({ kind: 'badKey' });
    const blocked = new Gemini({ apiKey: 'k', fetch: (async () => resp(200, { promptFeedback: { blockReason: 'SAFETY' } })) as unknown as typeof fetch });
    await expect(blocked.generate([{ text: 'x' }])).rejects.toMatchObject({ kind: 'blocked' });
  });
  it('every AI error has an EN and GR message', () => {
    for (const k of ['noKey', 'badKey', 'busy', 'quota', 'blocked', 'failed'] as const) {
      const c = classifyError(new GeminiError(k, 'x'));
      expect(c.key).toBe(`ai.${k}`);
      expect(STRINGS.en[c.key]).toBeTruthy();
      expect(STRINGS.el[c.key]).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------- reports
const MODEL_JSON = {
  is_report: true, kind: 'attack', time: '14.01.2027 21:30:12',
  attacker: { player: 'Alice', alliance: 'Red', town: 'Alice 1' }, defender: { player: 'Bob', alliance: 'Blue', town: 'bob 1' },
  attacker_units: [{ unit: 'slinger', name: 'Σφενδονήτης', count: 500, lost: 120 }, { unit: 'bogus', name: 'X', count: 3, lost: 0 }, { unit: 'sword', count: 0, lost: 0 }],
  defender_units: [{ unit: 'sword', name: 'Swordsman', count: '1.200', lost: 1200 }],
  buildings: [{ name: 'wall', level: 15 }, { name: 'bad', level: 999 }],
  resources: { wood: 1000, stone: null, silver: 50 }, wall_before: 15, wall_after: 12, luck: -7, morale: 100, night_bonus: false, summary: 'Alice won.',
};
describe('report parsing', () => {
  it('normalizes untrusted model output', () => {
    const p = normalizeReport(MODEL_JSON);
    expect(p.kind).toBe('attack');
    expect(p.attackerUnits).toEqual([{ unit: 'slinger', name: 'Σφενδονήτης', count: 500, lost: 120 }, { unit: 'other', name: 'X', count: 3, lost: 0 }]);
    expect(p.defenderUnits[0]).toMatchObject({ unit: 'sword', count: 1200, lost: 1200 });
    expect(p.buildings).toEqual([{ name: 'wall', level: 15 }]);
    expect(normalizeReport({ kind: 'weird' }).kind).toBe('other');
    expect(normalizeReport(null).attackerUnits).toEqual([]);
    expect(normalizeReport({ is_report: false }).isReport).toBe(false);
  });
  it('links towns and parses Grepolis report times in the world timezone', () => {
    const snap = world();
    expect(matchTown(snap, 'bob 1', 'Bob')?.id).toBe(200);
    expect(matchTown(snap, 'nope', null)).toBeNull();
    const ts = reportTime('14.01.2027 21:30:12', 'Europe/Athens');
    expect(new Date(ts! * 1000).toISOString()).toBe('2027-01-14T19:30:12.000Z');
    expect(reportTime('2027-01-14 21:30', 'Europe/Athens')).toBe(ts! - 12);
    expect(reportTime('garbage', 'Europe/Athens')).toBeNull();
  });
  it('renders an embed in both languages within Discord limits', () => {
    const p = normalizeReport(MODEL_JSON);
    for (const lang of ['en', 'el'] as const) {
      const e = reportEmbed({ id: 7, world: 'gr999', reportTime: NOW, createdBy: 'u', source: 'image' }, p, lang, world());
      expect(e.title).toContain('#7');
      expect(e.fields!.length).toBeGreaterThanOrEqual(4);
      for (const f of e.fields!) expect(f.value.length).toBeLessThanOrEqual(1024);
      expect(JSON.stringify(e)).not.toMatch(/rep\.|\{\w+\}/);
    }
  });
  it('parseAndStore: image → Gemini → stored and searchable by town; no key → noKey', async () => {
    const store = new Store(':memory:');
    const snap = world();
    const worlds = { ensure: async () => snap, get: () => snap } as unknown as WorldManager;
    const calls: unknown[] = [];
    const ai = new Gemini({ apiKey: 'k', wait: async () => undefined, fetch: (async (_u: unknown, init: RequestInit) => { calls.push(JSON.parse(String(init.body))); return resp(200, okBody(JSON.stringify(MODEL_JSON))); }) as unknown as typeof fetch });
    const ctx = { store, worlds, gd: {} as never, ai } as Ctx;
    const img = async () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
    const r = await parseAndStore(ctx, { guildId: 'g', userId: 'u1', world: 'gr999', image: { url: 'https://cdn/x.png', contentType: 'image/png', size: 4, name: 'x.png' }, lang: 'el' }, img as unknown as typeof fetch);
    const body = calls[0] as { contents: { parts: { inline_data?: { mime_type: string } }[] }[]; generationConfig: { responseMimeType: string } };
    expect(body.contents[0].parts[0].inline_data?.mime_type).toBe('image/png');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(store.getReport('g', r.id)).toMatchObject({ kind: 'attack', attTownId: 100, defTownId: 200, defTown: 'Bob 1', source: 'image' });
    expect(store.searchReports('g', { townId: 200 }).total).toBe(1);
    expect(store.searchReports('g', { townId: 100 }).total).toBe(1);
    expect(store.searchReports('other', { townId: 200 }).total).toBe(0); // per server
    expect(store.searchReports('g', { townId: 200, kind: 'spy' }).total).toBe(0);
    await expect(parseAndStore(ctx, { guildId: 'g', userId: 'u1', world: 'gr999', text: 'again', lang: 'en' })).rejects.toMatchObject({ key: 'rep.cooldown' });
    await expect(parseAndStore({ ...ctx, ai: new Gemini({ apiKey: '' }) }, { guildId: 'g', userId: 'u2', world: 'gr999', text: 'x', lang: 'en' })).rejects.toMatchObject({ kind: 'noKey' });
    await expect(parseAndStore(ctx, { guildId: 'g', userId: 'u3', world: 'gr999', image: { url: 'u', contentType: 'application/pdf', size: 4, name: 'a.pdf' }, lang: 'en' })).rejects.toMatchObject({ key: 'rep.badImage' });
  });
});

// ---------------------------------------------------------------- newspaper
describe('weekly newspaper', () => {
  const conq = [`200,${NOW - 2 * D},1,2,10,20,9000`, `201,${NOW - 3 * D},1,2,10,20,3000`, `300,${NOW - 1 * D},2,3,20,20,2500`, `600,${NOW - 4 * D},3,,20,,1200`, `400,${NOW - 10 * D},1,4,10,30,1500`];
  const snap = world(conq);
  const today = dayIn('Europe/Athens', NOW);
  const oldP = oldSet(shiftDay(today, -7), [[1, 4000, 5000, 5000], [2, 3500, 3000, 3000], [3, 2500, 100, 10]]);
  const oldA: DailySet = { day: shiftDay(today, -7), rows: new Map([[10, { id: 10, allianceId: 10, points: 4000, abp: 0, dbp: 0, towns: 1 }], [20, { id: 20, allianceId: 20, points: 6000, abp: 0, dbp: 0, towns: 3 }]]) };
  const f = weekFacts(snap, { now: NOW, ours: [10], oldP, oldA, today });
  it('extracts the week from public data only', () => {
    expect(f.conquests).toEqual({ total: 4, ghosts: 1, internal: 1 });
    expect(f.topConquerorsA[0]).toEqual({ name: 'Red', n: 2 });
    expect(f.wars[0]).toEqual({ a: 'Red', b: 'Blue', aTook: 2, bTook: 0 });
    expect(f.risersA[0]).toMatchObject({ name: 'Red', delta: 1000 });
    expect(f.fallersA[0]).toMatchObject({ name: 'Blue', delta: -500 });
    expect(f.ours).toMatchObject({ gained: 2, lost: 0, pointsDelta: 1000, topConquerorP: { name: 'Alice', n: 2 }, bestAttacker: { name: 'Alice', delta: 4000 } });
    expect(f.historyDays).toBe(7);
  });
  it('template in EN + GR has no missing strings; prompt forbids invention', () => {
    for (const lang of ['en', 'el'] as const) {
      const body = templateArticle(f, lang);
      expect(body).toContain('Red');
      expect(body).not.toMatch(/news\.|\{\w+\}/);
      const e = newspaperEmbed(f, body, lang, false);
      expect(e.description!.length).toBeLessThanOrEqual(4096);
    }
    const pr = newspaperPrompt('el', f);
    expect(pr.system).toMatch(/Greek/);
    expect(pr.system).toMatch(/ONLY the facts/);
    expect(pr.user).toContain('"Red"');
  });
  it('is due once on the configured weekday/hour in the world timezone', () => {
    const sun2030 = Date.UTC(2027, 0, 17, 18, 30); // Sunday 20:30 Athens
    expect(localWeekday('Europe/Athens', sun2030)).toEqual({ weekday: 0, day: '2027-01-17', hour: 20 });
    expect(newspaperDue({ weekday: 0, hour: 20, lastSentDay: null }, 'Europe/Athens', sun2030)).toBe('2027-01-17');
    expect(newspaperDue({ weekday: 0, hour: 20, lastSentDay: '2027-01-17' }, 'Europe/Athens', sun2030)).toBeNull();
    expect(newspaperDue({ weekday: 0, hour: 21, lastSentDay: null }, 'Europe/Athens', sun2030)).toBeNull();
    expect(newspaperDue({ weekday: 1, hour: 0, lastSentDay: null }, 'Europe/Athens', sun2030)).toBeNull();
  });
  it('falls back to the template when there is no key or the AI fails, and posts on schedule', async () => {
    const store = new Store(':memory:');
    store.setWarSide('g', 'gr999', 10, 'ours');
    const worlds = { ensure: async () => snap, get: () => snap } as unknown as WorldManager;
    const noKey = await buildNewspaper({ store, worlds, gd: {} as never } as Ctx, 'g', 'gr999', 'en', NOW);
    expect(noKey.byAi).toBe(false);
    const failing = new Gemini({ apiKey: 'k', wait: async () => undefined, fetch: (async () => resp(429, { error: { message: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' } })) as unknown as typeof fetch });
    const fb = await buildNewspaper({ store, worlds, gd: {} as never, ai: failing } as Ctx, 'g', 'gr999', 'el', NOW);
    expect(fb.byAi).toBe(false);
    expect(fb.aiError?.kind).toBe('quota');
    const ok = new Gemini({ apiKey: 'k', wait: async () => undefined, fetch: (async () => resp(200, okBody('**Μεγάλη εβδομάδα**'))) as unknown as typeof fetch });
    const sent: unknown[] = [];
    const client = { channels: { fetch: async () => ({ isSendable: () => true, send: async (m: unknown) => { sent.push(m); } }) } } as never;
    const ctx = { store, worlds, gd: {} as never, ai: ok } as Ctx;
    store.setNewspaper({ guildId: 'g', channelId: 'c', world: 'gr999', weekday: 0, hour: 20, createdBy: 'u' });
    expect(store.trackedWorlds()).toContain('gr999');
    const sun2030 = Date.UTC(2027, 0, 17, 18, 30);
    await runNewspapers(client, ctx, sun2030);
    await runNewspapers(client, ctx, sun2030 + 10 * 60_000); // same day: not again
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain('Μεγάλη εβδομάδα');
    expect(store.getNewspaper('g')).toMatchObject({ lastSentDay: '2027-01-17', lastError: null });
    store.disableNewspaper('g');
    expect(store.enabledNewspapers()).toEqual([]);
  });
});

describe('war board extras + history recording', () => {
  it('adds quit/soft sections only when enabled', () => {
    const store = new Store(':memory:');
    const snap = world([`300,${NOW - 2 * D},1,3,10,20,2500`]);
    const ctx = { store, worlds: {} as never, gd: {} as never } as Ctx;
    store.setWarSide('g', 'gr999', 10, 'ours');
    store.setWarSide('g', 'gr999', 20, 'enemy');
    expect(boardExtras(ctx, 'g', snap, 'en', NOW)).toEqual([]);
    store.setSetting('g', 'board.quitters', '1');
    store.setSetting('g', 'board.soft', '1');
    recordHistory(ctx, snap, NOW - 7 * D);
    const blocks = boardExtras(ctx, 'g', snap, 'el', NOW);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toContain('Ghost');
    expect(blocks.join('\n')).not.toMatch(/war\.|soft\.|quit\./);
  });
});
