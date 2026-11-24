/** Handlers for the GrepoData commands: /top /wars /changes /conquests /town /intel /grepodata. */
import { MessageFlags, PermissionFlagsBits, type APIEmbed, type ChatInputCommandInteraction } from 'discord.js';
import type { ConquestFilter } from '../data/grepodata.js';
import { decodeJwt, jwtExpMs, looksLikeJwt, renewToken, saveToken } from '../gdAuth.js';
import {
  changes, conquestHistory, intelBrowse, intelTown, topHour, topRanking, topScoreboard, townInfo, townRadar, townSearch, wars, UserError,
} from '../gdServices.js';
import type { RankSort, TopKind } from '../gdViews.js';
import { t, type Lang } from '../i18n.js';
import type { Ctx } from '../services.js';
import { discordTs } from '../time.js';
import { safeEmbed } from './errors.js';

const COLOR_OK = 0x57f287;
const COLOR_ERR = 0xed4245;
const PRIVATE = { flags: MessageFlags.Ephemeral } as const;

async function show(i: ChatInputCommandInteraction, embed: APIEmbed) {
  await i.editReply({ embeds: [safeEmbed(embed)] });
}

/** Public GrepoData lookups (deferred, public reply). */
export async function gdPublic(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang, world: string) {
  await i.deferReply();
  const o = i.options;
  const sub = o.getSubcommand(false);
  const page = o.getInteger('page') ?? undefined;
  const kind = (o.getString('kind') ?? 'player') as TopKind;
  let e: APIEmbed;
  switch (i.commandName) {
    case 'top':
      e = sub === 'hour' ? await topHour(ctx, world, o.getInteger('hour') ?? undefined, lang)
        : sub === 'ranking' ? await topRanking(ctx, world, kind, (o.getString('sort') ?? 'Points') as RankSort, page, lang)
          : await topScoreboard(ctx, world, kind, sub === 'yesterday', lang);
      break;
    case 'wars': e = await wars(ctx, world, o.getString('alliance', true), lang); break;
    case 'changes':
      e = await changes(ctx, world, sub as 'alliance' | 'player' | 'world', sub === 'alliance' ? o.getString('alliance', true) : sub === 'player' ? o.getString('player', true) : null, page, lang);
      break;
    case 'conquests': {
      const scope = sub as 'player' | 'alliance' | 'town';
      e = await conquestHistory(ctx, world, scope, o.getString(scope, true), (o.getString('filter') ?? 'all') as ConquestFilter, page, lang);
      break;
    }
    default: // town
      e = sub === 'search' ? await townSearch(ctx, world, o.getString('query', true), lang)
        : sub === 'info' ? await townInfo(ctx, world, o.getString('town', true), lang)
          : await townRadar(ctx, world, { town: o.getString('town'), x: o.getInteger('x'), y: o.getInteger('y'), radius: o.getInteger('radius'), ghostsOnly: o.getBoolean('ghosts_only') }, lang);
  }
  await show(i, e);
}

/** City Indexer intel: only with THIS guild's token; private unless asked in the guild's intel channel. */
export async function gdIntel(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang, world: string) {
  if (!i.guildId) throw new UserError('err.guildOnly');
  const row = ctx.store.getGdToken(i.guildId);
  const publicHere = !!row?.intelChannelId && row.intelChannelId === i.channelId;
  await i.deferReply(publicHere ? {} : PRIVATE);
  const sub = i.options.getSubcommand();
  const r = sub === 'town'
    ? await intelTown(ctx, i.guildId, i.channelId, world, i.options.getString('town', true), lang)
    : await intelBrowse(ctx, i.guildId, i.channelId, world, sub as 'player' | 'alliance', i.options.getString(sub, true), lang);
  await show(i, r.embed);
}

/** /grepodata token|status|channel|clear: admin only, always private. Token values are never echoed or logged. */
export async function gdAdmin(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang) {
  const say = (description: string, color = COLOR_OK) => i.reply({ embeds: [{ description: description.slice(0, 4000), color }], ...PRIVATE });
  if (!i.guildId) return void (await say(t(lang, 'err.guildOnly'), COLOR_ERR));
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return void (await say(t(lang, 'gdtoken.adminOnly'), COLOR_ERR));
  const guildId = i.guildId;
  const sub = i.options.getSubcommand();
  const adminMention = (id: string | null) => (id ? `<@${id}>` : i.guild?.ownerId ? `<@${i.guild.ownerId}>` : '-');

  if (sub === 'clear') return void (await say(t(lang, ctx.store.clearGdToken(guildId) ? 'gdtoken.cleared' : 'gdtoken.notSet')));

  if (sub === 'channel') {
    const ch = i.options.getChannel('channel');
    if (!ctx.store.setGdIntelChannel(guildId, ch?.id ?? null)) return void (await say(t(lang, 'gdtoken.notSet'), COLOR_ERR));
    return void (await say(ch ? t(lang, 'gdtoken.channelSet', { channel: `<#${ch.id}>` }) : t(lang, 'gdtoken.channelCleared')));
  }

  if (sub === 'status') {
    const row = ctx.store.getGdToken(guildId);
    if (!row) return void (await say(`${t(lang, 'gdtoken.notSet')}\n\n${t(lang, 'gdtoken.howto')}`));
    const claims = row.accessToken ? decodeJwt(row.accessToken) : null;
    const renew = row.refreshToken ? t(lang, 'gdtoken.status.renewOn', { exp: discordTs(row.refreshExp ? Math.floor(row.refreshExp / 1000) : null, 'D') }) : t(lang, 'gdtoken.status.renewOff');
    return void (await say(`${t(lang, 'gdtoken.status', {
      user: claims?.username ? String(claims.username) : '?', exp: discordTs(row.accessExp ? Math.floor(row.accessExp / 1000) : null, 'R'), renew,
      channel: row.intelChannelId ? `<#${row.intelChannelId}>` : '-', admin: adminMention(row.adminUserId), error: row.lastError ?? '-',
    })}\n\n${t(lang, 'gdtoken.howto')}`));
  }

  // token
  await i.deferReply(PRIVATE);
  const done = (description: string, color = COLOR_OK) => i.editReply({ embeds: [{ description: description.slice(0, 4000), color }] });
  const access = i.options.getString('access_token', true).trim();
  const refresh = i.options.getString('refresh_token')?.trim() || null;
  if (!looksLikeJwt(access) || (refresh && !looksLikeJwt(refresh))) return void (await done(t(lang, 'gdtoken.invalid'), COLOR_ERR));
  const exp = jwtExpMs(access);
  const expired = exp !== null && exp <= Date.now();
  if (expired && !refresh) return void (await done(t(lang, 'gdtoken.alreadyExpired', { exp: discordTs(Math.floor(exp / 1000), 'R') }), COLOR_ERR));
  saveToken(ctx.store, guildId, access, refresh, i.user.id, 'command');
  let lead = '';
  if (expired) {
    const res = await renewToken(ctx.store, ctx.gd, ctx.store.getGdToken(guildId)!, 'refresh');
    const now = ctx.store.getGdToken(guildId)!;
    if (res !== 'refreshed') return void (await done(t(lang, 'gdtoken.refreshFailed', { error: now.lastError ?? 'network' }), COLOR_ERR));
    lead = `${t(lang, 'gdtoken.renewedNow', { exp: discordTs(now.accessExp ? Math.floor(now.accessExp / 1000) : null, 'f') })}\n`;
  }
  const row = ctx.store.getGdToken(guildId)!;
  const user = decodeJwt(row.accessToken)?.username ?? '?';
  const lines = [
    lead + t(lang, 'gdtoken.saved', { user: String(user), exp: discordTs(row.accessExp ? Math.floor(row.accessExp / 1000) : null, 'R') }),
    row.refreshToken ? t(lang, 'gdtoken.renew.on', { exp: discordTs(row.refreshExp ? Math.floor(row.refreshExp / 1000) : null, 'D') }) : t(lang, 'gdtoken.renew.off', { admin: `<@${i.user.id}>` }),
  ];
  if (!row.refreshToken) lines.push('', t(lang, 'gdtoken.howto'));
  await done(lines.join('\n'));
}
