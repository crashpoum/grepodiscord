/** Side effects in Discord: posting feed messages, syncing roles, finishing verifications. */
import type { Client, Guild } from 'discord.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { batchEmbeds, planFeedPosts } from '../feedPlan.js';
import type { RefreshEvents } from '../refresh.js';
import { roleChanges } from '../roles.js';
import { checkVerification, type Ctx } from '../services.js';
import { t } from '../i18n.js';

export async function postFeedEvents(client: Client, ctx: Ctx, ev: RefreshEvents) {
  if (ev.firstLoad) return; // baseline only; never spam history on first load
  const posts = planFeedPosts(ctx.store.feedsForWorld(ev.world), ev, (g) => ctx.store.getGuild(g, config.defaultLang).lang);
  for (const p of posts) {
    try {
      const ch = await client.channels.fetch(p.channelId);
      if (!ch || !ch.isSendable()) { log.warn(`feed #${p.feedId}: channel ${p.channelId} not sendable`); continue; }
      for (const batch of batchEmbeds(p.embeds)) await ch.send({ embeds: batch });
    } catch (e) {
      log.warn(`feed #${p.feedId} post failed: ${e}`);
    }
  }
}

/** Cached guild, or fetched by id when the cache missed (Guilds intent only can leave i.guild null). */
export async function resolveGuild(i: { guild: Guild | null; guildId: string | null; client: { guilds: { fetch: (id: string) => Promise<Guild> } } }): Promise<Guild | null> {
  if (i.guild) return i.guild;
  return i.guildId ? i.client.guilds.fetch(i.guildId).catch(() => null) : null;
}

/**
 * Sync managed roles for linked members of a guild (all, or only `userIds`).
 * Only roles configured via /roles are ever added/removed.
 */
export async function syncGuildRoles(ctx: Ctx, guild: Guild, userIds?: string[]): Promise<{ changed: number; errors: number }> {
  const g = ctx.store.getGuild(guild.id);
  const cfg = { verifiedRoleId: g.verifiedRoleId, allianceRoles: ctx.store.getAllianceRoles(guild.id) };
  if (!cfg.verifiedRoleId && cfg.allianceRoles.size === 0) return { changed: 0, errors: 0 };
  let changed = 0;
  let errors = 0;
  const links = ctx.store.linksForGuild(guild.id);
  const targets = userIds ? userIds : links.map((l) => l.userId);
  for (const userId of targets) {
    const link = links.find((l) => l.userId === userId) ?? null;
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      let player = null;
      if (link) {
        const snap = await ctx.worlds.ensure(link.world);
        player = snap.players.get(link.playerId) ?? null;
      }
      const { add, remove } = roleChanges(cfg, member.roles.cache.keys(), player);
      if (add.length) await member.roles.add(add, 'GrepoCord alliance sync');
      if (remove.length) await member.roles.remove(remove, 'GrepoCord alliance sync');
      if (add.length || remove.length) changed++;
    } catch (e) {
      errors++;
      log.warn(`role sync ${guild.id}/${userId}: ${e}`);
    }
  }
  return { changed, errors };
}

/** After a refresh: try to complete pending verifications for that world. */
export async function processPendingVerifications(client: Client, ctx: Ctx, world: string) {
  for (const p of ctx.store.allPending().filter((x) => x.world === world)) {
    try {
      const r = await checkVerification(ctx, p);
      if (r.status !== 'ok') continue;
      const guild = await client.guilds.fetch(p.guildId).catch(() => null);
      if (!guild) continue;
      await syncGuildRoles(ctx, guild, [p.userId]);
      const lang = ctx.store.getGuild(p.guildId, config.defaultLang).lang;
      const user = await client.users.fetch(p.userId).catch(() => null);
      await user?.send(t(lang, 'verify.dm', { player: r.player.name, guild: guild.name })).catch(() => undefined);
      log.info(`verified ${p.userId} as ${r.player.name} (${world}) in ${guild.id}`);
    } catch (e) {
      log.warn(`pending verification ${p.guildId}/${p.userId}: ${e}`);
    }
  }
}

/** Hourly role sync for every guild whose links are on this world. */
export async function syncRolesForWorld(client: Client, ctx: Ctx, world: string) {
  const guildIds = new Set(ctx.store.allGuilds().map((g) => g.guildId));
  for (const gid of guildIds) {
    if (!ctx.store.linksForGuild(gid).some((l) => l.world === world)) continue;
    const guild = await client.guilds.fetch(gid).catch(() => null);
    if (!guild) continue;
    const r = await syncGuildRoles(ctx, guild);
    if (r.changed || r.errors) log.info(`roles ${gid}: ${r.changed} changed, ${r.errors} errors`);
  }
}
