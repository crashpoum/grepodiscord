/** /live and /map: open the Discord Activity (separate app, via its Custom Link) or a personal dashboard link. */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type APIEmbed, type ButtonInteraction, type ChatInputCommandInteraction } from 'discord.js';
import { config } from '../config.js';
import { UserError } from '../gdServices.js';
import { t, type Lang } from '../i18n.js';
import type { Ctx } from '../services.js';
import { LINK_HOURS, webSecret } from '../web/auth.js';
import { dashboardLink } from '../web/server.js';
import { activityState, refreshIfStale } from '../web/activityCheck.js';
import { liveSummary, refreshButton } from './iamHandlers.js';

export type WebTab = 'live' | 'map';

/**
 * Link that opens the Activity, with `custom_id` so the app opens the right tab: ACTIVITY_LINK (a Custom Link from the
 * portal) or, by default, https://discord.com/activities/<ACTIVITY_CLIENT_ID>. Null when not configured / invalid.
 */
export function activityUrl(tab: WebTab, link = config.activityLink || (config.activityClientId ? `https://discord.com/activities/${config.activityClientId}` : '')): string | null {
  if (!link) return null;
  try {
    const u = new URL(link);
    if (u.protocol !== 'https:' || !/(^|\.)discord\.com$/.test(u.hostname)) return null;
    u.searchParams.set('custom_id', tab);
    return u.toString();
  } catch { return null; }
}

/** share:true always posts publicly (never a personal link); otherwise a private reply. */
export function launchPlan(tab: WebTab, share: boolean, have: { activity: string | null; browser: string | null }) {
  if (!have.activity && !have.browser) return { kind: 'none' as const };
  if (share) return { kind: 'shared' as const };
  return { kind: 'private' as const };
}

export const OPEN_PREFIX = 'web:open:';
const personalLink = (ctx: Ctx, guildId: string, userId: string, name: string, tab: WebTab) =>
  (config.webEnabled ? dashboardLink(webSecret(ctx.store), guildId, userId, name, tab, LINK_HOURS) : null);
const displayName = (i: ChatInputCommandInteraction | ButtonInteraction) =>
  (i.member && 'displayName' in i.member ? String(i.member.displayName) : i.user.globalName ?? i.user.username);
const browserButton = (lang: Lang, url: string) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(lang, 'web.btn.browser')).setURL(url).setEmoji('🌐');

export async function handleLiveMap(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang, world: string) {
  if (!i.guildId) throw new UserError('err.guildOnly');
  const tab: WebTab = i.commandName === 'map' ? 'map' : 'live';
  const share = i.options.getBoolean('share') ?? false;
  // Hidden while Discord reports that Activities are not enabled on the app (the link would silently do nothing).
  if (activityState() !== 'enabled') refreshIfStale();
  const activity = activityState() === 'disabled' ? null : activityUrl(tab);
  const browser = personalLink(ctx, i.guildId, i.user.id, displayName(i), tab);
  const plan = launchPlan(tab, share, { activity, browser });
  if (plan.kind === 'none') return void (await i.reply({ embeds: [{ description: t(lang, 'web.notConfigured'), color: 0xfee75c }], flags: MessageFlags.Ephemeral }));

  const title = t(lang, tab === 'map' ? 'web.map.title' : 'web.live.title', { world });
  const what = t(lang, tab === 'map' ? 'web.what.map' : 'web.what.live');
  if (plan.kind === 'shared') {
    // Public post: the Activity link (Discord shows a Play card) and/or a button that sends EACH clicker their own
    // private signed link. A personal link is never posted publicly.
    const row = new ActionRowBuilder<ButtonBuilder>();
    if (activity) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(lang, 'web.btn.activity')).setURL(activity).setEmoji('🎮'));
    if (browser) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setCustomId(`${OPEN_PREFIX}${tab}`).setLabel(t(lang, 'web.btn.browser')).setEmoji('🌐'));
    const head = t(lang, activity ? 'web.shared' : 'web.sharedBrowser', { user: `<@${i.user.id}>`, what });
    await i.reply({ content: `**${title}**\n${head}${activity ? `\n${activity}\n-# ${t(lang, 'web.body.launcher')}` : ''}`, components: [row], allowedMentions: { parse: [] } });
    return;
  }
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (activity) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(lang, 'web.btn.activity')).setURL(activity).setEmoji('🎮'));
  if (browser) row.addComponents(browserButton(lang, browser));
  const body = [
    activity && browser ? t(lang, 'web.body.both') : activity ? t(lang, 'web.body.activity') : t(lang, 'web.body.browser'),
    browser ? t(lang, 'web.body.personal', { hours: LINK_HOURS }) : '',
    activity ? t(lang, 'web.body.launcher') : '',
    activity && browser ? t(lang, 'web.body.limit') : '',
  ].filter(Boolean);
  const embed: APIEmbed = { title, description: body.join('\n\n'), color: 0x5865f2 };
  // /live: a live summary from the shared cache plus a Refresh now button (10 s cooldown per server).
  const summary = tab === 'live' ? await liveSummary(ctx, i.guildId, lang).catch(() => null) : null;
  if (summary) row.addComponents(refreshButton(lang));
  await i.reply({ embeds: summary ? [embed, summary as APIEmbed] : [embed], components: [row], flags: MessageFlags.Ephemeral });
}

/** "Open in browser" on a shared post: a private, personal link for whoever clicked. */
export async function handleWebButton(ctx: Ctx, i: ButtonInteraction) {
  const lang: Lang = i.guildId ? ctx.store.getGuild(i.guildId, config.defaultLang).lang : config.defaultLang;
  const tab: WebTab = i.customId.endsWith(':map') ? 'map' : 'live';
  const world = i.guildId ? ctx.store.getGuild(i.guildId).world : null;
  const link = i.guildId ? personalLink(ctx, i.guildId, i.user.id, displayName(i), tab) : null;
  if (!world || !link) return void (await i.reply({ embeds: [{ description: t(lang, world ? 'web.notConfigured' : 'err.noWorld'), color: 0xfee75c }], flags: MessageFlags.Ephemeral }));
  await i.reply({
    embeds: [{ title: t(lang, tab === 'map' ? 'web.map.title' : 'web.live.title', { world }), description: t(lang, 'web.body.personal', { hours: LINK_HOURS }), color: 0x5865f2 }],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(browserButton(lang, link))], flags: MessageFlags.Ephemeral,
  });
}
