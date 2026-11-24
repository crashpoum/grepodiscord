// Ad-hoc smoke test for batch 2 (soft targets, quit risk, AI reports, newspaper) against LIVE public gr125 data.
// No Discord, no Gemini key needed: Gemini is faked unless SMOKE_GEMINI=1 and GEMINI_API_KEY is set.
import { Store } from '../src/db.js';
import { WorldManager } from '../src/refresh.js';
import { GrepoDataClient } from '../src/data/grepodata.js';
import { handleCommand } from '../src/bot/handlers.js';
import { handleReportContext } from '../src/bot/aiHandlers.js';
import { recordHistory } from '../src/bot/insights.js';
import { updateBoardsForWorld } from '../src/bot/warPoster.js';
import { Gemini } from '../src/ai/gemini.js';
import { dailyRows, dayIn, shiftDay } from '../src/targets.js';

const W = process.env.SMOKE_WORLD ?? 'gr125';
const LANG = (process.env.SMOKE_LANG as 'en' | 'el') ?? 'en';
const store = new Store(':memory:');
const fakeReport = { is_report: true, kind: 'spy', time: '24.11.2026 20:15:00', attacker: { player: 'Me', town: 'X' }, defender: { player: 'Them', town: 'Y' }, defender_units: [{ unit: 'hoplite', name: 'Οπλίτης', count: 340, lost: 0 }], buildings: [{ name: 'Τείχος', level: 25 }], resources: { wood: 12000, stone: 9000, silver: 15000 }, summary: 'Spy OK' };
const ai = process.env.SMOKE_GEMINI === '1'
  ? new Gemini({ apiKey: process.env.GEMINI_API_KEY ?? '', store })
  : new Gemini({ apiKey: 'fake', store, fetch: (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(fakeReport) }] } }] }), { status: 200 })) as unknown as typeof fetch });
const ctx = { store, worlds: new WorldManager(store), gd: new GrepoDataClient(), ai };
const snap = await ctx.worlds.ensure(W);
store.setGuild({ guildId: 'G1', world: W, lang: LANG, verifiedRoleId: null });
// Fake a week of history: a week ago everyone had 3% fewer points and the same BP.
const today = dayIn('Europe/Athens', Math.floor(Date.now() / 1000));
const { players, alliances } = dailyRows(snap);
store.recordDaily(W, shiftDay(today, -7), players.map((p) => ({ ...p, points: Math.round(p.points * 0.97) })), alliances.map((a) => ({ ...a, points: Math.round(a.points * 0.97) })));
recordHistory(ctx, snap);

const big = [...snap.alliances.values()].sort((a, b) => b.points - a.points)[0];
const me = [...snap.players.values()].find((p) => p.allianceId === big.id && (snap.townsByPlayer.get(p.id)?.length ?? 0) > 1)!;
store.setLink({ guildId: 'G1', userId: 'U1', world: W, playerId: me.id, verifiedAt: 1 });
const someTown = snap.townsByPlayer.get(me.id)![0];

const sent: unknown[] = [];
const fakeClient: any = {
  channels: { fetch: async () => ({ isSendable: () => true, send: async (p: any) => { sent.push({ send: p }); return { id: 'M1' }; }, messages: { edit: async (id: string, p: any) => { sent.push({ edit: id, p }); }, delete: async () => undefined } }) },
  users: { fetch: async (id: string) => ({ send: async (c: string) => { sent.push({ dm: id, c }); } }) },
  guilds: { fetch: async () => ({ name: 'Test' }) },
};
function fake(commandName: string, sub: string | null, opts: Record<string, unknown>) {
  const out: unknown[] = [];
  const i: any = {
    commandName, guildId: 'G1', channelId: 'CH1', user: { id: 'U1' }, memberPermissions: { has: () => true }, client: fakeClient, deferred: false, replied: false,
    options: {
      getSubcommand: () => sub, getString: (n: string) => (opts[n] as string) ?? null, getInteger: (n: string) => (opts[n] as number) ?? null,
      getBoolean: (n: string) => (opts[n] as boolean) ?? null, getChannel: (n: string) => (opts[n] ? { id: opts[n] } : null), getAttachment: (n: string) => (opts[n] as any) ?? null,
    },
    reply: async (p: any) => { i.replied = true; out.push(p); }, deferReply: async () => { i.deferred = true; }, editReply: async (p: any) => { out.push(p); },
    showModal: async (m: any) => { out.push({ modal: m.toJSON() }); },
  };
  return { i, out };
}
const show = (label: string, out: unknown) => console.log(`\n## ${label}\n` + JSON.stringify(out).slice(0, 1800));
const t0 = Date.now();
let r = fake('radar', 'soft', {}); await handleCommand(ctx, r.i); show(`radar soft (me) ${Date.now() - t0} ms`, r.out);
r = fake('radar', 'soft', { around: 'alliance', radius: 10, ghosts: false }); await handleCommand(ctx, r.i); show('radar soft (alliance)', r.out);
r = fake('quitrisk', null, {}); await handleCommand(ctx, r.i); show('quitrisk (default scope)', r.out);
r = fake('quitrisk', null, { player: `id:${me.id}` }); await handleCommand(ctx, r.i); show('quitrisk player', r.out);
r = fake('quitrisk', null, { near_town: `id:${someTown.id}`, radius: 10 }); await handleCommand(ctx, r.i); show('quitrisk near', r.out);
r = fake('warroom', 'options', { quitters: true, soft_targets: true }); await handleCommand(ctx, r.i); show('warroom options', r.out);
r = fake('warroom', 'place', {}); await handleCommand(ctx, r.i); show('warroom place', r.out);
show('board (with extras)', sent.splice(0));
r = fake('report', 'parse', {}); await handleCommand(ctx, r.i); show('report parse (no input → modal)', r.out);
r = fake('report', 'parse', { text: 'Αναφορά κατασκοπείας ...' }); await handleCommand(ctx, r.i); show('report parse text', r.out);
r = fake('report', 'search', { town: 'Y' }); await handleCommand(ctx, r.i); show('report search', r.out);
r = fake('report', 'show', { id: 1 }); await handleCommand(ctx, r.i); show('report show', r.out);
const ctxNoKey = { ...ctx, ai: new Gemini({ apiKey: '' }) };
r = fake('report', 'parse', { text: 'x' }); await handleCommand(ctxNoKey, r.i); show('report parse without key', r.out);
const cm: any = { guildId: 'G1', user: { id: 'U9' }, deferred: false, replied: false, targetMessage: { content: '', embeds: [], attachments: { find: () => null } },
  reply: async (p: any) => { cm.replied = true; show('context menu (empty message)', p); }, deferReply: async () => { cm.deferred = true; }, editReply: async (p: any) => show('context menu', p) };
await handleReportContext(ctx, cm);
r = fake('newspaper', 'channel', { channel: 'CH9', day: 0, hour: 20 }); await handleCommand(ctxNoKey, r.i); show('newspaper channel', r.out);
r = fake('newspaper', 'preview', {}); await handleCommand(ctxNoKey, r.i); show('newspaper preview (template)', r.out);
r = fake('newspaper', 'status', {}); await handleCommand(ctx, r.i); show('newspaper status', r.out);
r = fake('newspaper', 'post', {}); await handleCommand(ctxNoKey, r.i); show('newspaper post', r.out); show('posted', sent.splice(0));
await updateBoardsForWorld(fakeClient, ctx, W);
