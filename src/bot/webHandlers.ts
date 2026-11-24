/** /live and /map: open the Discord Activity (separate app, via its Custom Link) or a personal dashboard link. */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type APIEmbed, type ChatInputCommandInteraction } from 'discord.js';
import { config } from '../config.js';
import { UserError } from '../gdServices.js';
import { t, type Lang } from '../i18n.js';
import type { Ctx } from '../services.js';
import { LINK_HOURS, webSecret } from '../web/auth.js';
import { dashboardLink } from '../web/server.js';

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

export function launchPlan(tab: WebTab, share: boolean, have: { activity: string | null; browser: string | null }) {
  if (!have.activity && !have.browser) return { kind: 'none' as const };
  if (share && have.activity) return { kind: 'shared' as const };
  return { kind: 'private' as const, note: share && !have.activity ? 'web.shareNoActivity' as const : null };
}

export async function handleLiveMap(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang, world: string) {
  if (!i.guildId) throw new UserError('err.guildOnly');
  const tab: WebTab = i.commandName === 'map' ? 'map' : 'live';
  const share = i.options.getBoolean('share') ?? false;
  const activity = activityUrl(tab);
  const name = i.member && 'displayName' in i.member ? String(i.member.displayName) : i.user.globalName ?? i.user.username;
  const browser = config.webEnabled ? dashboardLink(webSecret(ctx.store), i.guildId, i.user.id, name, tab, LINK_HOURS) : null;
  const plan = launchPlan(tab, share, { activity, browser });
  if (plan.kind === 'none') return void (await i.reply({ embeds: [{ description: t(lang, 'web.notConfigured'), color: 0xfee75c }], flags: MessageFlags.Ephemeral }));

  const buttons = (withActivity: boolean) => {
    const row = new ActionRowBuilder<ButtonBuilder>();
    if (withActivity && activity) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(lang, 'web.btn.activity')).setURL(activity).setEmoji('🎮'));
    if (browser) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(t(lang, 'web.btn.browser')).setURL(browser).setEmoji('🌐'));
    return row.components.length ? [row] : [];
  };
  const title = t(lang, tab === 'map' ? 'web.map.title' : 'web.live.title', { world });
  const body = [
    activity && browser ? t(lang, 'web.body.both') : activity ? t(lang, 'web.body.activity') : t(lang, 'web.body.browser'),
    browser ? t(lang, 'web.body.personal', { hours: LINK_HOURS }) : '',
    activity && browser ? t(lang, 'web.body.limit') : '',
  ].filter(Boolean);
  if (plan.kind === 'shared') {
    // Public: only the Activity link (Discord turns it into a "Play" card). The personal browser link stays private.
    await i.reply({ content: `${t(lang, 'web.shared', { user: `<@${i.user.id}>`, what: t(lang, tab === 'map' ? 'web.what.map' : 'web.what.live') })}\n${activity}`, allowedMentions: { parse: [] } });
    if (browser) await i.followUp({ embeds: [{ title, description: t(lang, 'web.body.personal', { hours: LINK_HOURS }), color: 0x5865f2 }], components: buttons(false), flags: MessageFlags.Ephemeral });
    return;
  }
  const embed: APIEmbed = { title, description: [plan.note ? t(lang, plan.note) : '', ...body].filter(Boolean).join('\n\n'), color: 0x5865f2 };
  await i.reply({ embeds: [embed], components: buttons(true), flags: MessageFlags.Ephemeral });
}
