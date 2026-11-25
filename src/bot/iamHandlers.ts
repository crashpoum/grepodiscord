/**
 * /iam (pick your player, instant "unconfirmed" link, admin approves with one click), /activity (player activity
 * clock), /admin (personal admin-panel link) and the /live "Refresh now" button.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { runtime } from '../bridge.js';
import { UserError } from '../gdServices.js';
import { t, type Lang } from '../i18n.js';
import { resolvePlayer, type Ctx } from '../services.js';
import { DEFAULT_SETTINGS } from '../admin/settings.js';
import { claimAllowed, confirmLink, createClaim } from '../admin/linking.js';
import { clockBar, liveBoardPayload, trackerSides, tzOffsetMin } from './trackers.js';
import { resolveGuild, syncGuildRoles } from './poster.js';
import { LINK_HOURS, webSecret } from '../web/auth.js';
import { dashboardLink } from '../web/server.js';

export const IAM_PREFIX = 'iam:';
export const LIVE_REFRESH = 'live:refresh';
const settingsOf = (g: string) => runtime.admin?.settings(g) ?? DEFAULT_SETTINGS;
const displayName = (i: ChatInputCommandInteraction | ButtonInteraction) => (i.member && 'displayName' in i.member ? String(i.member.displayName) : i.user.globalName ?? i.user.username);
const isBotAdmin = (g: string, u: string) => runtime.admin?.isBotAdmin(g, u) ?? false;

export async function handleIam(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang, world: string) {
  if (!i.guildId) throw new UserError('err.guildOnly');
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const snap = await ctx.worlds.ensure(world);
  const q = i.options.getString('player', true);
  const p = resolvePlayer(snap, q);
  if (!p) return void (await i.editReply({ embeds: [{ description: t(lang, 'err.notFound', { q, world }), color: 0xed4245 }] }));
  const s = settingsOf(i.guildId);
  const sides = trackerSides(ctx, i.guildId, snap, s);
  const allowed = claimAllowed(snap, p.id, { ours: [...sides.friendly], allies: [] }, s);
  if (!allowed.ok) return void (await i.editReply({ embeds: [{ description: t(lang, 'iam.notOurs', { player: p.name }), color: 0xed4245 }] }));
  const now = Date.now();
  if (isBotAdmin(i.guildId, i.user.id)) {
    const r = confirmLink(ctx.store, i.guildId, i.user.id, world, p.id, i.user.id, now);
    if (!r.ok) return void (await i.editReply({ embeds: [{ description: t(lang, 'verify.taken', { player: p.name }), color: 0xed4245 }] }));
    const guild = await resolveGuild(i);
    if (guild) await syncGuildRoles(ctx, guild, [i.user.id]).catch(() => undefined);
    return void (await i.editReply({ embeds: [{ description: t(lang, 'iam.confirmed', { player: p.name, world }), color: 0x57f287 }] }));
  }
  const r = createClaim(ctx.store, { guildId: i.guildId, userId: i.user.id, userName: displayName(i), world, playerId: p.id, source: 'iam' }, now);
  if (!r.ok) return void (await i.editReply({ embeds: [{ description: t(lang, r.why === 'already' ? 'iam.already' : 'verify.taken', { player: p.name, world }), color: r.why === 'already' ? 0x57f287 : 0xed4245 }] }));
  const ch = s.linking.adminChannelId;
  if (ch && runtime.bridge) {
    const ally = p.allianceId ? snap.alliances.get(p.allianceId)?.name ?? '' : '';
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${IAM_PREFIX}ok:${i.user.id}`).setStyle(ButtonStyle.Success).setLabel(t(lang, 'iam.approve')),
      new ButtonBuilder().setCustomId(`${IAM_PREFIX}no:${i.user.id}`).setStyle(ButtonStyle.Danger).setLabel(t(lang, 'iam.reject')));
    await runtime.bridge.post(ch, { embeds: [{ title: t(lang, 'iam.requestTitle'), description: t(lang, 'iam.request', { user: `<@${i.user.id}>`, player: p.name, alliance: ally || '-', points: p.points.toLocaleString('en'), world }), color: 0x5865f2 }], components: [row.toJSON()], allowedMentions: { parse: [] } })
      .catch((e) => log.warn(`iam request post ${i.guildId}: ${(e as Error).message}`));
  }
  const basic = s.linking.unconfirmed === 'basic';
  await i.editReply({ embeds: [{ description: `${t(lang, 'iam.pending', { player: p.name, world })}\n\n${t(lang, basic ? 'iam.basic' : 'iam.full')}${ch ? '' : `\n\n${t(lang, 'iam.noChannel')}`}`, color: 0xfee75c }] });
}

/** Approve / Reject buttons in the admin channel: bot admins (or Manage Server) only, checked on every click. */
export async function handleIamButton(ctx: Ctx, i: ButtonInteraction) {
  if (!i.guildId) return;
  const lang: Lang = ctx.store.getGuild(i.guildId, config.defaultLang).lang;
  const [, verb, userId] = i.customId.split(':');
  const allowed = isBotAdmin(i.guildId, i.user.id) || !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!allowed) return void (await i.reply({ embeds: [{ description: t(lang, 'iam.notAdmin'), color: 0xed4245 }], flags: MessageFlags.Ephemeral }));
  const c = ctx.store.getClaim(i.guildId, userId);
  if (!c || c.status !== 'pending') return void (await i.update({ components: [], embeds: [{ ...(i.message.embeds[0]?.toJSON() ?? {}), footer: { text: t(lang, 'iam.handled') } }] }));
  const now = Date.now();
  let note: string;
  if (verb === 'ok') {
    const r = confirmLink(ctx.store, i.guildId, userId, c.world, c.playerId, i.user.id, now);
    if (!r.ok) return void (await i.reply({ embeds: [{ description: t(lang, 'iam.takenNow'), color: 0xed4245 }], flags: MessageFlags.Ephemeral }));
    const guild = await resolveGuild(i);
    if (guild) await syncGuildRoles(ctx, guild, [userId]).catch(() => undefined);
    note = t(lang, 'iam.approvedBy', { user: displayName(i) });
  } else {
    ctx.store.decideClaim(i.guildId, userId, 'rejected', i.user.id, now);
    note = t(lang, 'iam.rejectedBy', { user: displayName(i) });
  }
  ctx.store.audit(i.guildId, i.user.id, displayName(i), verb === 'ok' ? 'claims.approve' : 'claims.reject', `userId=${userId} (button)`, now);
  await i.update({ components: [], embeds: [{ ...(i.message.embeds[0]?.toJSON() ?? {}), footer: { text: note } }] });
}

export async function handleActivity(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang, world: string) {
  const snap = await ctx.worlds.ensure(world);
  const q = i.options.getString('player', true);
  const p = resolvePlayer(snap, q);
  if (!p) return void (await i.reply({ embeds: [{ description: t(lang, 'err.notFound', { q, world }), color: 0xed4245 }], flags: MessageFlags.Ephemeral }));
  const hours = ctx.store.playerHours(world, p.id);
  const total = hours.reduce((a, b) => a + b, 0);
  const tz = i.guildId ? settingsOf(i.guildId).planner.timezone : 'UTC';
  if (!total) return void (await i.reply({ embeds: [{ title: t(lang, 'clock.title', { player: p.name }), description: t(lang, 'clock.none'), color: 0x5865f2 }] }));
  const { bar, peak } = clockBar(hours, tzOffsetMin(tz));
  const desc = ['```', bar, '0     6     12    18   23', '```', t(lang, 'clock.peak', { hours: peak.map((h) => `${String(h).padStart(2, '0')}:00`).join(', '), tz }), `-# ${t(lang, 'clock.how', { n: total })}`].join('\n');
  await i.reply({ embeds: [{ title: t(lang, 'clock.title', { player: p.name }), description: desc, color: 0x5865f2 }] });
}

export async function handleAdminCmd(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang) {
  if (!i.guildId) throw new UserError('err.guildOnly');
  if (!isBotAdmin(i.guildId, i.user.id)) return void (await i.reply({ embeds: [{ description: t(lang, config.ownerUserIds.length ? 'admin.notAdmin' : 'admin.noOwner'), color: 0xed4245 }], flags: MessageFlags.Ephemeral }));
  const link = config.webEnabled ? dashboardLink(webSecret(ctx.store), i.guildId, i.user.id, displayName(i), 'admin', LINK_HOURS) : null;
  if (!link) return void (await i.reply({ embeds: [{ description: t(lang, 'web.notConfigured'), color: 0xfee75c }], flags: MessageFlags.Ephemeral }));
  await i.reply({ embeds: [{ title: t(lang, 'admin.title'), description: t(lang, 'web.body.personal', { hours: LINK_HOURS }), color: 0x5865f2 }],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(lang, 'admin.open')).setURL(link).setEmoji('🛠️'))], flags: MessageFlags.Ephemeral });
}

/** Live summary for the /live reply + its Refresh button (same shared cache: no extra GrepoData calls). */
export async function liveSummary(ctx: Ctx, guildId: string, lang: Lang) {
  const hub = runtime.hub;
  if (!hub) return null;
  const v = await hub.view(guildId, lang, true);
  return liveBoardPayload(v, lang, Math.floor(Date.now() / 1000), null).embeds?.[0] as Record<string, unknown> | undefined ?? null;
}
export const refreshButton = (lang: Lang) => new ButtonBuilder().setCustomId(LIVE_REFRESH).setStyle(ButtonStyle.Secondary).setLabel(t(lang, 'live.refresh')).setEmoji('🔄');

export async function handleLiveRefresh(ctx: Ctx, i: ButtonInteraction) {
  if (!i.guildId) return;
  const lang: Lang = ctx.store.getGuild(i.guildId, config.defaultLang).lang;
  const hub = runtime.hub;
  if (!hub) return void (await i.reply({ embeds: [{ description: t(lang, 'web.notConfigured'), color: 0xfee75c }], flags: MessageFlags.Ephemeral }));
  const r = hub.refreshNow(i.guildId);
  if (!r.ok) return void (await i.reply({ embeds: [{ description: t(lang, 'web.refreshWait', { s: Math.ceil(r.waitMs / 1000) }), color: 0xfee75c }], flags: MessageFlags.Ephemeral }));
  await i.deferUpdate();
  await new Promise((res) => setTimeout(res, 2500)); // let the poll finish
  const e = await liveSummary(ctx, i.guildId, lang);
  if (!e) return;
  const old = i.message.embeds.map((x) => x.toJSON());
  await i.editReply({ embeds: [...old.filter((x) => x.title !== e.title).slice(0, 1), e] }).catch(() => undefined);
}
