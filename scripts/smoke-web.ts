// Ad-hoc smoke for batch 3: serves the web app with LIVE public world data and FAKE command-share data
// (no Discord, no GrepoData token). Prints a signed dashboard link; open it in a browser.
import http from 'node:http';
import { Store } from '../src/db.js';
import { WorldManager } from '../src/refresh.js';
import { GrepoDataClient } from '../src/data/grepodata.js';
import { createWebApp } from '../src/web/server.js';
import { townXY } from '../web/src/geo.js';
import { issueSession } from '../src/web/auth.js';

const W = process.env.SMOKE_WORLD ?? 'gr125';
const LANG = (process.env.SMOKE_LANG as 'en' | 'el') ?? 'el';
const PORT = Number(process.env.SMOKE_PORT ?? 8099);
const store = new Store(':memory:');
const worlds = new WorldManager(store);
const snap = await worlds.ensure(W);
store.setGuild({ guildId: 'G1', world: W, lang: LANG, verifiedRoleId: null });
const top = [...snap.alliances.values()].sort((a, b) => b.points - a.points);
store.setWarSide('G1', W, top[0].id, 'ours');
store.setWarSide('G1', W, top[1].id, 'enemy');
const exp = Date.now() + 3_600_000;
store.setGdToken({ guildId: 'G1', accessToken: `x.${Buffer.from(JSON.stringify({ exp: exp / 1000 })).toString('base64url')}.y`, refreshToken: null, accessExp: exp, refreshExp: null, adminUserId: null, source: 'command' });
const townsOf = (aid: number) => [...snap.towns.values()].filter((t) => t.playerId && snap.players.get(t.playerId)?.allianceId === aid);
store.setWarSide('G1', W, top[2].id, 'ours'); // an ally (pact) besides our own alliance
const ours = townsOf(top[0].id), them = townsOf(top[1].id);
const now = Math.floor(Date.now() / 1000);
const N = Number(process.env.SMOKE_COMMANDS ?? 60);
const UNITS = [{ sword: 120, slinger: 300, catapult: 1 }, { hoplite: 400, archer: 250 }, { attack_ship: 60 }, { big_transporter: 12, rider: 200, chariot: 40, manticore: 12 },
  { bireme: 80, trireme: 10 }, { colonize_ship: 1, big_transporter: 10, slinger: 400, sword: 50 }, { harpy: 30, griffin: 4, hercules: 1 }, { demolition_ship: 15, small_transporter: 8, medusa: 10 }];
const TYPES = ['attack', 'attack', 'attack', 'support', 'attack_takeover', 'revolt', 'attack', 'support'];
const UPLOADERS = ['Scout', 'Leonidas_GR', 'Ariadne', 'Kleon'];
const items = Array.from({ length: N }, (_, i) => {
  const inc = i % 4 !== 0;
  const tgt = inc ? ours[(i * 7) % Math.min(12, ours.length)] : them[(i * 5) % them.length];
  const s = inc ? them[(i * 3) % them.length] : ours[i % ours.length];
  const sp = snap.players.get(s.playerId!)!, tp = snap.players.get(tgt.playerId!)!;
  return { es_id: `c${i}`, arrival_at: now + 45 + i * 97, type: TYPES[i % TYPES.length], src_twn_id: s.id, src_twn_n: s.name, src_ply_n: sp.name, src_ply_id: sp.id, src_all_id: sp.allianceId, src_all_n: snap.alliances.get(sp.allianceId!)?.name,
    trg_twn_id: tgt.id, trg_twn_n: tgt.name, trg_ply_n: tp.name, trg_ply_id: tp.id, trg_all_id: tp.allianceId, trg_all_n: snap.alliances.get(tp.allianceId!)?.name, units: TYPES[i % TYPES.length] === 'support' && i % 3 === 0 ? {} : UNITS[i % UNITS.length], // some supports hide their units in the share
    upload_n: UPLOADERS[i % UPLOADERS.length], own_command: !inc, return: i % 13 === 12, subtype: TYPES[i % TYPES.length] === 'attack_takeover' ? (i % 3 ? 'command' : 'attack_takeover') : 'default',
    cancel_human: i % 5 === 1 ? '23:50:04 Nov 24' : '', started_at: now - 600 };
});
// GrepoData variety (raw API shape): fresh own attack (cancelable → has cancel_human), colonization, ongoing revolt, planned, spy, hidden.
{
  const o = ours[0], e = them[0], op = snap.players.get(o.playerId!)!, ep = snap.players.get(e.playerId!)!;
  const end = (p: 'src' | 'trg', t: typeof o, pl: typeof op) => ({ [`${p}_twn_id`]: t.id, [`${p}_twn_n`]: t.name, [`${p}_ply_id`]: pl.id, [`${p}_ply_n`]: pl.name, [`${p}_all_id`]: pl.allianceId, [`${p}_all_n`]: snap.alliances.get(pl.allianceId!)?.name });
  const base = (id: string, at: number, over: Record<string, unknown>) => ({ es_id: id, cmd_id: id, arrival_at: now + at, started_at: now - 200, upload_n: 'crashpoum99', own_command: true, return: false, subtype: 'default', delete_status: '', ...end('src', o, op), ...end('trg', e, ep), ...over });
  items.push(
    base('fresh', 20, { type: 'attack_land', cancel_human: '23:56:44 Nov 24', cancelable: true, units: { sword: 300, slinger: 500, catapult: 5 } }) as never,
    base('colo', 75, { type: 'foundation', subtype: 'cs_eta', units: { colonize_ship: 1 }, trg_twn_n: '16.2', trg_ply_id: 0, trg_ply_n: '' }) as never,
    base('siege', 130, { type: 'attack_takeover', subtype: 'attack_takeover', units: { colonize_ship: 1, sword: 200, hoplite: 300 }, ...end('src', e, ep), ...end('trg', o, op), own_command: false, upload_n: 'Scout' }) as never,
    base('rev', 900, { type: 'revolt', subtype: 'ongoing_revolt', started_at: now + 160, cancel_human: '00:10 Nov 25', units: {} }) as never,
    base('plan', 2400, { type: 'attack_land', is_planned: true, started_at: now + 1200, cancel_human: '00:05 Nov 25', units: { rider: 200 } }) as never,
    base('spy', 200, { type: 'attack_spy', units: '12000' }) as never,
    base('sup', 260, { type: 'support', cancel_human: '23:58 Nov 24', units: { hoplite: 400, archer: 150 } }) as never,
  );
}
const fakeGd = (async (u: string) => {
  const url = String(u);
  const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('activeteams')) return j({ success: true, operations: [{ index: 'abcd1234', team: 'Ops team', world: W, players: 5 }] });
  if (url.includes('/commands/get')) return j({ success: true, success_code: 8000, updated_at: now, items });
  if (url.includes('getindex')) return j({ total_reports: 1234, spy_reports: 210, enemy_attacks: 77, latest_intel: [{ town_id: them[0].id, town_name: them[0].name, player_name: 'Enemy', alliance_name: top[1].name, date: '24-11-26 20:01:00', units: [{ name: 'hoplite', count: 340 }, { name: 'archer', count: 120 }] }] });
  return j({ success: false });
}) as typeof fetch;
const ctx = { store, worlds, gd: new GrepoDataClient('https://gd', 1000, fakeGd) };
// Strategy drawings: a few demo shapes near our towns (+ SMOKE_MARKS random ones for perf checks).
{
  const xy = (t: { islandX: number; islandY: number; slot: number }) => townXY(t.islandX, t.islandY, t.slot);
  const c = ours.reduce((a, t) => { const [x, y] = xy(t); return [a[0] + x / ours.length, a[1] + y / ours.length]; }, [0, 0]);
  const e = xy(them[0]), o = xy(ours[0]), o2 = xy(ours[Math.min(5, ours.length - 1)]);
  const base = { guildId: 'G1', world: W, createdAt: Date.now(), expiresAt: Date.now() + 86400_000 };
  const add = (userId: string, author: string, kind: string, color: string, width: number, pts: number[], text = '') => store.addMark({ ...base, userId, author, kind, color, width, pts, text });
  add('U2', 'Leonidas_GR', 'arrow', '#ff3b3b', 4, [e[0], e[1], o[0], o[1]]);
  add('U2', 'Leonidas_GR', 'circle', '#ff3b3b', 4, [e[0] - 4, e[1] - 4, e[0] + 4, e[1] + 4]);
  add('U1', 'Smoke', 'arrow', '#3d8bff', 7, [o2[0], o2[1], (o2[0] + e[0]) / 2, (o2[1] + e[1]) / 2]);
  add('U1', 'Smoke', 'rect', '#ffd23f', 2, [c[0] - 12, c[1] - 9, c[0] + 12, c[1] + 9]);
  add('U3', 'Ariadne', 'text', '#ffd23f', 4, [o[0] + 3, o[1] - 3], 'Wave 1 lands 21:00, CS behind');
  add('U2', 'Leonidas_GR', 'text', '#ff3b3b', 4, [e[0] + 5, e[1] + 6], 'Enemy stack (~400 hops)');
  add('U3', 'Ariadne', 'pen', '#7dff6b', 4, Array.from({ length: 30 }, (_, i) => [c[0] - 20 + i * 1.2, c[1] + 14 + Math.sin(i / 3) * 2]).flat());
  add('U1', 'Smoke', 'circle', '#22c7c7', 4, [o2[0] - 6, o2[1] - 4, o2[0] + 6, o2[1] + 4]);
  const R = Number(process.env.SMOKE_MARKS ?? 0);
  const kinds = ['pen', 'arrow', 'circle', 'rect', 'line', 'text'];
  for (let i = 0; i < R; i++) {
    const k = kinds[i % kinds.length], x = c[0] + ((i * 37) % 120) - 60, y = c[1] + ((i * 53) % 100) - 50;
    const pts = k === 'pen' ? Array.from({ length: 60 }, (_, j) => [x + j * 0.3, y + Math.sin(j / 4) * 2]).flat() : k === 'text' ? [x, y] : [x, y, x + 5 + (i % 7), y + 3 + (i % 5)];
    add(`R${i % 9}`, `Player${i % 9}`, k, ['#ff3b3b', '#ffd23f', '#3d8bff', '#22c7c7'][i % 4], 4, pts, k === 'text' ? `note ${i}` : '');
  }
}
// GrepoGod troop snapshots (realistic fake data for the Troops tab).
{
  const xyTowns = (aid: number) => townsOf(aid);
  const pick = (aid: number, i: number) => {
    const list = xyTowns(aid);
    return list[i % list.length];
  };
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const res = (wood: number, stone: number, iron: number, storage: number, pop?: number) => ({ wood, stone, iron, storage, ...(pop != null ? { pop_free: pop } : {}) });
  const sp = (...ids: [string, number?][]) => ids.map(([id, inMin]) => ({ id, ...(inMin != null ? { ends_at: nowSec + inMin * 60 } : {}) }));
  const wall = (lv: number, q?: number, inMin?: number) => (q != null && q !== lv ? { w: lv, wq: q, wa: Math.floor(nowMs / 1000) + (inMin ?? 40) * 60 } : { w: lv });
  const add = (userId: string, playerId: number, playerName: string, recvAgoMin: number, towns: { t: (typeof ours)[0]; home: Record<string, number>; outer?: Record<string, number>; sup?: Record<string, number>; w?: number; wq?: number; wa?: number; res?: { wood: number; stone: number; iron: number; storage: number; pop_free?: number }; spells?: { id: string; ends_at?: number }[] }[]) => {
    const rows = towns.map(({ t, home, outer = {}, sup = {}, w, wq, wa, res, spells }) => {
      const total: Record<string, number> = { ...home };
      for (const [k, n] of Object.entries(outer)) total[k] = (total[k] ?? 0) + n;
      const it: Record<string, number> = { ...home };
      for (const [k, n] of Object.entries(sup)) it[k] = (it[k] ?? 0) + n;
      return { id: t.id, n: t.name, sea: Math.floor(t.islandX / 100) * 10 + Math.floor(t.islandY / 100), home, total, sup, it, ...(w != null ? { w, ...(wq != null ? { wq, wa } : {}) } : {}), ...(res ? { res } : {}), ...(spells ? { spells } : {}) };
    });
    store.upsertGgKey({ keyHash: `smoke:${userId}`, guildId: 'G1', userId, playerId, createdAt: nowMs });
    store.putGgTroops({ guildId: 'G1', world: W, playerId, playerName, userId, ts: nowMs - recvAgoMin * 60_000, recvAt: nowMs - recvAgoMin * 60_000, townsJson: JSON.stringify(rows) });
  };
  const o0 = ours[0], o1 = ours[Math.min(3, ours.length - 1)], o2 = ours[Math.min(7, ours.length - 1)];
  const o3 = ours[Math.min(11, ours.length - 1)];
  add('U1', 9001, 'Smoke', 0.4, [
    { t: o0, home: { sword: 420, slinger: 800, hoplite: 210, catapult: 8 }, outer: { bireme: 40, attack_ship: 12 }, sup: { hoplite: 150, archer: 80 }, ...wall(25, 26, 55), res: res(15000, 18600, 3000, 30600, 209), spells: sp(['happiness', 180], ['town_protection', 320], ['call_of_the_ocean']) },
    { t: o1, home: { rider: 180, chariot: 40, archer: 300 }, outer: { small_transporter: 20, slinger: 200 }, sup: {}, ...wall(20), res: res(8200, 9100, 6400, 18600, 80), spells: sp(['fertility_improvement', 90], ['pest', 40]) },
    { t: o2, home: { manticore: 6, griffin: 4, harpy: 20, sword: 50 }, outer: {}, sup: { hoplite: 400 }, ...wall(22, 21, 120), res: res(26000, 30600, 14000, 30600, 12), spells: [] },
  ]);
  add('U2', 9002, 'Leonidas_GR', 1.2, [
    { t: pick(top[0].id, 2), home: { sword: 1000, slinger: 1400, hoplite: 600, catapult: 20, archer: 500 }, outer: { bireme: 80, trireme: 15, colonize_ship: 1 }, sup: { sword: 200 }, ...wall(25), res: res(22000, 15400, 9800, 24800, 40), spells: sp(['spartan_training', 240], ['happiness', 60]) },
    { t: pick(top[0].id, 4), home: { attack_ship: 60, bireme: 30, demolition_ship: 8 }, outer: {}, sup: {}, ...wall(18), res: res(4000, 1200, 800, 12400, 310), spells: [] },
    { t: pick(top[0].id, 8), home: { medusa: 10, minotaur: 8, centaur: 40, pegasus: 6 }, outer: { big_transporter: 16 }, sup: { hoplite: 80 }, ...wall(24, 25, 80), res: res(11000, 10800, 17000, 18600, 5), spells: sp(['cap_of_invisibility', 25]) },
    { t: pick(top[0].id, 10), home: { militia: 200, sword: 40 }, outer: {}, sup: {}, ...wall(7), res: res(900, 700, 400, 3600, 120), spells: sp(['illusion', 15]) },
  ]);
  add('U3', 9003, 'Ariadne', 18, [ // stale
    { t: o3, home: { sword: 80, slinger: 120 }, outer: { bireme: 6 }, sup: {}, ...wall(15), res: res(5000, 4200, 2100, 8600, 60), spells: sp(['happiness', 10]) },
    { t: pick(top[0].id, 14), home: { hercules: 1, hoplite: 300, archer: 200 }, outer: {}, sup: { slinger: 50 }, ...wall(19), res: res(13000, 9000, 11000, 18600, 22), spells: [] },
  ]);
}
const app = createWebApp({ ctx, guilds: { has: () => true, name: () => 'Smoke server', manager: async () => true }, secret: 's'.repeat(32) });
http.createServer(app.handler).listen(PORT, () => {
  const tok = issueSession('s'.repeat(32), { u: 'U1', g: 'G1', n: 'Smoke' });
  console.log(`LIVE   http://localhost:${PORT}/go/live?t=${tok}`);
  console.log(`MAP    http://localhost:${PORT}/go/map?t=${tok}`);
  console.log(`TROOPS http://localhost:${PORT}/go/troops?t=${tok}`);
});
