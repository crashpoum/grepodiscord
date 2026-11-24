// Ad-hoc smoke test: drives handlers with fake interactions (no Discord connection).
import { Store } from '../src/db.js';
import { WorldManager } from '../src/refresh.js';
import { GrepoDataClient } from '../src/data/grepodata.js';
import { handleAutocomplete, handleCommand } from '../src/bot/handlers.js';

const store = new Store(':memory:');
// reuse CLI cache for speed
const cli = new Store(process.env.CLI_DB_PATH ?? './data/cli.sqlite');
for (const w of ['gr126', 'gr125']) for (const f of ['players','alliances','towns','conquers','player_kills_att','player_kills_def','alliance_kills_att','alliance_kills_def']) { const c = cli.getFile(w, f); if (c) store.putFile(w, f, c); }
const ctx = { store, worlds: new WorldManager(store), gd: new GrepoDataClient() };

function fake(commandName: string, sub: string | null, opts: Record<string, unknown>, focused?: string) {
  const out: unknown[] = [];
  const role = (id: string) => ({ id });
  const i: any = {
    commandName, guildId: 'G1', channelId: 'CH1', user: { id: 'U1' }, memberPermissions: { has: () => true },
    guild: { id: 'G1', name: 'Test', members: { fetch: async () => ({ roles: { cache: new Map([['other', {}]]), add: async (r: string[]) => out.push({ addRoles: r }), remove: async (r: string[]) => out.push({ removeRoles: r }) } }) } },
    deferred: false, replied: false,
    options: {
      getSubcommand: () => sub, getString: (n: string, req?: boolean) => (opts[n] as string) ?? null, getInteger: (n: string) => (opts[n] as number) ?? null,
      getBoolean: (n: string) => (opts[n] as boolean) ?? null, getChannel: (n: string) => ({ id: opts[n] }), getRole: (n: string) => role(opts[n] as string),
      getFocused: () => ({ name: focused, value: opts[focused!] }),
    },
    reply: async (p: any) => { i.replied = true; out.push(p); }, deferReply: async () => { i.deferred = true; }, editReply: async (p: any) => { out.push(p); },
    respond: async (c: any) => { out.push({ autocomplete: c.slice(0, 3) }); },
  };
  return { i, out };
}
const show = (label: string, out: unknown[]) => console.log(`\n## ${label}\n` + JSON.stringify(out, (k, v) => (k === 'attachment' || (v && v.type === 'Buffer') ? '[png]' : v), 1).replace(/\n\s*/g, ' ').slice(0, 700));

let r = fake('help', null, {}); await handleCommand(ctx, r.i); show('help', r.out);
r = fake('player', null, { name: 'ultra' }); await handleCommand(ctx, r.i); show('player without world', r.out);
store.setGuild({ guildId: 'G1', world: 'gr126', lang: 'el', verifiedRoleId: null });
r = fake('player', null, { name: 'ultra' }, 'name'); await handleAutocomplete(ctx, r.i); show('autocomplete player', r.out);
r = fake('alliance', null, { name: 'ιερα' }, 'name'); await handleAutocomplete(ctx, r.i); show('autocomplete alliance', r.out);
r = fake('player', null, { name: 'ultramike99' }); await handleCommand(ctx, r.i); show('player', r.out);
r = fake('feed', 'add', { type: 'conquests', channel: 'C1', alliance: '-ΙΕΡΑ ΕΞΕΤΑΣΗ-', ocean: '55' }); await handleCommand(ctx, r.i); show('feed add', r.out);
r = fake('feed', 'list', {}); await handleCommand(ctx, r.i); show('feed list', r.out);
r = fake('radar', 'ghosts', { ocean: '44' }); await handleCommand(ctx, r.i); show('radar ghosts', r.out);
r = fake('verify', 'start', { player: 'ultramike99' }); await handleCommand(ctx, r.i); show('verify start', r.out);
r = fake('verify', 'check', {}); await handleCommand(ctx, r.i); show('verify check', r.out);
r = fake('roles', 'alliance', { alliance: '-ΙΕΡΑ ΕΞΕΤΑΣΗ-', role: 'R1' }); await handleCommand(ctx, r.i); show('roles alliance', r.out);
// simulate successful verification by forging pending code to match an existing town name fragment
const p = store.getPending('G1', 'U1')!; const town = (await ctx.worlds.ensure('gr126')).townsByPlayer.get(p.playerId)![0];
store.setPending({ ...p, code: town.name });
r = fake('verify', 'check', {}); await handleCommand(ctx, r.i); show('verify check (simulated match)', r.out);
r = fake('setup', 'show', {}); await handleCommand(ctx, r.i); show('setup show', r.out);

// ---- GrepoData features on gr125 (live public API; intel only without a real token → no 401s)
store.setGuild({ guildId: 'G1', world: 'gr125', lang: 'en', verifiedRoleId: null });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (exp: number) => `${b64({ typ: 'JWT' })}.${b64({ username: 'smoke', iat: exp - 86400, exp })}.sig`;
const now = Math.floor(Date.now() / 1000);
for (const [label, cmd, sub, opts] of [
  ['top today', 'top', 'today', {}], ['top yesterday alliances', 'top', 'yesterday', { kind: 'alliance' }], ['top hour', 'top', 'hour', {}],
  ['top ranking', 'top', 'ranking', { kind: 'alliance', sort: 'AttDef' }], ['wars', 'wars', null, { alliance: 'EL-TRUCOOOOO' }],
  ['changes alliance', 'changes', 'alliance', { alliance: 'EL-TRUCOOOOO' }], ['changes world p2', 'changes', 'world', { page: 2 }],
  ['conquests player', 'conquests', 'player', { player: 'Grimmjow', filter: 'enemy' }], ['town search', 'town', 'search', { query: 'zagan' }],
  ['town info', 'town', 'info', { town: 'ZAGAN 14' }], ['town radar xy', 'town', 'radar', { x: 500, y: 500, radius: 6 }], ['town radar none', 'town', 'radar', {}],
  ['intel without token', 'intel', 'town', { town: 'ZAGAN 14' }],
  ['token invalid', 'grepodata', 'token', { access_token: 'not-a-token' }],
  ['token expired, no refresh', 'grepodata', 'token', { access_token: fakeJwt(now - 60) }],
  ['token ok (no network)', 'grepodata', 'token', { access_token: fakeJwt(now + 3600) }],
  ['status', 'grepodata', 'status', {}], ['channel', 'grepodata', 'channel', { channel: 'CH1' }], ['clear', 'grepodata', 'clear', {}],
  ['intel after clear', 'intel', 'player', { player: 'ZAGAN' }],
] as const) {
  const f = fake(cmd, sub, opts as Record<string, unknown>);
  if (cmd === 'grepodata' && sub === 'channel' && !(opts as Record<string, unknown>).channel) f.i.options.getChannel = () => null;
  await handleCommand(ctx, f.i);
  show(label, f.out);
}
r = fake('intel', 'town', { town: 'ZAGAN' }, 'town'); await handleAutocomplete(ctx, r.i); show('autocomplete intel town', r.out);
