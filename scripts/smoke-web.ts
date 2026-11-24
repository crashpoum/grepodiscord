// Ad-hoc smoke for batch 3: serves the web app with LIVE public world data and FAKE command-share data
// (no Discord, no GrepoData token). Prints a signed dashboard link; open it in a browser.
import http from 'node:http';
import { Store } from '../src/db.js';
import { WorldManager } from '../src/refresh.js';
import { GrepoDataClient } from '../src/data/grepodata.js';
import { createWebApp } from '../src/web/server.js';
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
    upload_n: UPLOADERS[i % UPLOADERS.length], own_command: !inc, return: i % 13 === 12 };
});
const fakeGd = (async (u: string) => {
  const url = String(u);
  const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('activeteams')) return j({ success: true, operations: [{ index: 'abcd1234', team: 'Ops team', world: W, players: 5 }] });
  if (url.includes('/commands/get')) return j({ success: true, success_code: 8000, updated_at: now, items });
  if (url.includes('getindex')) return j({ total_reports: 1234, spy_reports: 210, enemy_attacks: 77, latest_intel: [{ town_id: them[0].id, town_name: them[0].name, player_name: 'Enemy', alliance_name: top[1].name, date: '24-11-26 20:01:00', units: [{ name: 'hoplite', count: 340 }, { name: 'archer', count: 120 }] }] });
  return j({ success: false });
}) as typeof fetch;
const ctx = { store, worlds, gd: new GrepoDataClient('https://gd', 1000, fakeGd) };
const app = createWebApp({ ctx, guilds: { has: () => true, name: () => 'Smoke server' }, secret: 's'.repeat(32) });
http.createServer(app.handler).listen(PORT, () => {
  const tok = issueSession('s'.repeat(32), { u: 'U1', g: 'G1', n: 'Smoke' });
  console.log(`LIVE http://localhost:${PORT}/go/live?t=${tok}`);
  console.log(`MAP  http://localhost:${PORT}/go/map?t=${tok}`);
});
