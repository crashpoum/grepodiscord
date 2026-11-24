/**
 * Discord side effects for batch 1: war-room boards (Components V2, edited in place), personal threat DMs,
 * op send-time DMs and the 60-second reminders. Everything is driven by public world data; nothing here
 * talks to the game.
 */
import { MessageFlags, type ButtonInteraction, type Client } from 'discord.js';
import { config } from '../config.js';
import type { Board, Op, OpMember } from '../db.js';
import { log } from '../log.js';
import { fmtDuration, worldClock, UNIT_EN } from '../planner.js';
import type { RefreshEvents } from '../refresh.js';
import type { Ctx } from '../services.js';
import { findThreats, threatMessage } from '../threats.js';
import { t, type Lang } from '../i18n.js';
import { worldTz } from '../time.js';
import { buildBoard, nextBaselines, renderBoard, resolveSides } from '../war.js';
import type { WorldSnapshot } from '../data/snapshot.js';
import { getWorldInfo, peekWorldInfo } from '../data/worldInfo.js';
import { boardExtras } from './insights.js';

const now = () => Math.floor(Date.now() / 1000);
const langOf = (ctx: Ctx, guildId: string): Lang => ctx.store.getGuild(guildId, config.defaultLang).lang;

/** War sides of a guild on a world (explicit config, else automatic). */
export function sidesFor(ctx: Ctx, guildId: string, snap: WorldSnapshot, at = now()) {
  const linked = ctx.store.linksForGuild(guildId).filter((l) => l.world === snap.world).map((l) => l.playerId);
  return resolveSides(snap, ctx.store.getWarSides(guildId, snap.world), linked, at);
}

export async function boardComponents(ctx: Ctx, board: Board) {
  const snap = await ctx.worlds.ensure(board.world);
  const at = now();
  const model = buildBoard(snap, sidesFor(ctx, board.guildId, snap, at), ctx.store.getBaselines(board.world, 'p'), at);
  const lang = langOf(ctx, board.guildId);
  return renderBoard(model, snap, lang, board.id, boardExtras(ctx, board.guildId, snap, lang, at));
}

/** Edit the board message in place; repost if it was deleted. Returns false if the channel is unusable. */
export async function updateBoard(client: Client, ctx: Ctx, board: Board): Promise<boolean> {
  try {
    const ch = await client.channels.fetch(board.channelId).catch(() => null);
    if (!ch || !ch.isSendable() || !('messages' in ch)) { ctx.store.setBoardMessage(board.id, null, 'channel not sendable'); return false; }
    const components = (await boardComponents(ctx, board)) as never;
    if (board.messageId) {
      try {
        await ch.messages.edit(board.messageId, { components });
        ctx.store.setBoardMessage(board.id, null, null);
        return true;
      } catch (e) {
        if ((e as { code?: number }).code !== 10008) throw e; // 10008 Unknown Message: deleted → repost
      }
    }
    const m = await ch.send({ flags: MessageFlags.IsComponentsV2, components });
    ctx.store.setBoardMessage(board.id, m.id, null);
    return true;
  } catch (e) {
    log.warn(`board #${board.id} update failed: ${e}`);
    ctx.store.setBoardMessage(board.id, null, String(e).slice(0, 200));
    return false;
  }
}

export async function updateBoardsForWorld(client: Client, ctx: Ctx, world: string) {
  for (const b of ctx.store.boardsForWorld(world)) await updateBoard(client, ctx, b);
}

/** Roll the 24h "top movers" baseline for a world when it is missing or a day old. */
export function rollBaselines(ctx: Ctx, snap: WorldSnapshot, at = now()) {
  const rows = nextBaselines(snap, ctx.store.getBaselines(snap.world, 'p'), at);
  if (rows) ctx.store.replaceBaselines(snap.world, 'p', rows);
}

/** After a refresh: DM every opted-in member whose towns are threatened. */
export async function sendThreatAlerts(client: Client, ctx: Ctx, ev: RefreshEvents) {
  if (ev.firstLoad) return;
  if (!ev.conquests.length && !ev.founded.length && !ev.bp.length) return;
  for (const sub of ctx.store.allThreatSubs()) {
    const link = ctx.store.getLink(sub.guildId, sub.userId);
    if (!link || link.world !== ev.world) continue;
    try {
      const sides = sidesFor(ctx, sub.guildId, ev.snapshot);
      const items = findThreats({ playerId: link.playerId, radius: sub.radius, minBp: sub.minBp, scope: sub.scope }, ev.snapshot, ev, sides.ours, sides.enemies);
      if (!items.length) continue;
      const guild = await client.guilds.fetch(sub.guildId).catch(() => null);
      const user = await client.users.fetch(sub.userId).catch(() => null);
      if (!user) continue;
      await user.send(threatMessage(items, ev.snapshot, langOf(ctx, sub.guildId), guild?.name ?? ''));
      ctx.store.markThreatAlert(sub.guildId, sub.userId, now());
    } catch (e) {
      log.warn(`threat alert ${sub.guildId}/${sub.userId}: ${e}`);
    }
  }
}

// ---------------------------------------------------------------- ops
export function unitName(unit: string, lang: Lang, world: string): string {
  const local = peekWorldInfo(world)?.units.get(unit)?.name;
  return lang === 'en' ? UNIT_EN[unit] ?? local ?? unit : local ?? UNIT_EN[unit] ?? unit;
}

export function opDm(ctx: Ctx, op: Op, m: OpMember, snap: WorldSnapshot | undefined, lang: Lang): string {
  const tz = worldTz(op.world);
  const target = snap?.towns.get(op.targetTownId);
  const owner = target?.playerId != null ? snap?.players.get(target.playerId)?.name ?? '-' : t(lang, 'feed.conquest.ghost');
  const est = m.estimated ? t(lang, 'op.estimate', { pm: fmtDuration(m.uncertainty) }) : t(lang, 'op.exact');
  const via = m.mods.transport && m.estimated ? t(lang, 'op.via', { transport: unitName(m.mods.transport, lang, op.world) }) : '';
  return [
    `**${t(lang, 'op.dm.title', { id: op.id, name: op.name ? ` · ${op.name}` : '', world: op.world })}**`,
    t(lang, 'op.dm.body', {
      target: target?.name ?? `#${op.targetTownId}`, owner, land: `<t:${op.landAt}:F>`, town: snap?.towns.get(m.originTownId)?.name ?? `#${m.originTownId}`,
      unit: unitName(m.unit, lang, op.world), via, travel: fmtDuration(m.travelSecs), est, send: `<t:${m.sendAt}:T>`, rel: `<t:${m.sendAt}:R>`, clock: worldClock(m.sendAt, tz),
    }),
    m.sendAt <= now() ? t(lang, 'op.tooLate') : '',
    `-# ${t(lang, 'op.dm.footer')}`,
  ].filter(Boolean).join('\n').slice(0, 2000);
}

/** DM a member their send time. Returns false if their DMs are closed. */
export async function notifyOpMember(client: Client, ctx: Ctx, op: Op, m: OpMember): Promise<boolean> {
  try {
    const user = await client.users.fetch(m.userId);
    await getWorldInfo(op.world, ctx.store).catch(() => undefined); // unit names
    await user.send(opDm(ctx, op, m, ctx.worlds.get(op.world), langOf(ctx, op.guildId)));
    ctx.store.markOpMember(op.id, m.userId, m.originTownId, 'notified');
    return true;
  } catch (e) {
    log.warn(`op #${op.id} DM to ${m.userId} failed: ${e}`);
    return false;
  }
}

/** Every ~15 s: 60-second "send now" reminders; close ops whose landing time is more than an hour past. */
export async function runOpReminders(client: Client, ctx: Ctx, at = now()) {
  for (const m of ctx.store.dueReminders(at, 60)) {
    ctx.store.markOpMember(m.opId, m.userId, m.originTownId, 'reminded'); // mark first: never double-remind
    const op = ctx.store.getOp(m.guildId, m.opId);
    if (!op) continue;
    const lang = langOf(ctx, op.guildId);
    const snap = ctx.worlds.get(op.world);
    try {
      const user = await client.users.fetch(m.userId);
      await user.send(t(lang, 'op.dm.reminder', {
        id: op.id, unit: unitName(m.unit, lang, op.world), town: snap?.towns.get(m.originTownId)?.name ?? `#${m.originTownId}`,
        target: snap?.towns.get(op.targetTownId)?.name ?? `#${op.targetTownId}`, send: `<t:${m.sendAt}:T>`, clock: worldClock(m.sendAt, worldTz(op.world)),
      }));
    } catch (e) { log.warn(`op #${op.id} reminder to ${m.userId} failed: ${e}`); }
  }
  for (const op of ctx.store.staleOps(at - 3600)) ctx.store.setOpStatus(op.id, 'done');
}

// ---------------------------------------------------------------- buttons
const lastManual = new Map<number, number>();
export async function handleButton(ctx: Ctx, i: ButtonInteraction) {
  const m = /^warroom:refresh:(\d+)$/.exec(i.customId);
  if (!m || !i.guildId) return;
  const lang = langOf(ctx, i.guildId);
  const board = ctx.store.getBoard(i.guildId, Number(m[1]));
  if (!board) return void (await i.reply({ content: t(lang, 'war.notFound', { id: m[1] }), flags: MessageFlags.Ephemeral }).catch(() => undefined));
  const last = lastManual.get(board.id) ?? 0;
  if (Date.now() - last < 60_000) return void (await i.reply({ content: t(lang, 'war.cooldown'), flags: MessageFlags.Ephemeral }).catch(() => undefined));
  lastManual.set(board.id, Date.now());
  try {
    await i.deferUpdate();
    await i.editReply({ components: (await boardComponents(ctx, board)) as never });
    ctx.store.setBoardMessage(board.id, i.message.id, null);
  } catch (e) {
    log.warn(`board #${board.id} button refresh failed: ${e}`);
  }
}
