// Ad-hoc smoke test for batch 1 (war room, alerts, op planner) against LIVE public gr125 data.
// No Discord connection: fake interactions + a fake client that records sends/edits/DMs.
import { Store } from '../src/db.js';
import { WorldManager } from '../src/refresh.js';
import { GrepoDataClient } from '../src/data/grepodata.js';
import { handleAutocomplete, handleCommand } from '../src/bot/handlers.js';
import { runOpReminders, updateBoardsForWorld } from '../src/bot/warPoster.js';

const W = process.env.SMOKE_WORLD ?? 'gr125';
const store = new Store(':memory:');
const ctx = { store, worlds: new WorldManager(store), gd: new GrepoDataClient() };
const snap = await ctx.worlds.ensure(W);
store.setGuild({ guildId: 'G1', world: W, lang: (process.env.SMOKE_LANG as 'en' | 'el') ?? 'en', verifiedRoleId: null });

// Pick a real player of the biggest alliance as "us", and a town of theirs.
const big = [...snap.alliances.values()].sort((a, b) => b.points - a.points)[0];
const me = [...snap.players.values()].find((p) => p.allianceId === big.id && (snap.townsByPlayer.get(p.id)?.length ?? 0) > 1)!;
const myTown = snap.townsByPlayer.get(me.id)![0];
store.setLink({ guildId: 'G1', userId: 'U1', world: W, playerId: me.id, verifiedAt: 1 });
const target = [...snap.towns.values()].find((x) => x.playerId && snap.players.get(x.playerId)?.allianceId !== big.id && Math.hypot(x.islandX - myTown.islandX, x.islandY - myTown.islandY) < 8)!;

const sent: unknown[] = [];
const fakeClient: any = {
  channels: { fetch: async () => ({ isSendable: () => true, send: async (p: any) => { sent.push({ send: p }); return { id: 'M1' }; }, messages: { edit: async (id: string, p: any) => { sent.push({ edit: id, p }); }, delete: async () => undefined } }) },
  users: { fetch: async (id: string) => ({ send: async (c: string) => { sent.push({ dm: id, c }); } }) },
  guilds: { fetch: async () => ({ name: 'Test' }) },
};
function fake(commandName: string, sub: string | null, opts: Record<string, unknown>, focused?: string) {
  const out: unknown[] = [];
  const i: any = {
    commandName, guildId: 'G1', channelId: 'CH1', user: { id: 'U1', createDM: async () => ({}) }, memberPermissions: { has: () => true }, client: fakeClient,
    guild: { id: 'G1', name: 'Test' }, deferred: false, replied: false,
    options: {
      getSubcommand: () => sub, getString: (n: string) => (opts[n] as string) ?? null, getInteger: (n: string) => (opts[n] as number) ?? null,
      getBoolean: (n: string) => (opts[n] as boolean) ?? null, getChannel: (n: string) => (opts[n] ? { id: opts[n] } : null), getUser: (n: string) => ({ id: opts[n] }),
      getFocused: () => ({ name: focused, value: opts[focused!] }), get: (n: string) => (opts[n] !== undefined ? { value: opts[n] } : null),
    },
    reply: async (p: any) => { i.replied = true; out.push(p); }, deferReply: async () => { i.deferred = true; }, editReply: async (p: any) => { out.push(p); },
    respond: async (c: any) => { out.push({ autocomplete: c.slice(0, 4) }); },
  };
  return { i, out };
}
const show = (label: string, out: unknown) => console.log(`\n## ${label}\n` + JSON.stringify(out).slice(0, 1500));

let r = fake('warroom', 'place', {}); await handleCommand(ctx, r.i); show('warroom place', r.out);
show('board message', sent.splice(0));
r = fake('warroom', 'enemy', { alliance: `id:${snap.players.get(target.playerId!)?.allianceId ?? 0}` }); await handleCommand(ctx, r.i); show('warroom enemy', r.out);
await updateBoardsForWorld(fakeClient, ctx, W); show('board edit', sent.splice(0));
r = fake('warroom', 'list', {}); await handleCommand(ctx, r.i); show('warroom list', r.out);
r = fake('alerts', 'on', { radius: 12 }); await handleCommand(ctx, r.i); show('alerts on', r.out);
r = fake('alerts', 'test', {}); await handleCommand(ctx, r.i); show('alerts test', r.out);
r = fake('op', 'create', { target: `id:${target.id}`, land: '23:59:00', name: 'Smoke' }); await handleCommand(ctx, r.i); show('op create', r.out);
r = fake('op', 'join', { op: 1, town: `id:${myTown.id}`, unit: process.env.SMOKE_LANG === 'el' ? 'ξιφ' : 'sw' }, 'unit'); await handleAutocomplete(ctx, r.i); show('autocomplete unit', r.out);
r = fake('op', 'join', { op: 1, town: `id:${myTown.id}`, unit: 'sword', meteorology: true }); await handleCommand(ctx, r.i); show('op join (estimate)', r.out);
r = fake('op', 'assign', { op: 1, member: 'U2', town: `id:${myTown.id}`, unit: 'bireme', travel: '0:42:10' }); await handleCommand(ctx, r.i); show('op assign (exact)', r.out);
r = fake('op', 'assign', { op: 1, member: 'U2', town: `id:${myTown.id}`, unit: 'tank', travel: '0:42:10' }); await handleCommand(ctx, r.i); show('op assign bad unit', r.out);
r = fake('op', 'create', { target: `id:${target.id}`, land: 'yesterday' }); await handleCommand(ctx, r.i); show('op bad time', r.out);
r = fake('op', 'show', { op: 1 }); await handleCommand(ctx, r.i); show('op show', r.out);
r = fake('op', null, { op: '' }, 'op'); await handleAutocomplete(ctx, r.i); show('autocomplete op', r.out);
show('DMs', sent.splice(0));
const m = store.opMembers(1)[0];
await runOpReminders(fakeClient, ctx, m.sendAt - 30); show('reminder', sent.splice(0));
r = fake('intel', 'town', { town: `id:${target.id}` }); await handleCommand(ctx, r.i); show('intel without token', r.out);
