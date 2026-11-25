/** /sync link|unlink: issue or revoke a private per-user key for an external data-sync client. */
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { config } from '../config.js';
import { UserError } from '../gdServices.js';
import { t, type Lang } from '../i18n.js';
import type { Ctx } from '../services.js';
import { GgService } from '../web/ggTroops.js';

const COLOR = 0x5865f2;

export async function handleSync(ctx: Ctx, i: ChatInputCommandInteraction, lang: Lang) {
  if (!i.guildId) throw new UserError('err.guildOnly');
  const sub = i.options.getSubcommand();
  const gg = new GgService(ctx.store);
  const world = ctx.store.getGuild(i.guildId).world;
  if (sub === 'unlink') {
    const r = gg.unlink(i.guildId, i.user.id);
    const desc = r.hadKey || r.removed
      ? t(lang, 'gg.unlinked')
      : t(lang, 'gg.notLinked');
    return void (await i.reply({ embeds: [{ description: desc, color: COLOR }], flags: MessageFlags.Ephemeral }));
  }
  if (!world) throw new UserError('err.noWorld');
  const link = ctx.store.getLink(i.guildId, i.user.id);
  const playerId = link && link.world === world ? link.playerId : null;
  const { key, rotated } = gg.issue(i.guildId, i.user.id, playerId);
  const endpoint = config.publicUrl ? `${config.publicUrl}/api/gg/troops` : t(lang, 'gg.noPublicUrl');
  const tied = playerId !== null ? t(lang, 'gg.tiedPlayer', { world, id: playerId }) : t(lang, 'gg.tiedGuild', { world });
  const desc = [
    t(lang, rotated ? 'gg.rotated' : 'gg.issued'),
    t(lang, 'gg.keyLine', { key }),
    t(lang, 'gg.endpoint', { url: endpoint }),
    tied,
    t(lang, 'gg.warn'),
  ].join('\n\n');
  await i.reply({ embeds: [{ title: t(lang, 'gg.title'), description: desc, color: COLOR }], flags: MessageFlags.Ephemeral });
}
