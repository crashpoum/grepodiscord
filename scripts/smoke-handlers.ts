// Ad-hoc smoke test: drives handlers with fake interactions (no Discord connection).
import { Store } from '../src/db.js';
import { WorldManager } from '../src/refresh.js';
import { GrepoDataClient } from '../src/data/grepodata.js';
import { handleAutocomplete, handleCommand } from '../src/bot/handlers.js';

const store = new Store(':memory:');
// reuse CLI cache for speed
const cli = new Store(process.env.CLI_DB_PATH ?? './data/cli.sqlite');
for (const f of ['players','alliances','towns','conquers','player_kills_att','player_kills_def','alliance_kills_att','alliance_kills_def']) { const c = cli.getFile('gr126', f); if (c) store.putFile('gr126', f, c); }
const ctx = { store, worlds: new WorldManager(store), gd: new GrepoDataClient() };

function fake(commandName: string, sub: string | null, opts: Record<string, unknown>, focused?: string) {
  const out: unknown[] = [];
  const role = (id: string) => ({ id });
  const i: any = {
    commandName, guildId: 'G1', user: { id: 'U1' },
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
