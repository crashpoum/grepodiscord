/** Interaction handlers (slash commands + autocomplete). */
import { AttachmentBuilder, MessageFlags, type AutocompleteInteraction, type ChatInputCommandInteraction, type APIEmbed, type Guild } from 'discord.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { isValidWorldId, worldExists } from '../data/official.js';
import { searchByName } from '../data/snapshot.js';
import { parseOceanList } from '../geo.js';
import { t, type Lang, fmt } from '../i18n.js';
import { DEFAULT_MIN_BP, type FeedFilter, type FeedType } from '../feeds.js';
import { generateCode } from '../verify.js';
import { allianceCard, checkVerification, playerCard, radarGhosts, radarInactive, resolveAlliance, resolvePlayer, type Ctx } from '../services.js';
import { syncGuildRoles } from './poster.js';
import { gdAdmin, gdIntel, gdPublic } from './gdHandlers.js';
import { classifyError, logError, safeEmbed } from './errors.js';
import { handleOp, handleAlerts, handleWarroom, opAutocomplete } from './opsHandlers.js';
import { handleQuitRisk, radarSoft } from './insights.js';
import { handleNewspaper, handleReport } from './aiHandlers.js';

const COLOR_OK = 0x57f287;
const COLOR_ERR = 0xed4245;
const msg = (description: string, color = COLOR_OK): APIEmbed => ({ description, color });

function guildLang(ctx: Ctx, guildId: string | null): Lang {
  return guildId ? ctx.store.getGuild(guildId, config.defaultLang).lang : config.defaultLang;
}

/** Resolve the world for a command: explicit option, else guild default. */
function worldFor(ctx: Ctx, i: ChatInputCommandInteraction | AutocompleteInteraction): string | null {
  const opt = i.options.getString('world')?.trim().toLowerCase();
  if (opt) return opt;
  return i.guildId ? ctx.store.getGuild(i.guildId).world : null;
}

// ---------------------------------------------------------------- autocomplete
export async function handleAutocomplete(ctx: Ctx, i: AutocompleteInteraction) {
  try {
    const focused = i.options.getFocused(true);
    const q = String(focused.value ?? '');
    if (focused.name === 'op' || focused.name === 'unit') return void (await opAutocomplete(ctx, i, focused.name, q));
    if (focused.name === 'world') {
      const servers = await Promise.race([ctx.gd.activeWorlds(config.markets), new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 2000))]);
      const worlds = servers.flatMap((s) => s.worlds.map((w) => ({ name: `${w.id}${w.name !== w.id ? ` · ${w.name}` : ''}`, value: w.id })));
      await i.respond(worlds.filter((w) => w.name.toLowerCase().includes(q.toLowerCase())).slice(0, 25));
      return;
    }
    const world = worldFor(ctx, i);
    if (!world || !isValidWorldId(world)) return void (await i.respond([]));
    const snap = ctx.worlds.get(world) ?? (ctx.worlds.loadFromCache(world) ? ctx.worlds.get(world) : undefined);
    if (!snap) { void ctx.worlds.ensure(world).catch(() => undefined); return void (await i.respond([])); }
    const cmd = i.commandName;
    let choices: { name: string; value: string }[] = [];
    const isAlliance = focused.name === 'alliance' || (cmd === 'alliance' && focused.name === 'name');
    const isTown = focused.name === 'near_town' || focused.name === 'town' || focused.name === 'target';
    if (isAlliance) {
      choices = searchByName(snap.alliances.values(), q, 25, (a) => a.points).map((a) => ({ name: `${a.name} · ${fmt(a.points, 'en')} pts · ${a.members} m.`, value: `id:${a.id}` }));
    } else if (isTown) {
      choices = searchByName(snap.towns.values(), q, 25, (x) => x.points).map((x) => ({ name: `${x.name} · ${snap.players.get(x.playerId ?? -1)?.name ?? 'ghost'} · (${x.islandX}|${x.islandY})`, value: `id:${x.id}` }));
    } else {
      choices = searchByName(snap.players.values(), q, 25, (p) => p.points).map((p) => ({ name: `${p.name} · ${fmt(p.points, 'en')} pts · ${snap.alliances.get(p.allianceId ?? -1)?.name ?? '-'}`, value: `id:${p.id}` }));
    }
    await i.respond(choices.map((c) => ({ name: c.name.slice(0, 100), value: c.value })));
  } catch (e) {
    log.debug(`autocomplete failed: ${e}`);
    try { await i.respond([]); } catch { /* already responded/expired */ }
  }
}

// ---------------------------------------------------------------- commands
export async function handleCommand(ctx: Ctx, i: ChatInputCommandInteraction) {
  const lang = guildLang(ctx, i.guildId);
  try {
    switch (i.commandName) {
      case 'help': return void (await i.reply({ embeds: [{ title: t(lang, 'help.title'), description: t(lang, 'help.body'), color: 0x5865f2 }], flags: MessageFlags.Ephemeral }));
      case 'setup': return await setup(ctx, i, lang);
      case 'player': case 'alliance': return await lookup(ctx, i, lang);
      case 'radar': return await radar(ctx, i, lang);
      case 'feed': return await feed(ctx, i, lang);
      case 'verify': return await verify(ctx, i, lang);
      case 'roles': return await roles(ctx, i, lang);
      case 'grepodata': return await gdAdmin(ctx, i, lang);
      case 'warroom': return await handleWarroom(ctx, i, lang);
      case 'alerts': return await handleAlerts(ctx, i, lang);
      case 'op': return await handleOp(ctx, i, lang);
      case 'report': return await handleReport(ctx, i, lang);
      case 'newspaper': return await handleNewspaper(ctx, i, lang);
      case 'quitrisk': {
        const world = await requireWorld(ctx, i, lang);
        if (!world) return;
        await i.deferReply();
        return await handleQuitRisk(ctx, i, lang, world);
      }
      case 'top': case 'wars': case 'changes': case 'conquests': case 'town': case 'intel': {
        const world = await requireWorld(ctx, i, lang);
        if (!world) return;
        return i.commandName === 'intel' ? await gdIntel(ctx, i, lang, world) : await gdPublic(ctx, i, lang, world);
      }
    }
  } catch (e) {
    const c = classifyError(e);
    logError(`command /${i.commandName}${i.options.getSubcommand(false) ? ` ${i.options.getSubcommand(false)}` : ''}`, e, c);
    const payload = { embeds: [msg(t(lang, c.key, c.vars), COLOR_ERR)] };
    if (i.deferred || i.replied) await i.editReply(payload).catch(() => undefined);
    else await i.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }
}

async function requireWorld(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang): Promise<string | null> {
  const world = worldFor(ctx, i);
  if (!world) { await reply(i, msg(t(lang, 'err.noWorld'), COLOR_ERR), true); return null; }
  if (!isValidWorldId(world)) { await reply(i, msg(t(lang, 'err.badWorld', { world, markets: config.markets.join('/') }), COLOR_ERR), true); return null; }
  return world;
}

async function reply(i: ChatInputCommandInteraction, embed: APIEmbed, ephemeral = false) {
  if (i.deferred || i.replied) return void (await i.editReply({ embeds: [safeEmbed(embed)] }));
  await i.reply({ embeds: [safeEmbed(embed)], ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
}

async function setup(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang) {
  if (!i.guildId) return reply(i, msg(t(lang, 'err.guildOnly'), COLOR_ERR), true);
  const g = ctx.store.getGuild(i.guildId, config.defaultLang);
  const sub = i.options.getSubcommand();
  if (sub === 'world') {
    const world = i.options.getString('world', true).trim().toLowerCase();
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (!isValidWorldId(world) || !(await worldExists(world))) return reply(i, msg(t(lang, 'err.badWorld', { world, markets: config.markets.join('/') }), COLOR_ERR));
    ctx.store.setGuild({ ...g, world });
    void ctx.worlds.ensure(world).catch((e) => log.warn(`initial load ${world}: ${e}`));
    return reply(i, msg(t(lang, 'setup.worldSet', { world })));
  }
  if (sub === 'language') {
    const l = i.options.getString('language', true) as Lang;
    ctx.store.setGuild({ ...g, lang: l });
    return reply(i, msg(t(l, 'setup.langSet')), true);
  }
  const roles = ctx.store.getAllianceRoles(i.guildId);
  return reply(i, msg(t(lang, 'setup.show', {
    world: g.world ?? '-', lang: g.lang, verified: g.verifiedRoleId ? `<@&${g.verifiedRoleId}>` : '-',
    roles: roles.size, feeds: ctx.store.feedsForGuild(i.guildId).length,
  })), true);
}

async function lookup(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang) {
  const world = await requireWorld(ctx, i, lang);
  if (!world) return;
  await i.deferReply();
  const q = i.options.getString('name', true);
  const card = i.commandName === 'player' ? await playerCard(ctx, world, q, lang) : await allianceCard(ctx, world, q, lang);
  if (!card) return reply(i, msg(t(lang, 'err.notFound', { q, world }), COLOR_ERR));
  const files = card.chart ? [new AttachmentBuilder(card.chart, { name: 'history.png' })] : [];
  if (card.chart) card.embed.image = { url: 'attachment://history.png' };
  await i.editReply({ embeds: [card.embed], files });
}

async function radar(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang) {
  const world = await requireWorld(ctx, i, lang);
  if (!world) return;
  await i.deferReply();
  if (i.options.getSubcommand() === 'soft') return radarSoft(ctx, i, lang, world);
  const args = {
    oceans: parseOceanList(i.options.getString('ocean')), nearTown: i.options.getString('near_town') ?? undefined,
    radius: i.options.getInteger('radius') ?? undefined, hours: i.options.getInteger('hours') ?? undefined,
    minPoints: i.options.getInteger('min_points') ?? undefined,
  };
  const embed = i.options.getSubcommand() === 'inactive' ? await radarInactive(ctx, world, args, lang) : await radarGhosts(ctx, world, args, lang);
  await i.editReply({ embeds: [embed] });
}

async function feed(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang) {
  if (!i.guildId) return reply(i, msg(t(lang, 'err.guildOnly'), COLOR_ERR), true);
  const sub = i.options.getSubcommand();
  if (sub === 'list') {
    const feeds = ctx.store.feedsForGuild(i.guildId);
    if (!feeds.length) return reply(i, msg(t(lang, 'feed.list.empty')), true);
    const lines = feeds.map((f) => `**#${f.id}** ${f.type} → <#${f.channelId}> · ${f.world} · \`${JSON.stringify(f.filter)}\``);
    return reply(i, { title: t(lang, 'feed.list.title'), description: lines.join('\n').slice(0, 3900), color: COLOR_OK }, true);
  }
  if (sub === 'remove') {
    const id = i.options.getInteger('id', true);
    return reply(i, msg(ctx.store.removeFeed(i.guildId, id) ? t(lang, 'feed.removed', { id }) : t(lang, 'feed.notFoundId', { id }), COLOR_OK), true);
  }
  const world = await requireWorld(ctx, i, lang);
  if (!world) return;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const snap = await ctx.worlds.ensure(world);
  const type = i.options.getString('type', true) as FeedType;
  const channel = i.options.getChannel('channel', true);
  const filter: FeedFilter = {};
  const aq = i.options.getString('alliance');
  if (aq) { const a = resolveAlliance(snap, aq); if (!a) return reply(i, msg(t(lang, 'err.notFound', { q: aq, world }), COLOR_ERR)); filter.allianceIds = [a.id]; }
  const pq = i.options.getString('player');
  if (pq) { const p = resolvePlayer(snap, pq); if (!p) return reply(i, msg(t(lang, 'err.notFound', { q: pq, world }), COLOR_ERR)); filter.playerIds = [p.id]; }
  const oceans = parseOceanList(i.options.getString('ocean'));
  if (oceans.length) filter.oceans = oceans;
  if (type === 'bp') { filter.minBp = i.options.getInteger('min_bp') ?? DEFAULT_MIN_BP; filter.bpKind = (i.options.getString('bp_kind') as FeedFilter['bpKind']) ?? 'any'; }
  if (i.options.getBoolean('skip_ghosts')) filter.skipGhosts = true;
  const id = ctx.store.addFeed({ guildId: i.guildId, channelId: channel.id, world, type, filter });
  return reply(i, msg(t(lang, 'feed.added', { id, type, channel: `<#${channel.id}>`, world })));
}

async function verify(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang) {
  if (!i.guildId || !i.guild) return reply(i, msg(t(lang, 'err.guildOnly'), COLOR_ERR), true);
  const sub = i.options.getSubcommand();
  const g = ctx.store.getGuild(i.guildId);
  if (sub === 'status') {
    const l = ctx.store.getLink(i.guildId, i.user.id);
    if (!l) return reply(i, msg(t(lang, 'verify.notLinked')), true);
    const name = ctx.worlds.get(l.world)?.players.get(l.playerId)?.name ?? `#${l.playerId}`;
    return reply(i, msg(t(lang, 'verify.status', { player: name, world: l.world, date: `<t:${l.verifiedAt}:D>` })), true);
  }
  if (sub === 'unlink') {
    ctx.store.removeLink(i.guildId, i.user.id);
    ctx.store.removePending(i.guildId, i.user.id);
    await syncGuildRoles(ctx, i.guild, [i.user.id]).catch(() => undefined);
    return reply(i, msg(t(lang, 'verify.unlinked')), true);
  }
  if (sub === 'start') {
    const world = await requireWorld(ctx, i, lang);
    if (!world) return;
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const snap = await ctx.worlds.ensure(world);
    const q = i.options.getString('player', true);
    const p = resolvePlayer(snap, q);
    if (!p) return reply(i, msg(t(lang, 'err.notFound', { q, world }), COLOR_ERR));
    const other = ctx.store.linkForPlayer(i.guildId, world, p.id);
    if (other && other.userId !== i.user.id) return reply(i, msg(t(lang, 'verify.taken', { player: p.name }), COLOR_ERR));
    const code = generateCode();
    ctx.store.setPending({ guildId: i.guildId, userId: i.user.id, world, playerId: p.id, code, createdAt: Math.floor(Date.now() / 1000) });
    const example = `${(snap.townsByPlayer.get(p.id)?.[0]?.name ?? 'Town').slice(0, 13)} ${code}`;
    return reply(i, { description: `${t(lang, 'verify.start', { player: p.name, world, code, example })}\n\n_${t(lang, 'verify.why')}_`, color: 0x5865f2 });
  }
  // check
  const pending = ctx.store.getPending(i.guildId, i.user.id);
  if (!pending) return reply(i, msg(t(lang, 'verify.noPending')), true);
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const r = await checkVerification(ctx, pending);
  const name = ctx.worlds.get(pending.world)?.players.get(pending.playerId)?.name ?? `#${pending.playerId}`;
  if (r.status === 'ok') {
    await syncGuildRoles(ctx, i.guild, [i.user.id]).catch((e) => log.warn(`role sync after verify: ${e}`));
    return reply(i, msg(t(lang, 'verify.ok', { player: r.player.name, world: pending.world })));
  }
  if (r.status === 'expired') return reply(i, msg(t(lang, 'verify.expired'), COLOR_ERR));
  if (r.status === 'taken') return reply(i, msg(t(lang, 'verify.taken', { player: r.player.name }), COLOR_ERR));
  const last = ctx.worlds.lastRefreshAt(pending.world);
  return reply(i, msg(t(lang, 'verify.pending', { player: name, code: pending.code, ago: last ? `<t:${last}:R>` : '-' }), 0xfee75c));

}

async function roles(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang) {
  if (!i.guildId || !i.guild) return reply(i, msg(t(lang, 'err.guildOnly'), COLOR_ERR), true);
  const sub = i.options.getSubcommand();
  const g = ctx.store.getGuild(i.guildId, config.defaultLang);
  if (sub === 'verified') {
    const role = i.options.getRole('role', true);
    ctx.store.setGuild({ ...g, verifiedRoleId: role.id });
    return reply(i, msg(`${t(lang, 'roles.verifiedSet', { role: `<@&${role.id}>` })}\n${t(lang, 'roles.hierarchy')}`), true);
  }
  if (sub === 'list') {
    const snap = g.world ? ctx.worlds.get(g.world) : undefined;
    const lines = [...ctx.store.getAllianceRoles(i.guildId)].map(([a, r]) => `${snap?.alliances.get(a)?.name ?? `#${a}`} → <@&${r}>`);
    return reply(i, msg(t(lang, 'roles.list', { verified: g.verifiedRoleId ? `<@&${g.verifiedRoleId}>` : '-', lines: lines.join('\n') || '-' })), true);
  }
  if (sub === 'sync') {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const r = await syncGuildRoles(ctx, i.guild);
    return reply(i, msg(t(lang, 'roles.synced', { changed: r.changed, errors: r.errors })));
  }
  const world = await requireWorld(ctx, i, lang);
  if (!world) return;
  const snap = await ctx.worlds.ensure(world);
  const aq = i.options.getString('alliance', true);
  const a = resolveAlliance(snap, aq);
  if (!a) return reply(i, msg(t(lang, 'err.notFound', { q: aq, world }), COLOR_ERR), true);
  if (sub === 'alliance') {
    const role = i.options.getRole('role', true);
    ctx.store.setAllianceRole(i.guildId, a.id, role.id);
    return reply(i, msg(`${t(lang, 'roles.allianceSet', { alliance: a.name, role: `<@&${role.id}>` })}\n${t(lang, 'roles.hierarchy')}`), true);
  }
  ctx.store.removeAllianceRole(i.guildId, a.id);
  return reply(i, msg(t(lang, 'roles.allianceRemoved', { alliance: a.name })), true);
}

export type { Guild };
