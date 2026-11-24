/** Handlers for /warroom, /alerts and /op (batch 1), plus their autocomplete. */
import { MessageFlags, PermissionFlagsBits, type APIEmbed, type AutocompleteInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { config } from '../config.js';
import type { Op, OpMods } from '../db.js';
import { isValidWorldId } from '../data/official.js';
import type { WorldSnapshot } from '../data/snapshot.js';
import { getWorldInfo, peekWorldInfo } from '../data/worldInfo.js';
import { UserError } from '../gdServices.js';
import { t, type Lang } from '../i18n.js';
import { log } from '../log.js';
import { estimateTravel, fmtDuration, parseDuration, parseLandTime, UNIT_EN, worldClock, type WorldInfo } from '../planner.js';
import { resolveAlliance, resolveTown, type Ctx } from '../services.js';
import { findThreats, threatMessage } from '../threats.js';
import { worldTz } from '../time.js';
import { safeEmbed } from './errors.js';
import { BOARD_KEYS } from './insights.js';
import { boardComponents, notifyOpMember, rollBaselines, sidesFor, unitName, updateBoard } from './warPoster.js';

const COLOR_OK = 0x57f287;
const COLOR_WARN = 0xfee75c;
const PRIVATE = { flags: MessageFlags.Ephemeral } as const;
const nowSec = () => Math.floor(Date.now() / 1000);

export async function say(i: ChatInputCommandInteraction, description: string, opts: { ephemeral?: boolean; color?: number; embed?: APIEmbed } = {}) {
  const embed = safeEmbed(opts.embed ?? { description, color: opts.color ?? COLOR_OK });
  if (i.deferred || i.replied) return void (await i.editReply({ embeds: [embed] }));
  await i.reply({ embeds: [embed], ...(opts.ephemeral ? PRIVATE : {}) });
}

export function worldOf(ctx: Ctx, i: ChatInputCommandInteraction): string {
  const w = i.options.getString('world')?.trim().toLowerCase() || (i.guildId ? ctx.store.getGuild(i.guildId).world : null);
  if (!w) throw new UserError('err.noWorld');
  if (!isValidWorldId(w)) throw new UserError('err.badWorld', { world: w, markets: config.markets.join('/') });
  return w;
}
export const isAdmin = (i: ChatInputCommandInteraction) => !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

// ---------------------------------------------------------------- /warroom
export async function handleWarroom(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang) {
  if (!i.guildId) throw new UserError('err.guildOnly');
  if (!isAdmin(i)) throw new UserError('gdtoken.adminOnly');
  const guildId = i.guildId;
  const sub = i.options.getSubcommand();
  await i.deferReply(PRIVATE);

  if (sub === 'place') {
    const world = worldOf(ctx, i);
    const channelId = i.options.getChannel('channel')?.id ?? i.channelId;
    rollBaselines(ctx, await ctx.worlds.ensure(world)); // start the 24h "top movers" window now if none exists
    const id = ctx.store.addBoard({ guildId, channelId, world, createdBy: i.user.id });
    const ok = await updateBoard(i.client, ctx, ctx.store.getBoard(guildId, id)!);
    if (!ok) { ctx.store.removeBoard(guildId, id); return say(i, t(lang, 'war.noChannel', { channel: `<#${channelId}>` }), { color: COLOR_WARN }); }
    return say(i, t(lang, 'war.placed', { id, channel: `<#${channelId}>` }));
  }
  if (sub === 'remove') {
    const id = i.options.getInteger('id', true);
    const b = ctx.store.getBoard(guildId, id);
    if (!b) return say(i, t(lang, 'war.notFound', { id }), { color: COLOR_WARN });
    if (b.messageId) {
      const ch = await i.client.channels.fetch(b.channelId).catch(() => null);
      if (ch && 'messages' in ch) await ch.messages.delete(b.messageId).catch(() => undefined);
    }
    ctx.store.removeBoard(guildId, id);
    return say(i, t(lang, 'war.removed', { id }));
  }
  if (sub === 'refresh') {
    let n = 0;
    for (const b of ctx.store.boardsForGuild(guildId)) if (await updateBoard(i.client, ctx, b)) n++;
    return say(i, t(lang, 'war.refreshed', { n }));
  }
  if (sub === 'options') {
    const q = i.options.getBoolean('quitters');
    const so = i.options.getBoolean('soft_targets');
    if (q !== null) ctx.store.setSetting(guildId, BOARD_KEYS.quitters, q ? '1' : null);
    if (so !== null) ctx.store.setSetting(guildId, BOARD_KEYS.soft, so ? '1' : null);
    const yes = (k: string) => t(lang, ctx.store.getSetting(guildId, k) === '1' ? 'war.optOn' : 'war.optOff');
    if (q !== null || so !== null) for (const b of ctx.store.boardsForGuild(guildId)) await updateBoard(i.client, ctx, b);
    return say(i, t(lang, 'war.options', { quitters: yes(BOARD_KEYS.quitters), soft: yes(BOARD_KEYS.soft) }));
  }
  const world = worldOf(ctx, i);
  const snap = await ctx.worlds.ensure(world);
  if (sub === 'list') {
    const boards = ctx.store.boardsForGuild(guildId).map((b) => `**#${b.id}** → <#${b.channelId}> · ${b.world} · ${b.updatedAt ? `<t:${Math.floor(b.updatedAt / 1000)}:R>` : '-'}${b.lastError ? ` · ⚠️ ${b.lastError.slice(0, 80)}` : ''}`);
    const sides = sidesFor(ctx, guildId, snap);
    const names = (ids: number[], auto: boolean) => (ids.map((id) => snap.alliances.get(id)?.name ?? `#${id}`).join(', ') || '-') + (auto ? ` _(${t(lang, 'war.auto')})_` : '');
    return say(i, t(lang, 'war.list', { boards: boards.join('\n') || '-', ours: names(sides.ours, sides.autoOurs), enemies: names(sides.enemies, sides.autoEnemies) }));
  }
  const aq = i.options.getString('alliance', true);
  const a = resolveAlliance(snap, aq);
  if (!a) throw new UserError('err.notFound', { q: aq, world });
  if (sub === 'unset') return say(i, t(lang, ctx.store.removeWarSide(guildId, world, a.id) ? 'war.sideRemoved' : 'war.sideNone', { alliance: a.name, world }));
  const side = sub === 'ally' ? 'ours' : 'enemy';
  ctx.store.setWarSide(guildId, world, a.id, side);
  return say(i, t(lang, 'war.sideSet', { alliance: a.name, side: t(lang, side === 'ours' ? 'war.side.ours' : 'war.side.enemy'), world }));
}

// ---------------------------------------------------------------- /alerts
export async function handleAlerts(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang) {
  if (!i.guildId) throw new UserError('err.guildOnly');
  const sub = i.options.getSubcommand();
  const cur = ctx.store.getThreatSub(i.guildId, i.user.id);
  const scopeText = (s: string) => t(lang, s === 'all' ? 'alerts.scope.all' : 'alerts.scope.enemies');
  if (sub === 'off') { ctx.store.removeThreatSub(i.guildId, i.user.id); return say(i, t(lang, 'alerts.off'), { ephemeral: true }); }
  if (sub === 'status') {
    if (!cur) return say(i, t(lang, 'alerts.notOn'), { ephemeral: true });
    return say(i, t(lang, 'alerts.status', { radius: cur.radius, minBp: cur.minBp, scope: scopeText(cur.scope), last: cur.lastAlertAt ? `<t:${cur.lastAlertAt}:R>` : '-' }), { ephemeral: true });
  }
  const link = ctx.store.getLink(i.guildId, i.user.id);
  if (!link) throw new UserError('alerts.needLink');
  await i.deferReply(PRIVATE);
  const snap = await ctx.worlds.ensure(link.world);
  if (sub === 'test') {
    const s = cur ?? { radius: 10, minBp: 3000, scope: 'enemies' as const };
    const sides = sidesFor(ctx, i.guildId, snap);
    const since = nowSec() - 86_400;
    const items = findThreats({ playerId: link.playerId, radius: s.radius, minBp: s.minBp, scope: s.scope }, snap, { conquests: snap.conquers.filter((c) => c.time >= since), founded: [], bp: [] }, sides.ours, sides.enemies);
    if (!items.length) return say(i, t(lang, 'alerts.testNone'));
    return say(i, '', { embed: { title: t(lang, 'alerts.testTitle'), description: threatMessage(items, snap, lang, i.guild?.name ?? ''), color: COLOR_WARN } });
  }
  // on
  const radius = i.options.getInteger('radius') ?? cur?.radius ?? 10;
  const minBp = i.options.getInteger('min_bp') ?? cur?.minBp ?? 3000;
  const scope = (i.options.getString('scope') ?? cur?.scope ?? 'enemies') === 'all' ? 'all' : 'enemies';
  ctx.store.setThreatSub({ guildId: i.guildId, userId: i.user.id, radius, minBp, scope });
  const player = snap.players.get(link.playerId)?.name ?? `#${link.playerId}`;
  let text = t(lang, 'alerts.on', { player, world: link.world, radius, minBp, scope: scopeText(scope) });
  // Probe DMs once so the member knows immediately if alerts cannot reach them.
  if (!(await i.user.createDM().then(() => true).catch(() => false))) text += `\n\n${t(lang, 'alerts.dmFailed')}`;
  return say(i, text);
}

// ---------------------------------------------------------------- /op
function resolveUnit(info: WorldInfo, q: string): string | null {
  const v = q.trim().toLowerCase();
  if (info.units.has(v)) return v;
  for (const u of info.units.values()) if (u.name.toLowerCase() === v || (UNIT_EN[u.id] ?? '').toLowerCase() === v) return u.id;
  return null;
}

function opCard(op: Op, ctx: Ctx, snap: WorldSnapshot, lang: Lang): APIEmbed {
  const tz = worldTz(op.world);
  const target = snap.towns.get(op.targetTownId);
  const owner = target?.playerId != null ? snap.players.get(target.playerId)?.name ?? '-' : t(lang, 'feed.conquest.ghost');
  const members = ctx.store.opMembers(op.id);
  const lines = members.map((m) => t(lang, 'op.card.member', {
    user: m.userId, town: snap.towns.get(m.originTownId)?.name ?? `#${m.originTownId}`, unit: unitName(m.unit, lang, op.world),
    send: `<t:${m.sendAt}:T>`, rel: `<t:${m.sendAt}:R>`, est: m.estimated ? ` ≈±${fmtDuration(m.uncertainty)}` : ' ✓',
  }));
  return {
    title: t(lang, 'op.card.title', { id: op.id, name: op.name ? ` · ${op.name}` : '', target: target?.name ?? `#${op.targetTownId}` }),
    description: [
      t(lang, 'op.card.desc', { target: target?.name ?? `#${op.targetTownId}`, owner, x: target?.islandX ?? '?', y: target?.islandY ?? '?', land: `<t:${op.landAt}:F>`, rel: `<t:${op.landAt}:R>`, clock: worldClock(op.landAt, tz), leader: op.creatorId }),
      '', ...(lines.length ? lines : [t(lang, 'op.card.none')]),
    ].join('\n'),
    color: 0xe67e22, footer: { text: `${op.world} · ${t(lang, 'op.card.footer')}` },
  };
}

function requireOp(ctx: Ctx, guildId: string, id: number): Op {
  const op = ctx.store.getOp(guildId, id);
  if (!op || op.status !== 'open') throw new UserError('op.notFound', { id });
  return op;
}

export async function handleOp(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang) {
  if (!i.guildId) throw new UserError('err.guildOnly');
  const guildId = i.guildId;
  const sub = i.options.getSubcommand();

  if (sub === 'list') {
    const ops = ctx.store.opsForGuild(guildId, 'open');
    if (!ops.length) return say(i, t(lang, 'op.listEmpty'), { ephemeral: true });
    const lines = ops.map((o) => {
      const snap = ctx.worlds.get(o.world);
      return `**#${o.id}**${o.name ? ` ${o.name}` : ''} → ${snap?.towns.get(o.targetTownId)?.name ?? `#${o.targetTownId}`} · <t:${o.landAt}:f> (<t:${o.landAt}:R>) · ${ctx.store.opMembers(o.id).length} 👤 · <@${o.creatorId}>`;
    });
    return say(i, '', { ephemeral: true, embed: { title: t(lang, 'op.listTitle'), description: lines.join('\n'), color: 0xe67e22 } });
  }

  if (sub === 'create') {
    const world = worldOf(ctx, i);
    await i.deferReply();
    const snap = await ctx.worlds.ensure(world);
    const tq = i.options.getString('target', true);
    const target = resolveTown(snap, tq);
    if (!target) throw new UserError('err.notFound', { q: tq, world });
    const landQ = i.options.getString('land', true);
    const landAt = parseLandTime(landQ, worldTz(world), nowSec());
    if (landAt === null) throw new UserError('op.badTime', { q: landQ });
    if (landAt <= nowSec()) throw new UserError('op.pastTime');
    const name = i.options.getString('name')?.trim() || null;
    const id = ctx.store.addOp({ guildId, world, name, targetTownId: target.id, landAt, creatorId: i.user.id, channelId: i.channelId });
    void getWorldInfo(world, ctx.store).catch((e) => log.warn(`world info ${world}: ${e}`)); // warm unit list for autocomplete
    const op = ctx.store.getOp(guildId, id)!;
    const owner = target.playerId != null ? snap.players.get(target.playerId)?.name ?? '-' : t(lang, 'feed.conquest.ghost');
    const head = t(lang, 'op.created', { id, name: name ? `“${name}” ` : '', target: target.name, owner, land: `<t:${landAt}:F>`, clock: worldClock(landAt, worldTz(world)) });
    const card = opCard(op, ctx, snap, lang);
    return void (await i.editReply({ embeds: [safeEmbed({ ...card, description: `${head}\n\n${card.description}` })] }));
  }

  const op = requireOp(ctx, guildId, i.options.getInteger('op', true));
  const leader = op.creatorId === i.user.id || isAdmin(i);

  if (sub === 'show') {
    const snap = await ctx.worlds.ensure(op.world);
    await getWorldInfo(op.world, ctx.store).catch(() => undefined);
    return say(i, '', { embed: opCard(op, ctx, snap, lang) });
  }
  if (sub === 'cancel') {
    if (!leader) throw new UserError('op.notLeader');
    ctx.store.setOpStatus(op.id, 'cancelled');
    return say(i, t(lang, 'op.cancelled', { id: op.id }));
  }
  if (sub === 'leave') {
    return say(i, t(lang, ctx.store.removeOpMember(op.id, i.user.id) ? 'op.left' : 'op.notIn', { id: op.id }), { ephemeral: true });
  }

  // assign | join
  const member = sub === 'assign' ? i.options.getUser('member', true) : i.user;
  if (sub === 'assign' && !leader) throw new UserError('op.notLeader');
  await i.deferReply(PRIVATE);
  const snap = await ctx.worlds.ensure(op.world);
  const info = await getWorldInfo(op.world, ctx.store);
  const townQ = i.options.getString('town', true);
  const from = resolveTown(snap, townQ);
  if (!from) throw new UserError('err.notFound', { q: townQ, world: op.world });
  const target = snap.towns.get(op.targetTownId);
  if (!target) throw new UserError('err.notFound', { q: `#${op.targetTownId}`, world: op.world });
  const unitQ = i.options.getString('unit', true);
  const unit = resolveUnit(info, unitQ);
  if (!unit) throw new UserError('op.badUnit', { q: unitQ });
  const mods: OpMods = {
    meteorology: i.options.getBoolean('meteorology') ?? undefined, cartography: i.options.getBoolean('cartography') ?? undefined,
    lighthouse: i.options.getBoolean('lighthouse') ?? undefined, boost: i.options.getInteger('boost') ?? undefined, transport: i.options.getString('transport') ?? undefined,
  };
  const travelQ = i.options.getString('travel');
  let travelSecs: number;
  let estimated = false;
  let uncertainty = 0;
  if (travelQ) {
    const d = parseDuration(travelQ);
    if (d === null) throw new UserError('op.badTravel', { q: travelQ });
    travelSecs = d;
  } else {
    const est = estimateTravel(from, target, unit, info, mods);
    travelSecs = est.seconds;
    estimated = true;
    uncertainty = est.uncertainty;
    if (est.viaTransport) mods.transport = est.viaTransport;
  }
  const sendAt = op.landAt - travelSecs;
  ctx.store.upsertOpMember({ opId: op.id, userId: member.id, originTownId: from.id, unit, travelSecs, estimated, uncertainty, sendAt, mods, assignedBy: i.user.id });
  const m = ctx.store.opMembers(op.id).find((x) => x.userId === member.id && x.originTownId === from.id)!;

  const notes: string[] = [];
  const link = ctx.store.getLink(guildId, member.id);
  if (!link) notes.push(t(lang, 'op.noLink', { who: `<@${member.id}>` }));
  else if (link.world === op.world && from.playerId !== link.playerId) notes.push(t(lang, 'op.notYourTown', { town: from.name, who: `<@${member.id}>` }));
  if (sendAt <= nowSec()) notes.push(t(lang, 'op.tooLate'));
  const dmOk = await notifyOpMember(i.client, ctx, op, m);
  if (!dmOk) notes.push(t(lang, 'op.dmFailed', { who: `<@${member.id}>` }));
  const est = estimated ? t(lang, 'op.estimate', { pm: fmtDuration(uncertainty) }) : t(lang, 'op.exact');
  const line = t(lang, 'op.assigned', {
    who: `<@${member.id}>`, unit: unitName(unit, lang, op.world), town: from.name, send: `<t:${sendAt}:T>`, rel: `<t:${sendAt}:R>`,
    clock: worldClock(sendAt, worldTz(op.world)), travel: fmtDuration(travelSecs), est,
  });
  return say(i, [line, ...notes].join('\n'), { color: notes.length ? COLOR_WARN : COLOR_OK });
}

// ---------------------------------------------------------------- autocomplete
export async function opAutocomplete(ctx: Ctx, i: AutocompleteInteraction, field: 'op' | 'unit', q: string) {
  const lang: Lang = i.guildId ? ctx.store.getGuild(i.guildId, config.defaultLang).lang : config.defaultLang;
  if (field === 'op') {
    const ops = i.guildId ? ctx.store.opsForGuild(i.guildId, 'open') : [];
    const choices = ops.map((o) => {
      const tn = ctx.worlds.get(o.world)?.towns.get(o.targetTownId)?.name ?? `#${o.targetTownId}`;
      return { name: `#${o.id}${o.name ? ` ${o.name}` : ''} → ${tn} · ${worldClock(o.landAt, worldTz(o.world))}`.slice(0, 100), value: o.id };
    }).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()));
    return void (await i.respond(choices.slice(0, 25)));
  }
  // unit: the op's world, else the guild world
  const opId = i.options.get('op')?.value;
  const op = i.guildId && typeof opId === 'number' ? ctx.store.getOp(i.guildId, opId) : null;
  const world = op?.world ?? (i.guildId ? ctx.store.getGuild(i.guildId).world : null);
  if (!world) return void (await i.respond([]));
  // Autocomplete must answer within 3 s: wait at most 2 s for the (cached) unit list, else fall back to English names.
  const info = peekWorldInfo(world) ?? await Promise.race([getWorldInfo(world, ctx.store).catch(() => undefined), new Promise<undefined>((r) => setTimeout(r, 2000))]);
  const units = info ? [...info.units.values()] : Object.keys(UNIT_EN).map((id) => ({ id, name: UNIT_EN[id], speed: 0 }));
  const choices = units.map((u) => {
    const label = lang === 'en' ? UNIT_EN[u.id] ?? u.name : u.name;
    return { name: `${label}${u.speed ? ` · ${u.speed}` : ''}`.slice(0, 100), value: u.id };
  }).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.value.includes(q.toLowerCase()));
  await i.respond(choices.slice(0, 25));
}

export { boardComponents };
