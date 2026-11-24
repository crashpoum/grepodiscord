import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { snap } from './helpers.js';
import { mapSides, buildMapPayload } from '../src/web/mapData.js';
import { encodeIslands, parseIslands, townBox, IslandCache } from '../src/web/islands.js';
import { pollInterval, problemOf } from '../src/web/live.js';
import { config } from '../src/config.js';
import { SIDE_COLOR, sideOf, decodeIslands, islandClass, Grid, oceanOf } from '../web/src/geo.js';
import { filterCommands, groupRows, targetCards, fmtCountdown, type Filters } from '../web/src/liveView.js';
import { cmdKind, unitDef, UNIT_IDS, unitIcon } from '../web/src/icons.js';
import { WEB_STRINGS } from '../src/web/strings.js';
import type { LiveCommand } from '../src/web/types.js';

describe('map colours: sides → colours (the legend uses the same table)', () => {
  const sides = { ours: [10], allies: [30], enemies: [20] };
  it('maps own blue, allies cyan, enemies red, others neutral', () => {
    expect(sideOf(1, 10, sides)).toBe('own');
    expect(sideOf(1, 30, sides)).toBe('ally');
    expect(sideOf(1, 20, sides)).toBe('enemy');
    expect(sideOf(1, 99, sides)).toBe('other');
    expect(sideOf(1, 0, sides)).toBe('none');
    expect(sideOf(0, 0, sides)).toBe('ghost');
    expect(SIDE_COLOR.own).toBe('#3d8bff');
    expect(SIDE_COLOR.ally).toBe('#22c7c7');
    expect(SIDE_COLOR.enemy).toBe('#ff3b3b');
    expect(new Set(Object.values(SIDE_COLOR)).size).toBe(Object.keys(SIDE_COLOR).length); // all distinct
  });
  it('compares ids as numbers (string ids from older payloads still colour)', () => {
    expect(sideOf('1' as unknown as number, '10' as unknown as number, { ours: ['10' as unknown as number], enemies: [] })).toBe('own');
  });
  it('legend has an EN and GR label for every side', () => {
    for (const lang of ['en', 'el'] as const) for (const k of ['legendOwn', 'legendAllies', 'legendEnemies', 'legendOthers'] as const) expect(WEB_STRINGS[lang][k as keyof typeof WEB_STRINGS.en]).toBeTruthy();
  });
});

describe('mapSides fallbacks (root cause of the all-grey map)', () => {
  const s = snap();
  const base = { explicitOurs: [], explicitEnemies: [], linkedPlayers: [], roleAlliances: [], liveOwn: [], liveAttackers: [], now: 2000 };
  it('nothing configured → none (neutral), not a fake legend', () => {
    expect(mapSides(s, base)).toEqual({ ours: [], allies: [], enemies: [], source: 'none' });
  });
  it('verified players decide "ours"; enemies from recent conquests of our towns', () => {
    // town 300 was taken from alliance 20 by 20 → not an enemy; town 100 taken by 10 from 20 → when we are 20, 10 is the enemy
    expect(mapSides(s, { ...base, linkedPlayers: [3] })).toEqual({ ours: [20], allies: [], enemies: [10], source: 'verified' });
  });
  it('/roles alliances are used when nobody is verified', () => {
    expect(mapSides(s, { ...base, roleAlliances: [10] }).source).toBe('roles');
  });
  it('/war ally set is split into us (uploading own commands) and allies', () => {
    expect(mapSides(s, { ...base, explicitOurs: [10, 20], liveOwn: [10], explicitEnemies: [] })).toMatchObject({ ours: [10], allies: [20], source: 'set' });
    expect(mapSides(s, { ...base, explicitOurs: [10, 20] })).toMatchObject({ ours: [10, 20], allies: [], source: 'set' });
  });
  it('falls back to the live share, and to live attackers for enemies', () => {
    expect(mapSides(s, { ...base, liveOwn: [10], liveAttackers: [20], now: 1e9 })).toEqual({ ours: [10], allies: [], enemies: [20], source: 'live' });
  });
  it('explicit enemies win and never include friends; unknown ids are dropped', () => {
    expect(mapSides(s, { ...base, explicitOurs: [10], explicitEnemies: [10, 20, 777] }).enemies).toEqual([20]);
  });
  it('payload carries allies separately', () => {
    const p = buildMapPayload(s, { ours: [10], allies: [20], enemies: [], source: 'set' });
    expect(p.sides).toMatchObject({ ours: [10], allies: [20], source: 'set' });
  });
});

describe('live polling', () => {
  it('defaults: 5 s, 12 requests/min', () => {
    expect(config.livePollSeconds).toBe(5);
    expect(config.liveRpm).toBe(12);
  });
  it('stretches to the budget, backs off on failures and 429', () => {
    expect(pollInterval(5, 12, 1, 0)).toBe(6); // 60/11 → 6 s, one request/min spare
    expect(pollInterval(5, 12, 2, 0)).toBe(11);
    expect(pollInterval(5, 30, 1, 0)).toBe(5);
    expect(pollInterval(5, 12, 1, 1)).toBe(12);
    expect(pollInterval(5, 12, 1, 9)).toBe(120);
    expect(pollInterval(5, 12, 1, 1, true)).toBe(60);
    for (let t = 1; t <= 3; t++) expect(60 / pollInterval(5, 12, t, 0) * t).toBeLessThanOrEqual(30); // GrepoData limit
  });
  it('classifies errors for the banner', () => {
    expect(problemOf('intel.noToken')).toBe('token');
    expect(problemOf('intel.expired')).toBe('token');
    expect(problemOf('intel.refreshFailed')).toBe('refresh');
    expect(problemOf('web.err.noTeams')).toBe('noTeams');
    expect(problemOf('gd.rateLimited')).toBe('busy');
    expect(problemOf(null)).toBeNull();
  });
});

describe('islands', () => {
  const text = ['1,450,530,1,20,1,2', '2,451,530,12,10,1,2', '3,460,531,20,0,0,0', '4,999,999,1,20,1,2', 'junk'].join('\n');
  it('encodes the inhabited area compactly and round-trips', () => {
    const list = parseIslands(text);
    expect(list).toHaveLength(4);
    const box = townBox(snap());
    const raw = encodeIslands(list, box);
    const ab = new Uint8Array(raw).buffer;
    const d = decodeIslands(ab)!;
    expect(d.n).toBe(3); // (999,999) is outside the towns' box
    expect([...d.xs]).toEqual([450, 451, 460]);
    expect([...d.ys]).toEqual([530, 530, 531]);
    expect([...d.types]).toEqual([1, 12, 20]);
    expect([d.x0, d.y0]).toEqual([box[0], box[1]]);
    expect(decodeIslands(new ArrayBuffer(4))).toBeNull();
  });
  it('classifies island types', () => {
    expect(islandClass(1)).toBe('big'); expect(islandClass(12)).toBe('small'); expect(islandClass(20)).toBe('rock'); expect(islandClass(40)).toBe('big');
  });
  it('caches per world and does not hammer after a failure', async () => {
    let calls = 0; let fail = true; let t = 0;
    const f = (async () => { calls++; return fail ? new Response('no', { status: 500 }) : new Response(gzipSync(Buffer.from(text))); }) as unknown as typeof fetch;
    const c = new IslandCache(f, () => t);
    expect(await c.get(snap())).toBeNull();
    expect(await c.get(snap())).toBeNull();
    expect(calls).toBe(1);
    fail = false; t += 11 * 60_000;
    const [a, b] = await Promise.all([c.get(snap()), c.get(snap())]);
    expect(calls).toBe(2); // concurrent requests share one download
    expect(a?.count).toBe(3); expect(b).toBe(a);
    expect(a?.etag).toMatch(/^"i/);
  });
  it('grid index and ocean numbers', () => {
    const g = new Grid(50);
    g.add(0, 450, 530); g.add(1, 900, 900);
    const hit: number[] = []; g.each(440, 520, 460, 540, (i) => hit.push(i));
    expect(hit).toEqual([0]);
    expect(oceanOf(450, 530)).toBe(45);
  });
});

describe('live overview helpers', () => {
  const end = (town: string, player: string, id: number) => ({ town, townId: id, player, playerId: id, alliance: 'A', allianceId: 1 });
  const cmd = (id: string, over: Partial<LiveCommand>): LiveCommand => ({ id, type: 'attack', sub: '', arrival: 1000, started: null, src: end('S', 'Enemy', 1), trg: end('T', 'Me', 2), units: [['sword', 5]], by: 'Up', own: false, ret: false, planned: false, side: 'in', ...over });
  const all = [
    cmd('a', { arrival: 1000 }),
    cmd('b', { arrival: 900, type: 'support', units: [['bireme', 3]] }),
    cmd('c', { arrival: 1100, ret: true }),
    cmd('d', { arrival: 1200, side: 'out', trg: end('X', 'Foe', 3), by: 'Other' }),
  ];
  const f: Filters = { text: '', player: '', uploader: '', target: null, units: new Set(), returns: true, support: true, outgoing: true, other: true };
  it('filters by view settings, units, target, uploader and text', () => {
    expect(filterCommands(all, f)).toHaveLength(4);
    expect(filterCommands(all, { ...f, returns: false }).map((c) => c.id)).toEqual(['a', 'b', 'd']);
    expect(filterCommands(all, { ...f, support: false, outgoing: false }).map((c) => c.id)).toEqual(['a', 'c']);
    expect(filterCommands(all, { ...f, units: new Set(['bireme']) }).map((c) => c.id)).toEqual(['b']);
    expect(filterCommands(all, { ...f, target: 3 }).map((c) => c.id)).toEqual(['d']);
    expect(filterCommands(all, { ...f, uploader: 'Other' }).map((c) => c.id)).toEqual(['d']);
    expect(filterCommands(all, { ...f, text: 'foe' }).map((c) => c.id)).toEqual(['d']);
  });
  it('groups by target with headers in arrival order', () => {
    const rows = groupRows([...all].sort((a, b) => a.arrival - b.arrival), 'target');
    expect(rows.filter((r) => r.h).map((r) => (r as { label: string }).label)).toEqual(['T (Me)', 'X (Foe)']);
    expect(groupRows(all, 'none')).toHaveLength(4);
  });
  it('builds target cards (no returns), most attacked first', () => {
    const cards = targetCards(all, true);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: 2, n: 2, first: 900, avg: 950 });
    expect(targetCards(all, false)).toHaveLength(2);
  });
  it('countdown and command kinds', () => {
    expect(fmtCountdown(3725)).toBe('1:02:05');
    expect(fmtCountdown(-5)).toBe('0:00:00');
    expect(cmdKind('attack', '', false)).toBe('attack');
    expect(cmdKind('support', '', false)).toBe('support');
    expect(cmdKind('attack', 'revolt', false)).toBe('revolt');
    expect(cmdKind('attack', 'takeover', false)).toBe('conquest');
    expect(cmdKind('attack', '', true)).toBe('return');
    expect(cmdKind('espionage', '', false)).toBe('spy');
  });
  it('every Grepolis unit has its own icon (no external art)', () => {
    for (const [cat, ids] of Object.entries(UNIT_IDS)) for (const id of ids) {
      expect(unitDef(id).cat).toBe(cat);
      const svg = unitIcon(id, id);
      expect(svg).toContain('<svg');
      expect(svg).not.toMatch(/https?:/);
    }
    expect(unitDef('some_new_ship').cat).toBe('naval');
    expect(unitDef('new_beast').cat).toBe('myth');
  });
});
