/**
 * Alerts channel: when a member's sync client reports new incoming attacks (already visible to them in the game),
 * post them once to the channel picked in the admin panel, with an optional role ping and minimum size.
 * Deduped by player + command id (survives restarts). At most one message per POST (up to 10 lines).
 */
import { config } from '../config.js';
import { runtime } from '../bridge.js';
import { t, type Lang } from '../i18n.js';
import type { Ctx } from '../services.js';
import type { AdminService } from '../admin/service.js';
import { unitName } from './warPoster.js';
import { newAlerts, unitTotal, type IncomingCmd, type IncomingType } from '../web/syncFeeds.js';

const ICON: Record<IncomingType, string> = { attack: '⚔️', conquest: '🏳️', revolt: '🔥', spy: '🕵️', support: '🛡️', other: '❔' };
const MAX_LINES = 10;

export function predText(c: IncomingCmd, lang: Lang, world = ''): string {
  const p = c.pred;
  if (!p) return '';
  const name = (u: string) => (world ? unitName(u, lang, world) : u.replace(/_/g, ' '));
  const units = p.groups?.length
    ? p.groups.slice(0, 3).map((g) => `${g.units.map(name).join('+')} ${g.pct}%`).join(' / ')
    : typeof p.units === 'string' ? p.units : Array.isArray(p.units) ? `${p.units.map(name).join('+')}${p.conf != null ? ` ${Math.round(p.conf * 100)}%` : ''}`
      : p.units ? Object.entries(p.units).map(([k, n]) => `${n} ${name(k)}`).join(', ') : '';
  const kind = p.kind ? t(lang, `alert.kind.${p.kind}` as never) || p.kind : '';
  const parts = [kind, units || (p.conf != null ? `${Math.round(p.conf * 100)}%` : ''), p.note].filter(Boolean);
  return parts.length ? t(lang, 'alert.pred', { text: parts.join(' · ') }) : '';
}

export function alertLine(c: IncomingCmd, victim: string, lang: Lang, world = ''): string {
  const from = [c.from_player, c.from_alliance ? `[${c.from_alliance}]` : ''].filter(Boolean).join(' ') || t(lang, 'alert.unknown');
  const src = c.from_town_n ? ` (${c.from_town_n})` : '';
  const pred = predText(c, lang, world);
  return `${ICON[c.type]} **${t(lang, `alert.type.${c.type}`)}** → **${c.town_n}** (${victim}) · ${t(lang, 'alert.from')} ${from}${src} · <t:${c.arrival}:T> (<t:${c.arrival}:R>)${pred ? `\n-# ${pred}` : ''}`;
}

export async function dispatchIncomingAlerts(ctx: Ctx, admin: AdminService, e: { guildId: string; world: string; userId: string; playerId: number; playerName: string; cmds: IncomingCmd[] }, now: () => number = Date.now) {
  const s = admin.settings(e.guildId);
  const ch = s.alerts.channelId;
  const bridge = runtime.bridge;
  if (!ch || !bridge) return;
  const key = (c: IncomingCmd) => `${e.playerId}:${c.id}`;
  const already = ctx.store.alertedIds(e.guildId, e.cmds.map(key));
  const todo = newAlerts(e.cmds, new Set([...already].map((k) => k.slice(k.indexOf(':') + 1))), Math.floor(now() / 1000), { minSize: s.alerts.minSize, types: s.alerts.types });
  if (!todo.length) return;
  const fresh = ctx.store.claimAlerts(e.guildId, todo.map(key), now());
  const list = todo.filter((c) => fresh.has(key(c)));
  if (!list.length) return;
  const lang: Lang = ctx.store.getGuild(e.guildId, config.defaultLang).lang;
  const lines = list.slice(0, MAX_LINES).map((c) => alertLine(c, e.playerName, lang, e.world));
  if (list.length > MAX_LINES) lines.push(t(lang, 'alert.more', { n: list.length - MAX_LINES }));
  const role = s.alerts.roleId;
  const big = list.reduce((m, c) => Math.max(m, unitTotal(c.pred?.units) ?? 0), 0);
  await bridge.post(ch, {
    content: role ? `<@&${role}>` : undefined,
    embeds: [{ title: t(lang, 'alert.title', { player: e.playerName, n: list.length }), description: lines.join('\n'), color: list.some((c) => c.type === 'conquest' || c.type === 'revolt') ? 0xed4245 : 0xfaa61a,
      footer: { text: `${t(lang, 'alert.footer')}${big ? ` · ${t(lang, 'alert.biggest', { n: big })}` : ''}` } }],
    allowedMentions: role ? { roles: [role] } : { parse: [] },
  });
}
